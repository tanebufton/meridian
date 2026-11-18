'use strict';

// Time-series for a target over a named range. Short ranges read raw probes, mid ranges
// 5-minute buckets, long ranges 1-hour buckets.

function buildResultsQuery(db, targetId, range) {
  const now = Math.floor(Date.now() / 1000);

  if (range === '1h' || range === '6h' || range === '12h') {
    const seconds = range === '1h' ? 3600 : range === '6h' ? 21600 : 43200;
    return db.prepare(
      `SELECT id, timestamp, latency_min, latency_avg, latency_max, latency_mdev, packet_loss,
              dns_time, dns_success, resolved_ip, error
       FROM probe_results
       WHERE target_id = ? AND timestamp >= ?
       ORDER BY timestamp ASC`
    ).all(targetId, now - seconds);
  }

  if (range === '24h' || range === '7d') {
    const seconds = range === '24h' ? 86400 : 604800;
    return db.prepare(
      `SELECT period_start AS timestamp, latency_min, latency_avg, latency_max,
              packet_loss, sample_count, NULL AS dns_time, NULL AS dns_success,
              NULL AS resolved_ip, NULL AS error
       FROM probe_aggregates
       WHERE target_id = ? AND resolution = '5min' AND period_start >= ?
       ORDER BY period_start ASC`
    ).all(targetId, now - seconds);
  }

  // 30d / 3mo — 1-hour aggregates
  const days = range === '3mo' ? 90 : 30;
  return db.prepare(
    `SELECT period_start AS timestamp, latency_min, latency_avg, latency_max,
            packet_loss, sample_count, NULL AS dns_time, NULL AS dns_success,
            NULL AS resolved_ip, NULL AS error
     FROM probe_aggregates
     WHERE target_id = ? AND resolution = '1hour' AND period_start >= ?
     ORDER BY period_start ASC`
  ).all(targetId, now - days * 86400);
}

module.exports = { buildResultsQuery };
