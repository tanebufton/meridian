'use strict';

const { getStatus } = require('./constants');
const { maintenanceMap } = require('./maintenance');

/**
 * Current state of every enabled target: latest probe, status, uptime, open incident and
 * maintenance. One query shape shared by /metrics, badges and the summary endpoint so
 * they can never disagree about what "down" means.
 */
function getTargetStates(db, now = Math.floor(Date.now() / 1000), onlyTargetId = null, { publicOnly = false } = {}) {
  const rows = db.prepare(
    `SELECT t.id, t.group_id, t.name, t.host, t.probe_type, t.interval_seconds, t.notes,
            g.name AS group_name,
            pr.latency_min, pr.latency_avg, pr.latency_max, pr.latency_mdev, pr.packet_loss,
            pr.dns_success, pr.dns_time, pr.resolved_ip, pr.error, pr.timestamp AS last_checked,
            tu.uptime_24h, tu.uptime_7d, tu.uptime_30d,
            inc.id AS incident_id, inc.started_at AS incident_started_at, inc.ack_at AS incident_ack_at
     FROM targets t
     JOIN groups g ON g.id = t.group_id
     LEFT JOIN probe_results pr ON pr.id = (
       -- newest probe via idx_probe_results_target_timestamp: ~1ms for the whole fleet.
       -- (A ROW_NUMBER() window over the table sorted every row: ~500ms and growing.)
       SELECT r.id FROM probe_results r WHERE r.target_id = t.id ORDER BY r.timestamp DESC, r.id DESC LIMIT 1
     )
     LEFT JOIN target_uptime tu ON tu.target_id = t.id
     LEFT JOIN incidents inc ON inc.target_id = t.id AND inc.ended_at IS NULL
     WHERE t.enabled = 1 ${publicOnly ? 'AND t.is_public = 1 AND g.is_public = 1' : ''} ${onlyTargetId != null ? 'AND t.id = ?' : ''}
     ORDER BY g.sort_order ASC, g.id ASC, t.id ASC`
  ).all(...(onlyTargetId != null ? [onlyTargetId] : []));

  const maint = maintenanceMap(db, rows, now);
  return rows.map((r) => ({
    ...r,
    status: r.last_checked == null
      ? 'UNKNOWN'
      : getStatus(r.packet_loss ?? null, r.dns_success ?? null, r.probe_type, !!r.error),
    in_maintenance: maint.has(r.id),
    maintenance_ends_at: maint.get(r.id)?.end ?? null,
    maintenance_name: maint.get(r.id)?.name ?? null,
  }));
}

module.exports = { getTargetStates };
