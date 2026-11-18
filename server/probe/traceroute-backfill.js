'use strict';

const { getDb } = require('../db/db');
const traceroute = require('./traceroute');
const asnLookup = require('./asn');
const { asPath, routeChanged } = require('./route');
const { probeHostname } = require('../shared/hosts');
const { loadSettings } = require('../shared/settings');

const CONCURRENCY = 4;
const PENDING_RECHECK_SECONDS = 15 * 60; // a suspected change is re-verified soon, not tomorrow

const defaultDeps = {
  runTraceroute: traceroute.runTraceroute,
  annotateHops: asnLookup.annotateHops,
  // origin AS of the destination address, to tell "host filters probes" from "path stopped short"
  lookupDest: async (db, ip) => (await asnLookup.lookupAsns(db, [ip])).get(ip)?.asn ?? null,
};

function ensureHistoryTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS traceroute_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id   INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      ran_at      INTEGER NOT NULL,
      as_path_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_traceroute_history_target_ran_at
      ON traceroute_history(target_id, ran_at DESC);
  `);
}

const parseJson = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };

/**
 * Run a traceroute for one target and decide what to record.
 *
 * The latest result always replaces the cache (so the UI is current), but a new row in the
 * route-change HISTORY is only written when the AS path genuinely changed AND the change is seen
 * again on a confirming run — a single odd run (a flaky hop, a brief reroute) leaves no trace.
 */
async function traceAndCache(target, log, deps = defaultDeps) {
  const db = getDb();
  const host = probeHostname(target);
  if (!host) return 0;
  if (log) log(`Traceroute: ${host}`);

  const settings = loadSettings();
  const useIPv6 = target.probe_type === 'icmp6' || host.includes(':');
  const result = await deps.runTraceroute(host, useIPv6, settings.traceroute_method || 'auto');
  const now = Math.floor(Date.now() / 1000);

  let hops = result.hops;
  try { hops = await deps.annotateHops(db, hops); }
  catch (err) { if (log) log(`ASN lookup failed (${err.message}) — using address-based comparison`); }

  const path = asPath(hops);
  // A trace is complete if it reached the host, OR got into the destination's own network: plenty of
  // hosts drop probes aimed at themselves, but the route to their network is still fully known.
  let complete = !!result.complete;
  if (!complete && result.destIp && path.length) {
    try {
      const destAsn = await (deps.lookupDest || defaultDeps.lookupDest)(db, result.destIp);
      if (destAsn != null && path[path.length - 1] === destAsn) complete = true;
    } catch { /* ASN lookup is best-effort */ }
  }
  const rec = { path, complete };
  const meta = JSON.stringify({ path, complete, method: result.method || null });

  const cache = db.prepare('SELECT pending_json, pending_count FROM traceroute_cache WHERE target_id = ?').get(target.id);
  let pendingJson = null;
  let pendingCount = 0;

  if (hops.length > 0) {
    const last = db.prepare('SELECT result_json, as_path_json FROM traceroute_history WHERE target_id = ? ORDER BY ran_at DESC LIMIT 1').get(target.id);
    const insertHistory = (h, p, c, at) => db.prepare(
      'INSERT INTO traceroute_history (target_id, result_json, ran_at, as_path_json) VALUES (?, ?, ?, ?)'
    ).run(target.id, JSON.stringify(h), at, JSON.stringify({ path: p, complete: c, method: result.method || null }));

    if (!last) {
      insertHistory(hops, path, complete, now);
    } else {
      const prevMeta = parseJson(last.as_path_json, {}) || {};
      const prev = { path: prevMeta.path || asPath(parseJson(last.result_json, [])), complete: !!prevMeta.complete, hops: parseJson(last.result_json, []) };
      if (routeChanged(prev, { ...rec, hops })) {
        const pend = parseJson(cache?.pending_json);
        const confirms = pend && JSON.stringify(pend.path) === JSON.stringify(path) ? (cache.pending_count || 1) + 1 : 1;
        if (confirms >= Math.max(1, settings.route_confirm_runs | 0)) {
          // Record the change at the time it was FIRST seen, with that run's hops
          insertHistory(pend && confirms > 1 ? pend.hops : hops, path, complete, pend && confirms > 1 ? pend.ran_at : now);
        } else {
          pendingJson = JSON.stringify({ path, hops, ran_at: now });
          pendingCount = confirms;
        }
      }
    }
  }

  db.prepare(
    `INSERT INTO traceroute_cache (target_id, result_json, ran_at, as_path_json, pending_json, pending_count, method, complete)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET result_json = excluded.result_json, ran_at = excluded.ran_at,
       as_path_json = excluded.as_path_json, pending_json = excluded.pending_json, pending_count = excluded.pending_count,
       method = excluded.method, complete = excluded.complete`
  ).run(target.id, JSON.stringify(hops), now, meta, pendingJson, pendingCount, result.method || null, complete ? 1 : 0);

  return hops.length;
}

/**
 * Run traceroute for all enabled targets that have no cached result, whose cache is older than
 * cutoffSeconds (default 24h), or that have a suspected route change waiting to be confirmed.
 */
async function runTracerouteBackfill({ log, shouldStop = () => false, cutoffSeconds = 86400, deps = defaultDeps } = {}) {
  const db = getDb();
  ensureHistoryTable(db);

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - cutoffSeconds;
  const emptyCutoff = now - 3600; // retry empty results after 1h
  const pendingCutoff = now - PENDING_RECHECK_SECONDS;

  let targets;
  try {
    targets = db.prepare(
      `SELECT t.id, t.host, t.probe_type FROM targets t
       LEFT JOIN traceroute_cache tc ON tc.target_id = t.id
       WHERE t.enabled = 1 AND (
         tc.ran_at IS NULL
         OR tc.ran_at < ?
         OR (tc.result_json = '[]' AND tc.ran_at < ?)
         OR (tc.pending_count > 0 AND tc.ran_at < ?)
       )
       ORDER BY tc.ran_at ASC NULLS FIRST`
    ).all(cutoff, emptyCutoff, pendingCutoff);
  } catch (err) {
    if (log) log(`traceroute_cache table missing: ${err.message}`);
    return { processed: 0, total: 0 };
  }

  if (targets.length === 0) return { processed: 0, total: 0 };
  if (log) log(`Backfill: ${targets.length} target(s) need traceroute`);

  let processed = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (shouldStop()) break;
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((t) => traceAndCache(t, log, deps)));
    processed += results.filter((r) => r.status === 'fulfilled').length;
    for (const r of results) if (r.status === 'rejected' && log) log(`Traceroute failed: ${r.reason?.message}`);
  }

  return { processed, total: targets.length };
}

module.exports = { runTracerouteBackfill, traceAndCache };
