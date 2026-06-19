'use strict';

const { requireAuth } = require('../middleware');
const { SettingsSchema } = require('../../shared/schemas');

// Settings are stored in .env / process.env and can be overridden at runtime
// We persist overrides in a simple JSON file in data/
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SETTINGS_FILE = path.resolve(process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : './data', 'settings.json');

function loadSettings() {
  const defaults = {
    retention_raw_days: parseInt(process.env.RETENTION_RAW_DAYS || '7', 10),
    retention_5min_days: parseInt(process.env.RETENTION_5MIN_DAYS || '30', 10),
    retention_1hour_days: parseInt(process.env.RETENTION_1HOUR_DAYS || '365', 10),
    default_probe_interval: parseInt(process.env.DEFAULT_PROBE_INTERVAL || '60', 10),
    default_packet_count: parseInt(process.env.DEFAULT_PACKET_COUNT || '10', 10),
  };

  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return { ...defaults, ...overrides };
    } catch {
      return defaults;
    }
  }
  return defaults;
}

function saveSettings(settings) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

module.exports = async function settingsRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/settings
  app.get('/settings', auth, async () => loadSettings());

  // PUT /api/admin/settings
  app.put('/settings', auth, async (req, reply) => {
    const result = SettingsSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const current = loadSettings();
    const updated = { ...current, ...result.data };
    saveSettings(updated);
    return updated;
  });

  // POST /api/admin/traceroute/backfill — manually trigger traceroute for all stale/empty targets
  let backfillRunning = false;
  app.post('/traceroute/backfill', auth, async (req, reply) => {
    if (backfillRunning) {
      return reply.status(409).send({ error: 'Backfill already running' });
    }
    const { runTracerouteBackfill } = require('../../probe/traceroute-backfill');
    backfillRunning = true;
    runTracerouteBackfill({ cutoffSeconds: 0 }) // cutoffSeconds=0 forces all stale/empty
      .catch(() => {})
      .finally(() => { backfillRunning = false; });
    return { ok: true, message: 'Traceroute backfill started — results will appear shortly' };
  });
};
