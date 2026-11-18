'use strict';

const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');
const { NotificationChannelSchema, EnabledSchema } = require('../../shared/schemas');

// groups_json -> group_ids for the UI
const present = (c) => ({ ...c, group_ids: c.groups_json ? JSON.parse(c.groups_json) : null });
const filterJson = (ids) => (ids && ids.length ? JSON.stringify(ids) : null);

module.exports = async function notificationRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/notifications
  app.get('/notifications', auth, async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM notification_channels ORDER BY id ASC').all().map(present);
  });

  // POST /api/admin/notifications
  app.post('/notifications', auth, async (req, reply) => {
    const result = NotificationChannelSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues[0]?.message || 'Invalid request' });

    const { name, type, url, enabled, group_ids, send_recovery } = result.data;
    const db = getDb();
    const info = db.prepare(
      'INSERT INTO notification_channels (name, type, url, enabled, groups_json, send_recovery) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, type, url, enabled ? 1 : 0, filterJson(group_ids), send_recovery ? 1 : 0);
    return present(db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(info.lastInsertRowid));
  });

  // PUT /api/admin/notifications/:id
  app.put('/notifications/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = NotificationChannelSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues[0]?.message || 'Invalid request' });

    const { name, type, url, enabled, group_ids, send_recovery } = result.data;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM notification_channels WHERE id = ?').get(id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.prepare(
      'UPDATE notification_channels SET name = ?, type = ?, url = ?, enabled = ?, groups_json = ?, send_recovery = ? WHERE id = ?'
    ).run(name, type, url, enabled ? 1 : 0, filterJson(group_ids), send_recovery ? 1 : 0, id);
    return present(db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id));
  });

  // PATCH /api/admin/notifications/:id/enabled
  app.patch('/notifications/:id/enabled', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = EnabledSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.issues[0]?.message || 'Invalid request' });

    const db = getDb();
    const info = db.prepare(
      'UPDATE notification_channels SET enabled = ? WHERE id = ?'
    ).run(result.data.enabled ? 1 : 0, id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  // DELETE /api/admin/notifications/:id
  app.delete('/notifications/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    const info = db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  // POST /api/admin/notifications/test-channel — test without a saved channel (used by add modal)
  app.post('/notifications/test-channel', auth, async (req, reply) => {
    const result = NotificationChannelSchema.safeParse({ name: 'test', ...req.body });
    if (!result.success) return reply.status(400).send({ error: result.error.issues[0]?.message || 'Invalid request' });

    const { sendToChannel } = require('../../probe/notifier');
    try {
      await sendToChannel(result.data, {
        target: 'Test Target',
        host: 'example.com',
        group: 'Meridian',
        status: 'DOWN',
        previousStatus: 'UP',
        timestamp: new Date().toISOString(),
      });
      return { ok: true };
    } catch (err) {
      return reply.status(502).send({ error: err.message });
    }
  });

  // POST /api/admin/notifications/:id/test
  app.post('/notifications/:id/test', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    const channel = db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
    if (!channel) return reply.status(404).send({ error: 'Not found' });

    const { sendToChannel, recordDelivery } = require('../../probe/notifier');
    try {
      await sendToChannel(channel, {
        target: 'Test Target',
        host: 'example.com',
        group: 'Meridian',
        status: 'DOWN',
        previousStatus: 'UP',
        timestamp: new Date().toISOString(),
      });
      recordDelivery(channel.id, null);
      return { ok: true };
    } catch (err) {
      recordDelivery(channel.id, err);
      return reply.status(502).send({ error: err.message });
    }
  });
};
