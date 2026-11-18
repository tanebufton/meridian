'use strict';

require('dotenv').config({ quiet: true });
const pino = require('pino');
const { getDb, closeDb, requireSchema } = require('../db/db');
const { pingHost, ping6Host } = require('./icmp');
const { resolveHost } = require('./dns');
const { tcpProbe } = require('./tcp');
const { httpProbe } = require('./http');
const { recalcUptime } = require('./uptime');
const { rollup5Min, rollup1Hour, runRetention, backfillAggregates } = require('./rollup');
const { runBackup } = require('../shared/backup');
const { runTracerouteBackfill } = require('./traceroute-backfill');
const { getStatus } = require('../shared/constants');
const { probePercentiles } = require('../shared/stats');
const { loadSettings } = require('../shared/settings');
const maintenance = require('../shared/maintenance');
const incidents = require('./incidents');
const { fireStatusChange } = require('./notifier');

const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
});

// Limits the number of probe processes/sockets running at the same time.
// With 143 targets at 300s intervals and ~22s per probe, average concurrency
// is ~10. Cap at 15 to prevent thundering-herd spikes on startup/reload.
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  acquire() {
    if (this.count < this.max) { this.count++; return Promise.resolve(); }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    this.count--;
    if (this.queue.length > 0) { this.count++; this.queue.shift()(); }
  }
}

const probeSemaphore = new Semaphore(parseInt(process.env.PROBE_CONCURRENCY || '15', 10));

// Scheduler state, keyed by target id: { target, timer, interval, sig, running }
const activeProbes = new Map();
let isShuttingDown = false;
let inFlightCount = 0;

// ── Probe execution ─────────────────────────────────────────────────────────

const LATENCY_COLS = `(target_id, latency_min, latency_avg, latency_max, latency_mdev, latency_p50, latency_p95, packet_loss, rtts_json, resolved_ip, error)`;

async function execute(target) {
  switch (target.probe_type) {
    case 'icmp':  return { kind: 'latency', result: await pingHost(target.host, target.packet_count) };
    case 'icmp6': return { kind: 'latency', result: await ping6Host(target.host, target.packet_count) };
    case 'tcp':   return { kind: 'latency', result: await tcpProbe(target.host, target.packet_count) };
    case 'http':  return { kind: 'latency', result: await httpProbe(target.host) };
    case 'dns':   return { kind: 'dns', result: await resolveHost(target.host) };
    default:      throw new Error(`Unknown probe type: ${target.probe_type}`);
  }
}

