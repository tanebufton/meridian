'use strict';

const { getDb } = require('../db/db');
const { RAW_FAIL, AGG_FAIL } = require('../shared/sql');

// Uptime = share of probes that were not completely failed (ICMP: any reply arrived,
// DNS: resolved). Long windows read pre-aggregated buckets instead of scanning raw rows
// (which are only kept for a few days anyway), so 30-day uptime is actually 30 days.
//
// A window is stitched from three tiers so nothing is double counted:
//   1-hour buckets   [since, H)   H = hour boundary 2h+ ago (rollup1Hour always covers it)
//   5-minute buckets [H, B)       B = bucket boundary 15 min ago
//   raw probes       [B, now]

function counts(db, targetId, windowSeconds, now) {
  const since = now - windowSeconds;
  const B = Math.floor((now - 900) / 300) * 300;
  let total = 0;
  let failed = 0;

  const add = (row) => { total += row.total || 0; failed += row.failed || 0; };

  if (windowSeconds <= 86400) {
    add(db.prepare(
      `SELECT COUNT(*) AS total, SUM(${RAW_FAIL}) AS failed FROM probe_results
       WHERE target_id = ? AND timestamp >= ?`
    ).get(targetId, since));
    return { total, failed };
  }

  let from5 = since;
  if (windowSeconds > 7 * 86400) {
    const H = Math.floor((now - 7200) / 3600) * 3600;
    const startH = Math.ceil(since / 3600) * 3600;
    add(db.prepare(
      `SELECT SUM(sample_count) AS total, SUM(${AGG_FAIL}) AS failed FROM probe_aggregates
       WHERE target_id = ? AND resolution = '1hour' AND period_start >= ? AND period_start < ?`
    ).get(targetId, startH, H));
    from5 = H;
  }

  add(db.prepare(
    `SELECT SUM(sample_count) AS total, SUM(${AGG_FAIL}) AS failed FROM probe_aggregates
     WHERE target_id = ? AND resolution = '5min' AND period_start >= ? AND period_start < ?`
  ).get(targetId, from5, B));

  add(db.prepare(
    `SELECT COUNT(*) AS total, SUM(${RAW_FAIL}) AS failed FROM probe_results
     WHERE target_id = ? AND timestamp >= ?`
  ).get(targetId, B));

  return { total, failed };
}

function pct({ total, failed }) {
  if (!total) return null;
  return ((total - failed) / total) * 100;
}

/** Recalculate 24h / 7d / 30d uptime for a target after a new probe result. */
function recalcUptime(targetId, _probeType, now = Math.floor(Date.now() / 1000)) {
  const db = getDb();
  const u24 = pct(counts(db, targetId, 86400, now));
  const u7 = pct(counts(db, targetId, 7 * 86400, now));
  const u30 = pct(counts(db, targetId, 30 * 86400, now));

  db.prepare(
    `INSERT INTO target_uptime (target_id, uptime_24h, uptime_7d, uptime_30d, updated_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(target_id) DO UPDATE SET
       uptime_24h = excluded.uptime_24h,
       uptime_7d = excluded.uptime_7d,
       uptime_30d = excluded.uptime_30d,
       updated_at = excluded.updated_at`
  ).run(targetId, u24, u7, u30);
}

module.exports = { recalcUptime, counts, pct };
