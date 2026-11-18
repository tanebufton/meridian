'use strict';

const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');
const { MaintenanceWindowSchema } = require('../../shared/schemas');
const maintenance = require('../../shared/maintenance');

function decorate(db, w, now) {
  const d = maintenance.describe(w, now);
  let scope_name = 'All targets';
  if (w.scope === 'group') scope_name = db.prepare('SELECT name FROM groups WHERE id = ?').get(w.scope_id)?.name ?? '(deleted group)';
  if (w.scope === 'target') scope_name = db.prepare('SELECT name FROM targets WHERE id = ?').get(w.scope_id)?.name ?? '(deleted target)';
  return {
    ...w,
    scope_name,
    active: !!(d && d.active),
    // For a repeating window this is the current/next occurrence; for one-off, the window itself
    occurrence_start: d ? d.start : null,
    occurrence_end: d ? d.end : null,
    finished: d === null,
  };
}

function scopeExists(db, w) {
  if (w.scope === 'group') return !!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(w.scope_id);
  if (w.scope === 'target') return !!db.prepare('SELECT 1 FROM targets WHERE id = ?').get(w.scope_id);
  return true;
}

module.exports = async function maintenanceRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/maintenance
  app.get('/maintenance', auth, async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    return db.prepare('SELECT * FROM maintenance_windows ORDER BY starts_at DESC').all().map((w) => decorate(db, w, now));
  });

  // POST /api/admin/maintenance
  app.post('/maintenance', auth, async (req, reply) => {
    const parsed = MaintenanceWindowSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const w = parsed.data;
    const db = getDb();
    if (!scopeExists(db, w)) return reply.status(400).send({ error: `That ${w.scope} no longer exists` });

    const info = db.prepare(
      `INSERT INTO maintenance_windows (name, scope, scope_id, starts_at, ends_at, repeat, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(w.name, w.scope, w.scope === 'all' ? null : w.scope_id, w.starts_at, w.ends_at, w.repeat, req.session.username);
    maintenance.invalidate();
    return decorate(db, db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(info.lastInsertRowid), Math.floor(Date.now() / 1000));
  });

  // PUT /api/admin/maintenance/:id
  app.put('/maintenance/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });
    const parsed = MaintenanceWindowSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
    const w = parsed.data;
    const db = getDb();
    if (!scopeExists(db, w)) return reply.status(400).send({ error: `That ${w.scope} no longer exists` });

    const info = db.prepare(
      `UPDATE maintenance_windows SET name=?, scope=?, scope_id=?, starts_at=?, ends_at=?, repeat=? WHERE id=?`
    ).run(w.name, w.scope, w.scope === 'all' ? null : w.scope_id, w.starts_at, w.ends_at, w.repeat, id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    maintenance.invalidate();
    return decorate(db, db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id), Math.floor(Date.now() / 1000));
  });

  // DELETE /api/admin/maintenance/:id  (also how you end a window early)
  app.delete('/maintenance/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });
    const info = getDb().prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    maintenance.invalidate();
    return { ok: true };
  });
};
