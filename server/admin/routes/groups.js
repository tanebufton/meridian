'use strict';

const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');
const { GroupSchema, OrderSchema } = require('../../shared/schemas');

module.exports = async function groupRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/groups
  app.get('/groups', auth, async () => {
    const db = getDb();
    const groups = db.prepare(
      `SELECT g.id, g.name, g.description, g.sort_order, g.created_at,
              COUNT(t.id) AS target_count,
              SUM(CASE WHEN t.enabled = 1 THEN 1 ELSE 0 END) AS enabled_count
       FROM groups g
       LEFT JOIN targets t ON t.group_id = g.id
       GROUP BY g.id
       ORDER BY g.sort_order ASC, g.id ASC`
    ).all();
    return groups;
  });

  // POST /api/admin/groups
  app.post('/groups', auth, async (req, reply) => {
    const result = GroupSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const { name, description, sort_order } = result.data;
    const db = getDb();
    const info = db.prepare(
      'INSERT INTO groups (name, description, sort_order) VALUES (?, ?, ?)'
    ).run(name, description ?? null, sort_order);

    return db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
  });

  // PUT /api/admin/groups/:id
  app.put('/groups/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = GroupSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const { name, description, sort_order } = result.data;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM groups WHERE id = ?').get(id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.prepare(
      'UPDATE groups SET name = ?, description = ?, sort_order = ? WHERE id = ?'
    ).run(name, description ?? null, sort_order, id);

    return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  });

  // DELETE /api/admin/groups/:id
  app.delete('/groups/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    const info = db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  // PATCH /api/admin/groups/:id/enabled — enable or disable all targets in the group
  app.patch('/groups/:id/enabled', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const { EnabledSchema } = require('../../shared/schemas');
    const result = EnabledSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const db = getDb();
    if (!db.prepare('SELECT id FROM groups WHERE id = ?').get(id)) {
      return reply.status(404).send({ error: 'Not found' });
    }
    const { changes } = db.prepare('UPDATE targets SET enabled = ? WHERE group_id = ?').run(
      result.data.enabled ? 1 : 0, id
    );
    return { ok: true, updated: changes };
  });

  // PUT /api/admin/groups/:id/order
  app.put('/groups/:id/order', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = OrderSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const db = getDb();
    const info = db.prepare('UPDATE groups SET sort_order = ? WHERE id = ?').run(result.data.sort_order, id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });
};
