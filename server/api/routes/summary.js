'use strict';

const { getDb } = require('../../db/db');
const { getStatus } = require('../../shared/constants');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SETTINGS_FILE = path.resolve(
  process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
  'settings.json'
);

function loadBanner() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (s.banner_enabled && s.banner_text) {
        return { text: s.banner_text, type: s.banner_type || 'info' };
      }
    }
  } catch {}
  return null;
}

module.exports = async function summaryRoutes(app) {
  // GET /api/v1/summary — global stats + sparkline + admin banner
  app.get('/summary', async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    const latestPerTarget = db.prepare(
      `SELECT t.id, t.probe_type, pr.packet_loss, pr.dns_success, pr.error
       FROM targets t
       LEFT JOIN (
         SELECT target_id, packet_loss, dns_success, error,
                ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY timestamp DESC) AS rn
         FROM probe_results
       ) pr ON pr.target_id = t.id AND pr.rn = 1
       WHERE t.enabled = 1`
    ).all();

    let online = 0, degraded = 0, offline = 0;
    for (const t of latestPerTarget) {
      const s = getStatus(t.packet_loss, t.dns_success, t.probe_type, !!t.error);
      if (s === 'UP') online++;
      else if (s === 'DEGRADED') degraded++;
      else offline++;
    }

    const since24h = now - 86400;
    const sparkline = db.prepare(
      `SELECT period_start AS timestamp, AVG(latency_avg) AS latency_avg
       FROM probe_aggregates
       WHERE resolution = '5min' AND period_start >= ?
       GROUP BY period_start
       ORDER BY period_start ASC`
    ).all(since24h);

    return {
      total: latestPerTarget.length,
      online,
      degraded,
      offline,
      sparkline,
      banner: loadBanner(),
    };
  });
};
