'use strict';

require('dotenv').config();
const pino = require('pino');
const { getDb, closeDb } = require('../db/db');
const { pingHost, ping6Host } = require('./icmp');
const { resolveHost } = require('./dns');
const { recalcUptime } = require('./uptime');
const { rollup5Min, rollup1Hour, runRetention, backfillAggregates } = require('./rollup');
const { runTraceroute } = require('./traceroute');
const { runTracerouteBackfill } = require('./traceroute-backfill');
const { getStatus } = require('../shared/constants');
const { fireStatusChange } = require('./notifier');
const fs = require('fs');
const path = require('path');

const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
});

// Limits the number of ping processes running at the same time.
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

const probeSemaphore = new Semaphore(15);

// Active probe intervals, keyed by target id
const activeProbes = new Map();
let isShuttingDown = false;
let inFlightCount = 0;

function loadSettings() {
  const settingsFile = path.resolve(
    process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
    'settings.json'
  );
  const defaults = {
    retention_raw_days: parseInt(process.env.RETENTION_RAW_DAYS || '7', 10),
    retention_5min_days: parseInt(process.env.RETENTION_5MIN_DAYS || '30', 10),
    retention_1hour_days: parseInt(process.env.RETENTION_1HOUR_DAYS || '365', 10),
  };
  if (fs.existsSync(settingsFile)) {
    try { return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; }
    catch { return defaults; }
  }
  return defaults;
}