async function runProbe(entry) {
  if (isShuttingDown || entry.running) return; // never stack probes for one target
  entry.running = true;
  await probeSemaphore.acquire();
  inFlightCount++;
  const target = entry.target;
  try {
    const db = getDb();
    const { kind, result } = await execute(target);

    if (kind === 'latency') {
      const { p50, p95 } = probePercentiles(result.rtts);
      db.prepare(`INSERT INTO probe_results ${LATENCY_COLS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        target.id, result.latency_min, result.latency_avg, result.latency_max, result.latency_mdev, p50, p95,
        result.packet_loss, JSON.stringify(result.rtts), result.resolved_ip ?? null, result.error,
      );
    } else {
      db.prepare(
        `INSERT INTO probe_results (target_id, dns_time, dns_success, resolved_ip, error) VALUES (?, ?, ?, ?, ?)`
      ).run(target.id, result.dns_time, result.dns_success, result.resolved_ip, result.error);
    }

    recalcUptime(target.id, target.probe_type);

    const now = Math.floor(Date.now() / 1000);
    const newStatus = getStatus(result.packet_loss ?? null, result.dns_success ?? null, target.probe_type, !!result.error);
    const inMaintenance = maintenance.activeFor(db, target, now) != null;

    const events = incidents.evaluate(db, target, newStatus, loadSettings(), { now, inMaintenance });
    for (const ev of events) {
      logger.info({ targetId: target.id, event: ev.kind, incidentId: ev.incidentId }, 'Incident event');
      fireStatusChange({
        kind: ev.kind,
        targetId: target.id,
        groupId: target.group_id,
        name: target.name,
        host: target.host,
        groupName: target.group_name,
        incidentId: ev.incidentId,
        durationSeconds: ev.durationSeconds,
        cause: ev.cause,
      }).catch((err) => logger.warn({ err, targetId: target.id }, 'Notification dispatch failed'));
    }

    logger.debug({ targetId: target.id, host: target.host }, 'Probe complete');
  } catch (err) {
    logger.error({ err, targetId: target.id }, 'Probe error');
  } finally {
    inFlightCount--;
    entry.running = false;
    probeSemaphore.release();
  }
}

// ── Scheduling ──────────────────────────────────────────────────────────────

function stopEntry(entry) {
  clearInterval(entry.interval);
  clearTimeout(entry.timer);
}

function startEntry(entry, delayMs) {
  const intervalMs = entry.target.interval_seconds * 1000;
  entry.timer = setTimeout(() => {
    runProbe(entry);
    entry.interval = setInterval(() => runProbe(entry), intervalMs);
  }, delayMs);
}

function loadAndScheduleTargets() {
  const db = getDb();
  const targets = db.prepare(
    `SELECT t.id, t.group_id, t.host, t.probe_type, t.interval_seconds, t.packet_count, t.name,
            g.name AS group_name
     FROM targets t
     JOIN groups g ON g.id = t.group_id
     WHERE t.enabled = 1`
  ).all();

  const currentIds = new Set(targets.map((t) => t.id));

  for (const [id, entry] of activeProbes.entries()) {
    if (!currentIds.has(id)) {
      stopEntry(entry);
      activeProbes.delete(id);
      logger.info({ targetId: id }, 'Target removed from scheduler');
    }
  }

  const closed = incidents.closeForDisabled(db, Math.floor(Date.now() / 1000));
  if (closed > 0) logger.info({ closed }, 'Closed incidents for disabled targets');

  const toStart = [];
  const brandNew = [];
  for (const t of targets) {
    const entry = activeProbes.get(t.id);
    if (!entry) { toStart.push(t); brandNew.push(t); continue; }

    const timingChanged = entry.target.interval_seconds !== t.interval_seconds;
    // Always adopt the latest definition (host, packet count, type, name, group) —
    // previously only an interval change was noticed, so other edits were ignored.
    // The running interval picks it up on its next tick.
    const changed = entry.target.host !== t.host || entry.target.probe_type !== t.probe_type
      || entry.target.packet_count !== t.packet_count;
    entry.target = t;
    if (timingChanged) {
      stopEntry(entry);
      activeProbes.delete(t.id);
      toStart.push(t);
    } else if (changed) {
      logger.info({ targetId: t.id, host: t.host }, 'Target definition changed');
    }
  }

  if (toStart.length === 0) return;

  // Spread first probes over (up to) a minute so a restart doesn't fire everything at
  // once. Each target is spread within its OWN interval — previously the shortest
  // interval of any target squeezed the whole fleet into that window.
  toStart.forEach((target, i) => {
    const spreadMs = Math.min(60_000, target.interval_seconds * 1000);
    const staggerMs = toStart.length > 1 ? Math.floor((spreadMs / toStart.length) * i) : 0;
    const entry = { target, timer: null, interval: null, running: false };
    activeProbes.set(target.id, entry);
    startEntry(entry, staggerMs);
    logger.info({ targetId: target.id, host: target.host, staggerMs }, 'Target scheduled');
  });

  if (brandNew.length > 0 && !startupPhase) {
    logger.info({ count: brandNew.length }, 'New targets detected — scheduling traceroute backfill');
    setTimeout(
      () => refreshStaleTraceroutes().catch((err) => logger.error({ err }, 'New-target traceroute failed')),
      90_000
    );
  }
}

let startupPhase = true;

function refreshStaleTraceroutes() {
  return runTracerouteBackfill({
    log: (msg) => logger.info(msg),
    shouldStop: () => isShuttingDown,
  }).then(({ processed, total }) => {
    if (total > 0) logger.info({ processed, total }, 'Traceroute backfill complete');
  });
}

// ── Background jobs ─────────────────────────────────────────────────────────

// Run `fn` every `ms`, never overlapping itself and never throwing out of the timer.
function every(ms, name, fn) {
  let running = false;
  setInterval(async () => {
    if (running || isShuttingDown) return;
    running = true;
    try { await fn(); } catch (err) { logger.error({ err }, `${name} failed`); }
    finally { running = false; }
  }, ms);
}

function startRollupJobs() {
  try { backfillAggregates(); logger.info('Aggregate catch-up complete'); }
  catch (err) { logger.error({ err }, 'Aggregate catch-up failed'); }

  every(5 * 60 * 1000, '5-min rollup', rollup5Min);
  // Suspected route changes are re-checked within ~15 minutes rather than waiting for tomorrow's run
  every(5 * 60 * 1000, 'route-change confirmation', () => refreshStaleTraceroutes());
  every(60 * 60 * 1000, '1-hour rollup', rollup1Hour);

  function scheduleNightly() {
    const now = new Date();
    const next = new Date();
    next.setHours(2, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    setTimeout(async () => {
      try { runRetention(loadSettings()); logger.info('Retention cleanup complete'); }
      catch (err) { logger.error({ err }, 'Retention cleanup failed'); }
      try {
        const b = runBackup({ keep: loadSettings().backup_keep });
        if (b) logger.info({ file: b.file, size: b.size, pruned: b.pruned }, 'Database backup complete');
      } catch (err) { logger.error({ err }, 'Database backup failed'); }

      await refreshStaleTraceroutes().catch((err) => logger.error({ err }, 'Nightly traceroute refresh failed'));
      scheduleNightly();
    }, next - now);
  }

  scheduleNightly();
  setTimeout(() => refreshStaleTraceroutes().catch((err) => logger.error({ err }, 'Startup traceroute refresh failed')), 30_000);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

async function shutdown() {
  logger.info('Probe worker shutting down...');
  isShuttingDown = true;

  for (const entry of activeProbes.values()) stopEntry(entry);

  const deadline = Date.now() + 30_000;
  while (inFlightCount > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  closeDb();
  logger.info('Probe worker stopped.');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('Meridian probe worker starting...');
requireSchema();
loadAndScheduleTargets();
startupPhase = false;
startRollupJobs();

// Pick up admin changes within seconds. SQLite's data_version changes whenever ANOTHER
// connection commits, so this is a free "did the admin write anything?" check. The
// 5-minute full reload stays as a safety net.
let lastDataVersion = getDb().pragma('data_version', { simple: true });
setInterval(() => {
  try {
    const v = getDb().pragma('data_version', { simple: true });
    if (v !== lastDataVersion) { lastDataVersion = v; maintenance.invalidate(); loadAndScheduleTargets(); }
  } catch (err) { logger.error({ err }, 'Change check failed'); }
}, 10_000);
setInterval(loadAndScheduleTargets, 5 * 60 * 1000);
