'use strict';

const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');
const { AckSchema } = require('../../shared/schemas');

const SELECT = `SELECT i.*, t.name AS target_name, t.host AS target_host, g.name AS group_name
                FROM incidents i
                JOIN targets t ON t.id = i.target_id
                JOIN groups g ON g.id = t.group_id`;

module.exports = async function incidentRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/incidents?status=open|all&limit=50
  app.get('/incidents', auth, async (req) => {
    const db = getDb();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const open = req.query.status === 'open';
    const rows = db.prepare(
      `${SELECT} ${open ? 'WHERE i.ended_at IS NULL' : ''} ORDER BY (i.ended_at IS NULL) DESC, i.started_at DESC LIMIT ?`
    ).all(limit);
    return rows;
  });

  // POST /api/admin/incidents/:id/ack — "I'm on it": silences reminders, shown in the UI
  app.post('/incidents/:id/ack', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });
    const parsed = AckSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });

    const db = getDb();
    const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
    if (!inc) return reply.status(404).send({ error: 'Not found' });
    if (inc.ended_at) return reply.status(409).send({ error: 'That incident has already recovered' });

    db.prepare('UPDATE incidents SET ack_by = ?, ack_at = unixepoch(), ack_note = ? WHERE id = ?')
      .run(req.session.username, parsed.data.note || null, id);
    return db.prepare(`${SELECT} WHERE i.id = ?`).get(id);
  });

  // DELETE /api/admin/incidents/:id/ack
  app.delete('/incidents/:id/ack', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });
    const info = getDb().prepare('UPDATE incidents SET ack_by = NULL, ack_at = NULL, ack_note = NULL WHERE id = ?').run(id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });
};
