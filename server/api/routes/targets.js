'use strict';

const { getDb } = require('../../db/db');
const { getStatus } = require('../../shared/constants');
const { ResultsRangeSchema } = require('../../shared/schemas');

function buildResultsQuery(targetId, range) {
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();

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

    return {
      ...target,
      status: latest
        ? getStatus(latest.packet_loss, latest.dns_success, target.probe_type, !!latest.error)
        : 'UNKNOWN',
      latest,
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

    return { range: rangeResult.data, data: buildResultsQuery(id, rangeResult.data) };
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
