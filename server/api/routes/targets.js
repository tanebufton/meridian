'use strict';

const { getDb } = require('../../db/db');
const { getStatus } = require('../../shared/constants');
const { getTargetStates } = require('../../shared/status');
const { ResultsRangeSchema } = require('../../shared/schemas');
const { buildResultsQuery } = require('../../shared/results');
const { AGG_FAIL } = require('../../shared/sql');

module.exports = async function targetRoutes(app) {
  // GET /api/v1/targets/:id
  app.get('/targets/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    const target = db.prepare(
      'SELECT id, group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes, created_at FROM targets WHERE id = ?'
    ).get(id);

    if (!target) return reply.status(404).send({ error: 'Not found' });

    const latest = db.prepare(
      'SELECT latency_avg, packet_loss, dns_success, resolved_ip, error, timestamp FROM probe_results WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(id);

    const overlay = getTargetStates(db, undefined, id)[0];

    return {
      ...target,
      status: latest
        ? getStatus(latest.packet_loss, latest.dns_success, target.probe_type, !!latest.error)
        : 'UNKNOWN',
      latest,
      in_maintenance: overlay?.in_maintenance ?? false,
      maintenance_ends_at: overlay?.maintenance_ends_at ?? null,
      maintenance_name: overlay?.maintenance_name ?? null,
      incident_started_at: overlay?.incident_started_at ?? null,
      incident_acknowledged: !!overlay?.incident_ack_at,
    };
  });

  // GET /api/v1/targets/:id/results?range=1h|6h|12h|24h|7d|30d
  app.get('/targets/:id/results', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });

    const rangeResult = ResultsRangeSchema.safeParse(req.query.range || '1h');
    if (!rangeResult.success) return reply.status(400).send({ error: 'Invalid range' });

    const db = getDb();
    if (!db.prepare('SELECT id FROM targets WHERE id = ?').get(id)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    return { range: rangeResult.data, data: buildResultsQuery(db, id, rangeResult.data) };
  });

  // GET /api/v1/targets/:id/uptime
  app.get('/targets/:id/uptime', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    const uptime = db.prepare(
      'SELECT uptime_24h, uptime_7d, uptime_30d, updated_at FROM target_uptime WHERE target_id = ?'
    ).get(id) || { uptime_24h: null, uptime_7d: null, uptime_30d: null, updated_at: null };

    // All-time latency stats from error-free probes (works for both ICMP and DNS)
    const stats = db.prepare(
      `SELECT
         MIN(CASE WHEN latency_min IS NOT NULL THEN latency_min ELSE dns_time END) AS latency_min,
         AVG(CASE WHEN latency_avg IS NOT NULL THEN latency_avg ELSE dns_time END) AS latency_avg,
         MAX(CASE WHEN latency_max IS NOT NULL THEN latency_max ELSE dns_time END) AS latency_max
       FROM probe_results
       WHERE target_id = ? AND error IS NULL`
    ).get(id) || { latency_min: null, latency_avg: null, latency_max: null };

    return { ...uptime, ...stats };
  });

  // GET /api/v1/targets/:id/availability?days=90 — per-day uptime for the status-page bars.
  // Days are UTC calendar days built from the hourly aggregates (kept for a year).
  app.get('/targets/:id/availability', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);

    const db = getDb();
    if (!db.prepare('SELECT id FROM targets WHERE id = ?').get(id)) return reply.status(404).send({ error: 'Not found' });

    const now = Math.floor(Date.now() / 1000);
    const todayStart = Math.floor(now / 86400) * 86400;
    const since = todayStart - (days - 1) * 86400;
    const rows = db.prepare(
      `SELECT (period_start / 86400) * 86400 AS day,
              SUM(sample_count) AS samples,
              SUM(${AGG_FAIL}) AS failed,
              AVG(latency_avg) AS latency_avg
       FROM probe_aggregates
       WHERE target_id = ? AND resolution = '1hour' AND period_start >= ?
       GROUP BY day ORDER BY day ASC`
    ).all(id, since);

    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out = [];
    for (let d = since; d <= todayStart; d += 86400) {
      const r = byDay.get(d);
      out.push({
        day: d,
        uptime: r && r.samples ? ((r.samples - r.failed) / r.samples) * 100 : null,
        latency_avg: r ? r.latency_avg : null,
      });
    }
    return { days, data: out };
  });

  // GET /api/v1/targets/:id/traceroute — read cached result only (probe worker writes this)
  app.get('/targets/:id/traceroute', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    if (!db.prepare('SELECT id FROM targets WHERE id = ?').get(id)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const cached = db.prepare('SELECT result_json, ran_at FROM traceroute_cache WHERE target_id = ?').get(id);
    if (!cached) return { ran_at: null, hops: null };

    return { ran_at: cached.ran_at, hops: JSON.parse(cached.result_json) };
  });

  // GET /api/v1/targets/:id/traceroute/history — path-change history (probe worker writes this)
  app.get('/targets/:id/traceroute/history', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    if (!db.prepare('SELECT id FROM targets WHERE id = ?').get(id)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    let rows;
    try {
      rows = db.prepare(
        'SELECT id, result_json, ran_at FROM traceroute_history WHERE target_id = ? ORDER BY ran_at DESC LIMIT 50'
      ).all(id);
    } catch {
      // Table doesn't exist yet — backfill worker creates it on first run
      return { history: [] };
    }

    return {
      history: rows.map((r) => ({ id: r.id, ran_at: r.ran_at, hops: JSON.parse(r.result_json) })),
    };
  });
};
