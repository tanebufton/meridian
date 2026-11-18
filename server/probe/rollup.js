'use strict';

const { getDb } = require('../db/db');
const { RAW_FAIL, RAW_LOSS, AGG_FAIL } = require('../shared/sql');

const COLS = `(target_id, period_start, resolution, latency_min, latency_avg, latency_max, latency_mdev, latency_p50, latency_p95, packet_loss, sample_count, fail_count)`;
const OVERWRITE = `ON CONFLICT(target_id, period_start, resolution) DO UPDATE SET
  latency_min  = excluded.latency_min,
  latency_avg  = excluded.latency_avg,
  latency_max  = excluded.latency_max,
  latency_mdev = excluded.latency_mdev,
  latency_p50  = excluded.latency_p50,
  latency_p95  = excluded.latency_p95,
  packet_loss  = excluded.packet_loss,
  sample_count = excluded.sample_count,
  fail_count   = excluded.fail_count`;
const KEEP_EXISTING = `ON CONFLICT(target_id, period_start, resolution) DO NOTHING`;

/**
 * Recompute 5-minute buckets from raw probe_results for every bucket starting at or
 * after `since`. This is idempotent (it overwrites from source data rather than adding
 * to what is there), so it is safe to run repeatedly, for catch-up after downtime, and
 * for backfill. `since` should be bucket-aligned so a bucket is never rebuilt from a
 * partial slice of its raw rows.
 */
function rollup5MinSince(db, since, onConflict = OVERWRITE) {
  return db.prepare(
    `INSERT INTO probe_aggregates ${COLS}
     SELECT target_id,
            (timestamp / 300) * 300,
            '5min',
            MIN(latency_min),
            AVG(latency_avg),
            MAX(latency_max),
            AVG(latency_mdev),
            AVG(latency_p50),
            AVG(latency_p95),
            AVG(${RAW_LOSS}),
            COUNT(*),
            SUM(${RAW_FAIL})
     FROM probe_results
     WHERE timestamp >= ?
     GROUP BY target_id, (timestamp / 300) * 300
     ${onConflict}`
  ).run(since);
}

/** Recompute 1-hour buckets from 5-minute buckets starting at or after `since`. */
function rollup1HourSince(db, since, onConflict = OVERWRITE) {
  return db.prepare(
    `INSERT INTO probe_aggregates ${COLS}
     SELECT target_id,
            (period_start / 3600) * 3600,
            '1hour',
            MIN(latency_min),
            AVG(latency_avg),
            MAX(latency_max),
            AVG(latency_mdev),
            AVG(latency_p50),
            AVG(latency_p95),
            AVG(packet_loss),
            SUM(sample_count),
            SUM(${AGG_FAIL})
     FROM probe_aggregates
     WHERE resolution = '5min' AND period_start >= ?
     GROUP BY target_id, (period_start / 3600) * 3600
     ${onConflict}`
  ).run(since);
}

/** Roll up the last hour of raw data. Looking back an hour (not 10 minutes) means a
 *  stalled or restarted worker catches up automatically on the next run. */
function rollup5Min() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const since = Math.floor((now - 3600) / 300) * 300;
  db.transaction(() => rollup5MinSince(db, since))();
}

function rollup1Hour() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const since = Math.floor((now - 7200) / 3600) * 3600;
  db.transaction(() => rollup1HourSince(db, since))();
}

/**
 * Catch up on startup. Two passes, both idempotent:
 *  1. fill any bucket that has raw data but no aggregate yet (imports, long outages,
 *     new databases) without touching existing buckets;
 *  2. rebuild everything from the newest bucket onward so a bucket that was only
 *     partly rolled up when the worker stopped is completed.
 * It previously ADDED the raw sample counts to existing buckets on every restart, which
 * inflated every aggregate a little more each time the probe worker restarted.
 */
function backfillAggregates() {
  const db = getDb();
  const last = db.prepare(`SELECT MAX(period_start) AS p FROM probe_aggregates WHERE resolution = '5min'`).get().p;
  db.transaction(() => {
    rollup5MinSince(db, 0, KEEP_EXISTING);
    rollup1HourSince(db, 0, KEEP_EXISTING);
    if (last != null) {
      rollup5MinSince(db, last);
      rollup1HourSince(db, Math.floor(last / 3600) * 3600);
    }
  })();
}

/** Nightly retention cleanup — removes old data per configured retention days. */
function runRetention(settings) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const rawCutoff     = now - (settings.retention_raw_days    * 86400);
  const fiveMinCutoff = now - (settings.retention_5min_days   * 86400);
  const oneHourCutoff = now - (settings.retention_1hour_days  * 86400);

  db.prepare('DELETE FROM probe_results WHERE timestamp < ?').run(rawCutoff);
  db.prepare("DELETE FROM probe_aggregates WHERE resolution = '5min'   AND period_start < ?").run(fiveMinCutoff);
  db.prepare("DELETE FROM probe_aggregates WHERE resolution = '1hour'  AND period_start < ?").run(oneHourCutoff);
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM audit_log WHERE at < ?').run(now - 365 * 86400);
  // Keep incident history as long as the hourly data it explains
  db.prepare('DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?').run(oneHourCutoff);
  // Expired one-off maintenance windows are noise after a week
  db.prepare(`DELETE FROM maintenance_windows WHERE repeat = 'none' AND ends_at < ?`).run(now - 7 * 86400);
  db.pragma('wal_checkpoint(PASSIVE)');
}

module.exports = { rollup5Min, rollup1Hour, rollup5MinSince, rollup1HourSince, runRetention, backfillAggregates };
