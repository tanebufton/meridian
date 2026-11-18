'use strict';

const { getDb } = require('../../db/db');
const { getTargetStates } = require('../../shared/status');

// Embeddable status badge:  <img src="https://your-host/badge/12.svg">
// Optional ?label=My%20Site overrides the left-hand text.

const COLORS = { UP: '#2ea44f', DEGRADED: '#d29922', DOWN: '#cf222e', UNKNOWN: '#6e7781', MAINT: '#6f42c1' };
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
// Approximate text width for the 11px Verdana-ish face (good enough for a badge)
const width = (s) => Math.round(String(s).length * 6.4) + 12;

function badge(label, value, color) {
  const lw = width(label), vw = width(value), w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(label)}: ${esc(value)}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="14">${esc(value)}</text>
  </g>
</svg>`;
}

module.exports = async function badgeRoutes(app) {
  app.get('/badge/:file', async (req, reply) => {
    const m = String(req.params.file).match(/^(\d{1,9})\.svg$/);
    if (!m) return reply.status(404).send({ error: 'Not found' });
    const id = parseInt(m[1], 10);

    const db = getDb();
    const target = db.prepare('SELECT id, name, enabled FROM targets WHERE id = ?').get(id);
    if (!target) return reply.status(404).send({ error: 'Not found' });

    const label = String(req.query.label || target.name).slice(0, 40);
    const s = getTargetStates(db, undefined, id)[0];

    let value, color;
    if (!s) { value = 'paused'; color = COLORS.UNKNOWN; }
    else if (s.in_maintenance) { value = 'maintenance'; color = COLORS.MAINT; }
    else {
      const ms = s.probe_type === 'dns' ? s.dns_time : s.latency_avg;
      value = s.status === 'UP' ? `up${ms != null ? ` · ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` : ''}`
        : s.status === 'DEGRADED' ? 'degraded' : s.status === 'DOWN' ? 'down' : 'unknown';
      color = COLORS[s.status] || COLORS.UNKNOWN;
    }

    reply.header('Content-Type', 'image/svg+xml').header('Cache-Control', 'public, max-age=60');
    return badge(label, value, color);
  });
};
