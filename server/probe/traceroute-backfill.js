'use strict';

const { getDb } = require('../db/db');
const { runTraceroute } = require('./traceroute');

const CONCURRENCY = 4;

function ensureHistoryTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS traceroute_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id   INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      ran_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_traceroute_history_target_ran_at
      ON traceroute_history(target_id, ran_at DESC);
  `);
}

function pathFingerprint(hops) {
  return hops
    .filter((h) => h.ip && !h.hidden)
    .map((h) => `${h.hop}:${h.ip}`)
    .join(',');
}

function isDramaticChange(prevHops, newHops) {
  const fp1 = pathFingerprint(prevHops);
  const fp2 = pathFingerprint(newHops);
  if (fp1 === fp2) return false;

  const prevMap = Object.fromEntries(prevHops.filter((h) => h.ip && !h.hidden).map((h) => [h.hop, h.ip]));
  const nextMap = Object.fromEntries(newHops.filter((h) => h.ip && !h.hidden).map((h) => [h.hop, h.ip]));

  const allHops = new Set([...Object.keys(prevMap), ...Object.keys(nextMap)]);
  if (allHops.size === 0) return false;

  let matching = 0;
  for (const hop of allHops) {
    if (prevMap[hop] !== undefined && prevMap[hop] === nextMap[hop]) matching++;
  }

  return (allHops.size - matching) / allHops.size >= 0.3;
}

async function traceAndCache(target, log) {
  const db = getDb();
  if (log) log(`Traceroute: ${target.host}`);
  const result = await runTraceroute(target.host);
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO traceroute_cache (target_id, result_json, ran_at) VALUES (?, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET result_json = excluded.result_json, ran_at = excluded.ran_at`
  ).run(target.id, JSON.stringify(result.hops), now);

  if (result.hops.length > 0) {
    const last = db.prepare(
      'SELECT result_json FROM traceroute_history WHERE target_id = ? ORDER BY ran_at DESC LIMIT 1'
    ).get(target.id);

    const prevHops = last ? JSON.parse(last.result_json) : [];
    if (!last || isDramaticChange(prevHops, result.hops)) {
      db.prepare(
        'INSERT INTO traceroute_history (target_id, result_json, ran_at) VALUES (?, ?, ?)'
      ).run(target.id, JSON.stringify(result.hops), now);
    }
  }

  return result.hops.length;
}

/**
 * Run traceroute for all enabled targets that have no cached result
 * or whose cache is older than cutoffSeconds (default 24h).
 *
 * @param {object} opts
 * @param {function} [opts.log]      - optional logger(msg)
 * @param {function} [opts.shouldStop] - return true to abort early
 * @param {number}   [opts.cutoffSeconds]
 */
async function runTracerouteBackfill({ log, shouldStop = () => false, cutoffSeconds = 86400 } = {}) {
  const db = getDb();
  ensureHistoryTable(db);

  const cutoff = Math.floor(Date.now() / 1000) - cutoffSeconds;
  const emptyCutoff = Math.floor(Date.now() / 1000) - 3600; // retry empty results after 1h

  let targets;
  try {
    targets = db.prepare(
      `SELECT t.id, t.host FROM targets t
       LEFT JOIN traceroute_cache tc ON tc.target_id = t.id
       WHERE t.enabled = 1 AND (
         tc.ran_at IS NULL
         OR tc.ran_at < ?
         OR (tc.result_json = '[]' AND tc.ran_at < ?)
       )
       ORDER BY tc.ran_at ASC NULLS FIRST`
    ).all(cutoff, emptyCutoff);
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
    const results = await Promise.allSettled(
      batch.map((t) => traceAndCache(t, log))
    );
    processed += results.filter((r) => r.status === 'fulfilled').length;
  }

  return { processed, total: targets.length };
}

module.exports = { runTracerouteBackfill, traceAndCache };
