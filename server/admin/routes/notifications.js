'use strict';

const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');
const { NotificationChannelSchema, EnabledSchema } = require('../../shared/schemas');

module.exports = async function notificationRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/notifications
  app.get('/notifications', auth, async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM notification_channels ORDER BY id ASC').all();
  });

  // POST /api/admin/notifications
  app.post('/notifications', auth, async (req, reply) => {
    const result = NotificationChannelSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const { name, type, url, enabled } = result.data;
    const db = getDb();
    const info = db.prepare(
      'INSERT INTO notification_channels (name, type, url, enabled) VALUES (?, ?, ?, ?)'
    ).run(name, type, url, enabled ? 1 : 0);
    return db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(info.lastInsertRowid);
  });

  // PUT /api/admin/notifications/:id
  app.put('/notifications/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = NotificationChannelSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const { name, type, url, enabled } = result.data;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM notification_channels WHERE id = ?').get(id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.prepare(
      'UPDATE notification_channels SET name = ?, type = ?, url = ?, enabled = ? WHERE id = ?'
    ).run(name, type, url, enabled ? 1 : 0, id);
    return db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id);
  });

  // PATCH /api/admin/notifications/:id/enabled
  app.patch('/notifications/:id/enabled', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = EnabledSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

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
    const { z } = require('zod');
    const schema = z.object({
      type: z.enum(['webhook', 'slack', 'discord', 'ntfy', 'telegram']),
      url: z.string().min(1).max(1000),
    });
    const result = schema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

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

    const { sendToChannel } = require('../../probe/notifier');
    try {
      await sendToChannel(channel, {
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
};
