'use strict';

const { getDb } = require('../../db/db');
const { getStatus } = require('../../shared/constants');

module.exports = async function groupRoutes(app) {
  // GET /api/v1/groups — all groups with targets and current status
  app.get('/groups', async () => {
    const db = getDb();

    const groups = db.prepare(
      'SELECT id, name, description, sort_order FROM groups ORDER BY sort_order ASC, id ASC'
    ).all();

    const targets = db.prepare(
      `SELECT t.id, t.group_id, t.name, t.host, t.probe_type, t.interval_seconds, t.enabled, t.notes,
              pr.latency_min, pr.latency_avg, pr.latency_max, pr.latency_mdev, pr.packet_loss,
              pr.dns_success, pr.resolved_ip, pr.error, pr.timestamp,
              tu.uptime_24h
       FROM targets t
       LEFT JOIN (
         SELECT target_id, latency_min, latency_avg, latency_max, latency_mdev, packet_loss,
                dns_success, resolved_ip, error, timestamp,
                ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY timestamp DESC) AS rn
         FROM probe_results
       ) pr ON pr.target_id = t.id AND pr.rn = 1
       LEFT JOIN target_uptime tu ON tu.target_id = t.id
       WHERE t.enabled = 1
       ORDER BY t.id ASC`
    ).all();

    // Last 20 probe outcomes per target for the status history ribbon
    const recentRows = db.prepare(
      `SELECT target_id, packet_loss, dns_success, probe_type, error
       FROM (
         SELECT pr.target_id, pr.packet_loss, pr.dns_success, pr.error, t.probe_type,
                ROW_NUMBER() OVER (PARTITION BY pr.target_id ORDER BY pr.timestamp DESC) AS rn
         FROM probe_results pr
         INNER JOIN targets t ON t.id = pr.target_id
         WHERE t.enabled = 1 AND pr.timestamp >= unixepoch() - 86400
       )
       WHERE rn <= 20
       ORDER BY target_id, rn DESC`
    ).all();

    const recentByTarget = {};
    for (const r of recentRows) {
      if (!recentByTarget[r.target_id]) recentByTarget[r.target_id] = [];
      recentByTarget[r.target_id].push(getStatus(r.packet_loss, r.dns_success, r.probe_type, !!r.error));
    }

    const targetsByGroup = {};
    for (const t of targets) {
      const status = getStatus(t.packet_loss, t.dns_success, t.probe_type, !!t.error);
      const entry = {
        id: t.id,
        name: t.name,
        host: t.host,
        probe_type: t.probe_type,
        interval_seconds: t.interval_seconds,
        status,
        latency_min:  t.latency_min,
        latency_avg:  t.latency_avg,
        latency_max:  t.latency_max,
        latency_mdev: t.latency_mdev,
        packet_loss:  t.packet_loss,
        resolved_ip: t.resolved_ip,
        uptime_24h: t.uptime_24h,
        last_checked: t.timestamp,
        recent_statuses: recentByTarget[t.id] || [],
      };
      if (!targetsByGroup[t.group_id]) targetsByGroup[t.group_id] = [];
      targetsByGroup[t.group_id].push(entry);
    }

    return groups.map((g) => ({
      ...g,
      targets: targetsByGroup[g.id] || [],
    }));
  });
};