async function runProbe(target) {
  if (isShuttingDown) return;
  await probeSemaphore.acquire();
  inFlightCount++;
  try {
    const db = getDb();
    let result;

    // Snapshot previous status before this probe for change detection
    const prevRow = db.prepare(
      'SELECT packet_loss, dns_success, error FROM probe_results WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(target.id);
    const prevStatus = prevRow
      ? getStatus(prevRow.packet_loss ?? null, prevRow.dns_success ?? null, target.probe_type, !!prevRow.error)
      : null;

    if (target.probe_type === 'icmp' || target.probe_type === 'icmp6') {
      result = target.probe_type === 'icmp6'
        ? await ping6Host(target.host, target.packet_count)
        : await pingHost(target.host, target.packet_count);
      db.prepare(
        `INSERT INTO probe_results
           (target_id, latency_min, latency_avg, latency_max, latency_mdev, packet_loss, rtts_json, resolved_ip, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        target.id,
        result.latency_min,
        result.latency_avg,
        result.latency_max,
        result.latency_mdev,
        result.packet_loss,
        JSON.stringify(result.rtts),
        result.resolved_ip ?? null,
        result.error,
      );
    } else {
      result = await resolveHost(target.host);
      db.prepare(
        `INSERT INTO probe_results (target_id, dns_time, dns_success, resolved_ip, error)
         VALUES (?, ?, ?, ?, ?)`
      ).run(target.id, result.dns_time, result.dns_success, result.resolved_ip, result.error);
    }

    recalcUptime(target.id, target.probe_type);

    // Fire notification on DOWN or recovery to UP
    const newStatus = getStatus(
      result.packet_loss ?? null,
      result.dns_success ?? null,
      target.probe_type,
      !!result.error
    );
    // Notify on DOWN (any → DOWN) or recovery from DOWN only (DEGRADED→UP is silent)
    const shouldNotify = prevStatus !== null
      && prevStatus !== newStatus
      && newStatus !== 'UNKNOWN'
      && (newStatus === 'DOWN' || (newStatus === 'UP' && prevStatus === 'DOWN'));

    if (shouldNotify) {
      fireStatusChange({
        targetId: target.id,
        name: target.name,
        host: target.host,
        groupName: target.group_name,
        prevStatus,
        newStatus,
      }).catch((err) => logger.warn({ err, targetId: target.id }, 'Notification dispatch failed'));
    }

    logger.debug({ targetId: target.id, host: target.host }, 'Probe complete');
  } catch (err) {
    logger.error({ err, targetId: target.id }, 'Probe error');
  } finally {
    inFlightCount--;
    probeSemaphore.release();
  }
}

function scheduleTarget(target, delayMs = 0) {
  const existing = activeProbes.get(target.id);
  if (existing) {
    clearInterval(existing.interval);
    clearTimeout(existing.timer);
  }

  const intervalMs = (target.interval_seconds || 60) * 1000;

  const timer = setTimeout(() => {
    runProbe(target);
    const interval = setInterval(() => runProbe(target), intervalMs);
    activeProbes.set(target.id, { interval, target });
  }, delayMs);

  activeProbes.set(target.id, { timer, target });
}

function loadAndScheduleTargets() {
  const db = getDb();
  const targets = db.prepare(
    `SELECT t.id, t.host, t.probe_type, t.interval_seconds, t.packet_count, t.name,
            g.name AS group_name
     FROM targets t
     JOIN groups g ON g.id = t.group_id
     WHERE t.enabled = 1`
  ).all();

  const currentIds = new Set(targets.map((t) => t.id));

  for (const [id, entry] of activeProbes.entries()) {
    if (!currentIds.has(id)) {
      clearInterval(entry.interval);
      clearTimeout(entry.timer);
      activeProbes.delete(id);
      logger.info({ targetId: id }, 'Target removed from scheduler');
    }
  }

  const toSchedule = targets.filter((t) => {
    const existing = activeProbes.get(t.id);
    if (!existing) return true;
    return existing.target.interval_seconds !== t.interval_seconds;
  });

  const brandNew = toSchedule.filter((t) => !activeProbes.has(t.id));

  if (toSchedule.length === 0) return;

  const spreadMs = Math.min(
    60_000,
    Math.min(...toSchedule.map((t) => t.interval_seconds * 1000))
  );

  toSchedule.forEach((target, i) => {
    const staggerMs = toSchedule.length > 1
      ? Math.floor((spreadMs / toSchedule.length) * i)
      : 0;
    scheduleTarget(target, staggerMs);
    logger.info({ targetId: target.id, host: target.host, staggerMs }, 'Target scheduled');
  });

  if (brandNew.length > 0) {
    logger.info({ count: brandNew.length }, 'New targets detected — scheduling traceroute backfill');
    setTimeout(
      () => refreshStaleTraceroutes().catch((err) => logger.error({ err }, 'New-target traceroute failed')),
      90_000
    );
  }
}

function refreshStaleTraceroutes() {
  return runTracerouteBackfill({
    log: (msg) => logger.info(msg),
    shouldStop: () => isShuttingDown,
  }).then(({ processed, total }) => {
    if (total > 0) logger.info({ processed, total }, 'Traceroute backfill complete');
  });
}

function startRollupJobs() {
  try { backfillAggregates(); logger.info('Aggregate backfill complete'); }
  catch (err) { logger.error({ err }, 'Aggregate backfill failed'); }

  setInterval(() => {
    try { rollup5Min(); } catch (err) { logger.error({ err }, '5-min rollup failed'); }
  }, 5 * 60 * 1000);

  setInterval(() => {
    try { rollup1Hour(); } catch (err) { logger.error({ err }, '1-hour rollup failed'); }
  }, 60 * 60 * 1000);

  function scheduleNightly() {
    const now = new Date();
    const next = new Date();
    next.setHours(2, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    setTimeout(async () => {
      const settings = loadSettings();
      try { runRetention(settings); logger.info('Retention cleanup complete'); }
      catch (err) { logger.error({ err }, 'Retention cleanup failed'); }

      await refreshStaleTraceroutes().catch((err) => logger.error({ err }, 'Nightly traceroute refresh failed'));
      scheduleNightly();
    }, next - now);
  }

  scheduleNightly();
  setTimeout(() => refreshStaleTraceroutes().catch((err) => logger.error({ err }, 'Startup traceroute refresh failed')), 30_000);
}

async function shutdown() {
  logger.info('Probe worker shutting down...');
  isShuttingDown = true;

  for (const entry of activeProbes.values()) {
    clearInterval(entry.interval);
    clearTimeout(entry.timer);
  }

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
loadAndScheduleTargets();
startRollupJobs();

setInterval(loadAndScheduleTargets, 5 * 60 * 1000);
