'use strict';

const { getDb } = require('../../db/db');
const { loadSettings } = require('../../shared/settings');

// Public view of incidents. Deliberately omits the internal cause string (which can be a
// raw resolver/ping error) and the acknowledging admin's name and note.
const SELECT = `SELECT i.id, i.target_id, t.name AS target_name, g.name AS group_name,
                       i.started_at, i.ended_at, i.maintenance,
                       (i.ack_at IS NOT NULL) AS acknowledged
                FROM incidents i
                JOIN targets t ON t.id = i.target_id
                JOIN groups g ON g.id = t.group_id`;

const shape = (r) => ({
  id: r.id,
  target_id: r.target_id,
  target_name: r.target_name,
  group_name: r.group_name,
  started_at: r.started_at,
  ended_at: r.ended_at,
  ongoing: r.ended_at == null,
  duration_seconds: (r.ended_at ?? Math.floor(Date.now() / 1000)) - r.started_at,
  acknowledged: !!r.acknowledged,
  during_maintenance: !!r.maintenance,
});

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

module.exports = async function incidentRoutes(app) {
  // GET /api/v1/incidents?days=30&limit=100
  app.get('/api/v1/incidents', async (req) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const rows = getDb().prepare(
      `${SELECT} WHERE i.ended_at IS NULL OR i.started_at >= ?
       ORDER BY (i.ended_at IS NULL) DESC, i.started_at DESC LIMIT ?`
    ).all(since, limit);
    return { days, incidents: rows.map(shape) };
  });

  // GET /api/v1/targets/:id/incidents
  app.get('/api/v1/targets/:id/incidents', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return reply.status(400).send({ error: 'Invalid id' });
    const rows = getDb().prepare(`${SELECT} WHERE i.target_id = ? ORDER BY i.started_at DESC LIMIT 50`).all(id);
    return { incidents: rows.map(shape) };
  });

  // GET /feed.atom — subscribe to incidents in any feed reader
  app.get('/feed.atom', async (req, reply) => {
    const base = (loadSettings().public_base_url || '').replace(/\/$/, '');
    const rows = getDb().prepare(`${SELECT} ORDER BY i.started_at DESC LIMIT 50`).all().map(shape);
    const iso = (s) => new Date(s * 1000).toISOString();
    const entries = rows.map((i) => {
      const title = i.ongoing ? `DOWN: ${i.target_name}` : `Resolved: ${i.target_name}`;
      const mins = Math.max(1, Math.round(i.duration_seconds / 60));
      const summary = i.ongoing
        ? `${i.target_name} (${i.group_name}) has been down since ${iso(i.started_at)}.`
        : `${i.target_name} (${i.group_name}) was down for ${mins} minute${mins === 1 ? '' : 's'} (${iso(i.started_at)} to ${iso(i.ended_at)}).`;
      return `  <entry>
    <id>tag:meridian,2026:incident:${i.id}</id>
    <title>${esc(title)}</title>
    <updated>${iso(i.ended_at ?? i.started_at)}</updated>
    <published>${iso(i.started_at)}</published>
    ${base ? `<link href="${esc(`${base}/target/${i.target_id}`)}"/>` : ''}
    <summary>${esc(summary)}</summary>
  </entry>`;
    }).join('\n');

    reply.header('Content-Type', 'application/atom+xml; charset=utf-8').header('Cache-Control', 'public, max-age=60');
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:meridian,2026:incidents</id>
  <title>Meridian incidents</title>
  <updated>${rows.length ? iso(rows.reduce((m, r) => Math.max(m, r.ended_at ?? r.started_at), 0)) : new Date().toISOString()}</updated>
${entries}
</feed>
`;
  });
};
