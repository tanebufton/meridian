'use strict';

const { requireAuth } = require('../middleware');
const { SettingsSchema } = require('../../shared/schemas');

const { loadSettings, saveSettings } = require('../../shared/settings');

module.exports = async function settingsRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/settings
  app.get('/settings', auth, async () => loadSettings());

  // PUT /api/admin/settings
  app.put('/settings', auth, async (req, reply) => {
    const result = SettingsSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues[0]?.message || 'Invalid settings' });

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
