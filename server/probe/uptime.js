'use strict';

const { getDb } = require('../db/db');

/**
 * Recalculate uptime percentages for a target after a new probe result.
 * Uptime = % of probes where packet_loss < 100 (ICMP) or dns_success = 1 (DNS)
 */
function recalcUptime(targetId, probeType) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  function calcPct(seconds) {
    const since = now - seconds;
    let total, successful;
    if (probeType === 'dns') {
      const row = db.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN dns_success = 1 THEN 1 ELSE 0 END) AS successful
         FROM probe_results WHERE target_id = ? AND timestamp >= ?`
      ).get(targetId, since);
      total = row.total;
      successful = row.successful || 0;
    } else {
      const row = db.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN packet_loss < 100 THEN 1 ELSE 0 END) AS successful
         FROM probe_results WHERE target_id = ? AND timestamp >= ?`
      ).get(targetId, since);
      total = row.total;
      successful = row.successful || 0;
    }
    if (total === 0) return null;
    return (successful / total) * 100;
  }

  const uptime_24h = calcPct(86400);
  const uptime_7d = calcPct(7 * 86400);
  const uptime_30d = calcPct(30 * 86400);

  db.prepare(
    `INSERT INTO target_uptime (target_id, uptime_24h, uptime_7d, uptime_30d, updated_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(target_id) DO UPDATE SET
       uptime_24h = excluded.uptime_24h,
       uptime_7d = excluded.uptime_7d,
       uptime_30d = excluded.uptime_30d,
       updated_at = excluded.updated_at`
  ).run(targetId, uptime_24h, uptime_7d, uptime_30d);
}

module.exports = { recalcUptime };
