'use strict';

const bcrypt = require('bcrypt');
const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');
const { CreateUserSchema, ChangePasswordSchema } = require('../../shared/schemas');

module.exports = async function userRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/users
  app.get('/users', auth, async () => {
    const db = getDb();
    return db.prepare(
      'SELECT id, username, created_at, last_login FROM admin_users ORDER BY id ASC'
    ).all();
  });

  // POST /api/admin/users
  app.post('/users', auth, async (req, reply) => {
    const result = CreateUserSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const { username, password } = result.data;
    const hash = await bcrypt.hash(password, 12);
    const db = getDb();

    try {
      const info = db.prepare(
        'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)'
      ).run(username, hash);
      return db.prepare(
        'SELECT id, username, created_at FROM admin_users WHERE id = ?'
      ).get(info.lastInsertRowid);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return reply.status(409).send({ error: 'Username already exists' });
      }
      throw err;
    }
  });

  // DELETE /api/admin/users/:id
  app.delete('/users/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    // Prevent deleting yourself
    if (id === req.session.userId) {
      return reply.status(400).send({ error: 'Cannot delete your own account' });
    }

    const db = getDb();
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM admin_users').get();
    if (n <= 1) {
      return reply.status(400).send({ error: 'Cannot delete the only remaining admin user' });
    }

    const info = db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  // PUT /api/admin/users/:id/password
  app.put('/users/:id/password', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = ChangePasswordSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const hash = await bcrypt.hash(result.data.password, 12);
    const db = getDb();
    const info = db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });
};
