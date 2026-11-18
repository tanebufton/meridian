'use strict';

const { getDb } = require('../../db/db');
const { getStatus } = require('../../shared/constants');
const { getTargetStates } = require('../../shared/status');
const { publicGroup } = require('../../shared/visibility');
const { buildResultsQuery } = require('../../shared/results');
const { ResultsRangeSchema } = require('../../shared/schemas');

module.exports = async function groupRoutes(app) {
  // GET /api/v1/groups — all groups with targets and current status
  app.get('/groups', async () => {
    const db = getDb();

    const groups = db.prepare(
      'SELECT id, name, description, sort_order FROM groups WHERE is_public = 1 ORDER BY sort_order ASC, id ASC'
    ).all();

    const targets = db.prepare(
      `SELECT t.id, t.group_id, t.name, t.host, t.probe_type, t.interval_seconds, t.enabled, t.notes,
              pr.latency_min, pr.latency_avg, pr.latency_max, pr.latency_mdev, pr.packet_loss,
              pr.dns_success, pr.resolved_ip, pr.error, pr.timestamp,
              tu.uptime_24h
       FROM targets t
       LEFT JOIN probe_results pr ON pr.id = (
         SELECT r.id FROM probe_results r WHERE r.target_id = t.id ORDER BY r.timestamp DESC, r.id DESC LIMIT 1
       )
       LEFT JOIN target_uptime tu ON tu.target_id = t.id
       WHERE t.enabled = 1 AND t.is_public = 1 AND t.group_id IN (SELECT id FROM groups WHERE is_public = 1)
       ORDER BY t.id ASC`
    ).all();

    // Last 20 probe outcomes per target for the status history ribbon (one indexed
    // LIMIT 20 lookup per target instead of a window function over a day of results)
    const lastTwenty = db.prepare(
      `SELECT packet_loss, dns_success, error FROM probe_results
       WHERE target_id = ? ORDER BY timestamp DESC, id DESC LIMIT 20`
    );
    const recentByTarget = {};
    for (const t of targets) {
      recentByTarget[t.id] = lastTwenty.all(t.id).reverse()
        .map((r) => getStatus(r.packet_loss, r.dns_success, t.probe_type, !!r.error));
    }

    // Each target's typical latency over the last 7 days (hourly aggregates, indexed), so the UI can
    // say "slower than usual" instead of just ranking by distance
    const base = new Map(db.prepare(
      `SELECT target_id, AVG(latency_avg) AS v FROM probe_aggregates
       WHERE resolution = '1hour' AND period_start >= ? AND latency_avg IS NOT NULL GROUP BY target_id`
    ).all(Math.floor(Date.now() / 1000) - 7 * 86400).map((r) => [r.target_id, r.v]));

    // Maintenance + open-incident overlay (shared with /metrics and /summary)
    const overlay = new Map(getTargetStates(db, undefined, null, { publicOnly: true }).map((st) => [st.id, st]));

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
        latency_7d: base.get(t.id) ?? null,
        recent_statuses: recentByTarget[t.id] || [],
        in_maintenance: overlay.get(t.id)?.in_maintenance ?? false,
        maintenance_ends_at: overlay.get(t.id)?.maintenance_ends_at ?? null,
        incident_started_at: overlay.get(t.id)?.incident_started_at ?? null,
        incident_acknowledged: !!overlay.get(t.id)?.incident_ack_at,
      };
      if (!targetsByGroup[t.group_id]) targetsByGroup[t.group_id] = [];
      targetsByGroup[t.group_id].push(entry);
    }

    return groups.map((g) => ({
      ...g,
      targets: targetsByGroup[g.id] || [],
    }));
  });

  // GET /api/v1/groups/:id/results?range=12h — every enabled target's series in ONE
  // request. The group page used to fire a request per target (140+ for a big group),
  // which also hammered the rate limiter.
  app.get('/groups/:id/results', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });
    const range = ResultsRangeSchema.safeParse(req.query.range || '12h');
    if (!range.success) return reply.status(400).send({ error: 'Invalid range' });

    const db = getDb();
    if (!publicGroup(db, id)) return reply.status(404).send({ error: 'Not found' });

    const ids = db.prepare('SELECT id FROM targets WHERE group_id = ? AND enabled = 1 AND is_public = 1').all(id).map((t) => t.id);
    const targets = {};
    const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
    for (const tid of ids) {
      // Only what the sparkline needs (the full rows carry errors, IPs, ids…)
      targets[tid] = buildResultsQuery(db, tid, range.data).map((d) => ({
        timestamp: d.timestamp, latency_min: r2(d.latency_min), latency_avg: r2(d.latency_avg),
        latency_max: r2(d.latency_max), packet_loss: d.packet_loss, dns_time: r2(d.dns_time),
      }));
    }
    return { range: range.data, targets };
  });
};
