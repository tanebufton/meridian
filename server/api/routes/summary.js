'use strict';

const { getDb } = require('../../db/db');
const { loadSettings } = require('../../shared/settings');
const { getTargetStates } = require('../../shared/status');
const { activeWindows } = require('../../shared/maintenance');

function loadBanner() {
  const s = loadSettings();
  if (s.banner_enabled && s.banner_text) return { text: s.banner_text, type: s.banner_type || 'info' };
  return null;
}

module.exports = async function summaryRoutes(app) {
  // GET /api/v1/summary — global stats + sparkline + banner + maintenance
  app.get('/summary', async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const states = getTargetStates(db, now, null, { publicOnly: true });

    // A target that is down *during maintenance* is expected, so it is counted under
    // "maintenance" rather than "offline"
    let online = 0, degraded = 0, offline = 0, maintenance = 0;
    for (const t of states) {
      if (t.in_maintenance) maintenance++;
      else if (t.status === 'UP') online++;
      else if (t.status === 'DEGRADED') degraded++;
      else offline++;
    }

    const sparkline = db.prepare(
      `SELECT period_start AS timestamp, AVG(latency_avg) AS latency_avg
       FROM probe_aggregates
       WHERE resolution = '5min' AND period_start >= ?
       GROUP BY period_start
       ORDER BY period_start ASC`
    ).all(now - 86400);

    // A window scoped to a private group/target must not leak that group's name
    const hidden = (w) => (w.scope === 'group' && !db.prepare('SELECT 1 FROM groups WHERE id = ? AND is_public = 1').get(w.scope_id))
      || (w.scope === 'target' && !db.prepare('SELECT 1 FROM targets t JOIN groups g ON g.id = t.group_id WHERE t.id = ? AND t.is_public = 1 AND g.is_public = 1').get(w.scope_id));
    const windows = activeWindows(db, now).filter((w) => !hidden(w)).map((w) => ({
      name: w.name,
      scope: w.scope,
      ends_at: w.end,
      scope_name: w.scope === 'group'
        ? db.prepare('SELECT name FROM groups WHERE id = ?').get(w.scope_id)?.name ?? null
        : w.scope === 'target'
          ? db.prepare('SELECT name FROM targets WHERE id = ?').get(w.scope_id)?.name ?? null
          : null,
    }));

    return {
      total: states.length,
      online,
      degraded,
      offline,
      maintenance,
      open_incidents: states.filter((t) => t.incident_id && !t.in_maintenance).length,
      sparkline,
      banner: loadBanner(),
      maintenance_windows: windows,
    };
  });
};
