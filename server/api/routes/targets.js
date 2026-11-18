'use strict';

const { getDb } = require('../../db/db');
const { getStatus } = require('../../shared/constants');
const { getTargetStates } = require('../../shared/status');
const { publicTarget } = require('../../shared/visibility');
const maintenance = require('../../shared/maintenance');
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
      'SELECT t.id, t.group_id, t.name, t.host, t.probe_type, t.interval_seconds, t.packet_count, t.enabled, t.notes, t.created_at FROM targets t JOIN groups g ON g.id = t.group_id WHERE t.id = ? AND t.is_public = 1 AND g.is_public = 1'
    ).get(id);

    if (!target) return reply.status(404).send({ error: 'Not found' });

    const latest = db.prepare(
      'SELECT latency_avg, packet_loss, dns_success, resolved_ip, error, timestamp FROM probe_results WHERE target_id = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(id);

    const overlay = getTargetStates(db, undefined, id, { publicOnly: true })[0];

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
    if (!publicTarget(db, id)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    return { range: rangeResult.data, data: buildResultsQuery(db, id, rangeResult.data) };
  });

  // GET /api/v1/targets/:id/uptime
  app.get('/targets/:id/uptime', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    if (!publicTarget(db, id)) return reply.status(404).send({ error: 'Not found' });
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

  // GET /api/v1/targets/:id/events?range=24h — what to draw ON the chart: outages, maintenance
  // windows and route changes inside the visible time range
  app.get('/targets/:id/events', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });
    const range = ResultsRangeSchema.safeParse(req.query.range || '24h');
    if (!range.success) return reply.status(400).send({ error: 'Invalid range' });
    const db = getDb();
    const target = publicTarget(db, id);
    if (!target) return reply.status(404).send({ error: 'Not found' });

    const now = Math.floor(Date.now() / 1000);
    const secs = { '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400, '7d': 604800, '30d': 2592000, '3mo': 7776000 }[range.data];
    const since = now - secs;

    const incidents = db.prepare(
      `SELECT started_at, ended_at FROM incidents WHERE target_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at`
    ).all(id, now, since).map((i) => ({ start: i.started_at, end: i.ended_at ?? now, ongoing: i.ended_at == null }));

    const windows = [];
    for (const w of maintenance.allWindows(db, now, 0)) {
      if (!maintenance.covers(w, target)) continue;
      for (const o of maintenance.occurrences(w, since, now)) windows.push({ start: o.start, end: o.end, name: w.name });
    }

    const rows = db.prepare('SELECT id, ran_at, as_path_json FROM traceroute_history WHERE target_id = ? ORDER BY ran_at, id').all(id);
    const routeChanges = rows.map((r, i) => {
      let path = null;
      try { path = JSON.parse(r.as_path_json || 'null')?.path ?? null; } catch { /* legacy row */ }
      return { at: r.ran_at, path, initial: i === 0 };
    }).filter((r) => r.at >= since && !r.initial);

    return { range: range.data, since, incidents, maintenance: windows, route_changes: routeChanges };
  });

  // GET /api/v1/targets/:id/availability?days=90 — per-day uptime for the status-page bars.
  // Days are UTC calendar days built from the hourly aggregates (kept for a year).
  app.get('/targets/:id/availability', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);

    const db = getDb();
    if (!publicTarget(db, id)) return reply.status(404).send({ error: 'Not found' });

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
    if (!publicTarget(db, id)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const cached = db.prepare('SELECT result_json, ran_at, as_path_json, method, complete FROM traceroute_cache WHERE target_id = ?').get(id);
    if (!cached) return { ran_at: null, hops: null };

    let as_path = [];
    try { as_path = JSON.parse(cached.as_path_json || 'null')?.path ?? []; } catch { /* legacy */ }
    return { ran_at: cached.ran_at, hops: JSON.parse(cached.result_json), as_path, method: cached.method, complete: !!cached.complete };
  });

  // GET /api/v1/targets/:id/traceroute/history — path-change history (probe worker writes this)
  app.get('/targets/:id/traceroute/history', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    if (!publicTarget(db, id)) {
      return reply.status(404).send({ error: 'Not found' });
    }

    let rows;
    try {
      rows = db.prepare(
        'SELECT id, result_json, ran_at, as_path_json FROM traceroute_history WHERE target_id = ? ORDER BY ran_at DESC, id DESC LIMIT 50'
      ).all(id);
    } catch {
      // Table doesn't exist yet — backfill worker creates it on first run
      return { history: [] };
    }

    return {
      history: rows.map((r) => {
        let as_path = [];
        try { as_path = JSON.parse(r.as_path_json || 'null')?.path ?? []; } catch { /* legacy */ }
        return { id: r.id, ran_at: r.ran_at, hops: JSON.parse(r.result_json), as_path };
      }),
    };
  });
};
