'use strict';

const { getDb } = require('../db/db');

/**
 * Aggregate raw probe_results from the last `lookbackSeconds` seconds into 5-min buckets.
 */
function rollup5Min() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const since = now - 600; // last 10 minutes

  const buckets = db.prepare(
    `SELECT target_id,
            (timestamp / 300) * 300 AS period_start,
            MIN(latency_min)  AS latency_min,
            AVG(latency_avg)  AS latency_avg,
            MAX(latency_max)  AS latency_max,
            AVG(latency_mdev) AS latency_mdev,
            AVG(CASE
              WHEN packet_loss IS NOT NULL THEN packet_loss
              WHEN dns_success IS NOT NULL THEN (CASE WHEN dns_success = 0 THEN 100.0 ELSE 0.0 END)
              ELSE NULL
            END) AS packet_loss,
            COUNT(*) AS sample_count
     FROM probe_results
     WHERE timestamp >= ?
     GROUP BY target_id, period_start`
  ).all(since);

  const upsert = db.prepare(
    `INSERT INTO probe_aggregates (target_id, period_start, resolution, latency_min, latency_avg, latency_max, latency_mdev, packet_loss, sample_count)
     VALUES (?, ?, '5min', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id, period_start, resolution) DO UPDATE SET
       latency_min  = excluded.latency_min,
       latency_avg  = excluded.latency_avg,
       latency_max  = excluded.latency_max,
       latency_mdev = excluded.latency_mdev,
       packet_loss  = excluded.packet_loss,
       sample_count = excluded.sample_count`
  );

  const run = db.transaction(() => {
    for (const b of buckets) {
      upsert.run(b.target_id, b.period_start, b.latency_min, b.latency_avg, b.latency_max, b.latency_mdev, b.packet_loss, b.sample_count);
    }
  });
  run();
}

/**
 * Aggregate 5-min buckets from the last 2 hours into 1-hour buckets.
 */
function rollup1Hour() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const since = now - 7200; // last 2 hours

  const buckets = db.prepare(
    `SELECT target_id,
            (period_start / 3600) * 3600 AS period_start,
            MIN(latency_min)  AS latency_min,
            AVG(latency_avg)  AS latency_avg,
            MAX(latency_max)  AS latency_max,
            AVG(latency_mdev) AS latency_mdev,
            AVG(packet_loss)  AS packet_loss,
            SUM(sample_count) AS sample_count
     FROM probe_aggregates
     WHERE resolution = '5min' AND period_start >= ?
     GROUP BY target_id, (period_start / 3600) * 3600`
  ).all(since);

  const upsert = db.prepare(
    `INSERT INTO probe_aggregates (target_id, period_start, resolution, latency_min, latency_avg, latency_max, latency_mdev, packet_loss, sample_count)
     VALUES (?, ?, '1hour', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id, period_start, resolution) DO UPDATE SET
       latency_min  = excluded.latency_min,
       latency_avg  = excluded.latency_avg,
       latency_max  = excluded.latency_max,
       latency_mdev = excluded.latency_mdev,
       packet_loss  = excluded.packet_loss,
       sample_count = excluded.sample_count`
  );

  const run = db.transaction(() => {
    for (const b of buckets) {
      upsert.run(b.target_id, b.period_start, b.latency_min, b.latency_avg, b.latency_max, b.latency_mdev, b.packet_loss, b.sample_count);
    }
  });
  run();
}

/**
 * Nightly retention cleanup — removes old data per configured retention days.
 */
function runRetention(settings) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const rawCutoff     = now - (settings.retention_raw_days    * 86400);
  const fiveMinCutoff = now - (settings.retention_5min_days   * 86400);
  const oneHourCutoff = now - (settings.retention_1hour_days  * 86400);

  db.prepare('DELETE FROM probe_results WHERE timestamp < ?').run(rawCutoff);
  db.prepare("DELETE FROM probe_aggregates WHERE resolution = '5min'   AND period_start < ?").run(fiveMinCutoff);
  db.prepare("DELETE FROM probe_aggregates WHERE resolution = '1hour'  AND period_start < ?").run(oneHourCutoff);
}

/**
 * Backfill all historical raw data into aggregates — run once on startup.
 */
function backfillAggregates() {
  const db = getDb();

  // 5-min: aggregate ALL raw results
  db.prepare(
    `INSERT INTO probe_aggregates (target_id, period_start, resolution, latency_min, latency_avg, latency_max, latency_mdev, packet_loss, sample_count)
     SELECT target_id,
            (timestamp / 300) * 300 AS period_start,
            '5min',
            MIN(latency_min),
            AVG(latency_avg),
            MAX(latency_max),
            AVG(latency_mdev),
            AVG(CASE
              WHEN packet_loss IS NOT NULL THEN packet_loss
              WHEN dns_success IS NOT NULL THEN (CASE WHEN dns_success = 0 THEN 100.0 ELSE 0.0 END)
              ELSE NULL
            END),
            COUNT(*)
     FROM probe_results
     GROUP BY target_id, period_start
     ON CONFLICT(target_id, period_start, resolution) DO UPDATE SET
       latency_min  = MIN(excluded.latency_min, probe_aggregates.latency_min),
       latency_avg  = (excluded.latency_avg * excluded.sample_count + probe_aggregates.latency_avg * probe_aggregates.sample_count)
                      / (excluded.sample_count + probe_aggregates.sample_count),
       latency_max  = MAX(excluded.latency_max, probe_aggregates.latency_max),
       latency_mdev = excluded.latency_mdev,
       packet_loss  = (excluded.packet_loss * excluded.sample_count + probe_aggregates.packet_loss * probe_aggregates.sample_count)
                      / (excluded.sample_count + probe_aggregates.sample_count),
       sample_count = excluded.sample_count + probe_aggregates.sample_count`
  ).run();

  // 1-hour: aggregate ALL 5-min buckets
  db.prepare(
    `INSERT INTO probe_aggregates (target_id, period_start, resolution, latency_min, latency_avg, latency_max, latency_mdev, packet_loss, sample_count)
     SELECT target_id,
            (period_start / 3600) * 3600 AS hour_start,
            '1hour',
            MIN(latency_min),
            AVG(latency_avg),
            MAX(latency_max),
            AVG(latency_mdev),
            AVG(packet_loss),
            SUM(sample_count)
     FROM probe_aggregates
     WHERE resolution = '5min'
     GROUP BY target_id, hour_start
     ON CONFLICT(target_id, period_start, resolution) DO UPDATE SET
       latency_min  = MIN(excluded.latency_min, probe_aggregates.latency_min),
       latency_avg  = excluded.latency_avg,
       latency_max  = MAX(excluded.latency_max, probe_aggregates.latency_max),
       latency_mdev = excluded.latency_mdev,
       packet_loss  = excluded.packet_loss,
       sample_count = excluded.sample_count`
  ).run();
}

module.exports = { rollup5Min, rollup1Hour, runRetention, backfillAggregates };
