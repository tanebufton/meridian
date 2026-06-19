'use strict';

const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');
const { TargetSchema, EnabledSchema } = require('../../shared/schemas');
const { getStatus } = require('../../shared/constants');

module.exports = async function targetRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/targets
  app.get('/targets', auth, async () => {
    const db = getDb();
    const targets = db.prepare(
      `SELECT t.id, t.group_id, t.name, t.host, t.probe_type, t.interval_seconds,
              t.packet_count, t.enabled, t.created_at, g.name AS group_name,
              pr.latency_avg, pr.packet_loss, pr.dns_success, pr.error, pr.timestamp AS last_checked
       FROM targets t
       JOIN groups g ON g.id = t.group_id
       LEFT JOIN (
         SELECT target_id, latency_avg, packet_loss, dns_success, error, timestamp,
                ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY timestamp DESC) AS rn
         FROM probe_results
       ) pr ON pr.target_id = t.id AND pr.rn = 1
       ORDER BY g.sort_order ASC, t.id ASC`
    ).all();

    return targets.map((t) => ({
      ...t,
      status: getStatus(t.packet_loss, t.dns_success, t.probe_type, !!t.error),
    }));
  });

  // POST /api/admin/targets
  app.post('/targets', auth, async (req, reply) => {
    const result = TargetSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const d = result.data;
    const db = getDb();
    const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(d.group_id);
    if (!group) return reply.status(400).send({ error: 'Group not found' });

    const info = db.prepare(
      `INSERT INTO targets (group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(d.group_id, d.name, d.host, d.probe_type, d.interval_seconds, d.packet_count, d.enabled ? 1 : 0, d.notes ?? null);

    return db.prepare('SELECT * FROM targets WHERE id = ?').get(info.lastInsertRowid);
  });

  // PUT /api/admin/targets/:id
  app.put('/targets/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = TargetSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const d = result.data;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM targets WHERE id = ?').get(id);
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    db.prepare(
      `UPDATE targets SET group_id=?, name=?, host=?, probe_type=?, interval_seconds=?,
       packet_count=?, enabled=?, notes=? WHERE id=?`
    ).run(d.group_id, d.name, d.host, d.probe_type, d.interval_seconds, d.packet_count, d.enabled ? 1 : 0, d.notes ?? null, id);

    return db.prepare('SELECT * FROM targets WHERE id = ?').get(id);
  });

  // DELETE /api/admin/targets/:id
  app.delete('/targets/:id', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    const info = db.prepare('DELETE FROM targets WHERE id = ?').run(id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  // PATCH /api/admin/targets/:id/enabled
  app.patch('/targets/:id/enabled', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const result = EnabledSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const db = getDb();
    const info = db.prepare('UPDATE targets SET enabled = ? WHERE id = ?').run(
      result.data.enabled ? 1 : 0,
      id
    );
    if (info.changes === 0) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  // POST /api/admin/targets/:id/traceroute/run — trigger an immediate traceroute for a target
  app.post('/targets/:id/traceroute/run', auth, async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

    const db = getDb();
    const target = db.prepare('SELECT id, host FROM targets WHERE id = ?').get(id);
    if (!target) return reply.status(404).send({ error: 'Not found' });

    const { traceAndCache } = require('../../probe/traceroute-backfill');
    const hops = await traceAndCache(target);
    return { ok: true, hops };
  });

  // POST /api/admin/targets/bulk — create multiple targets in one transaction
  app.post('/targets/bulk', auth, async (req, reply) => {
    const { z } = require('zod');
    const BulkSchema = z.object({
      targets: z.array(TargetSchema).min(1).max(200),
    });
    const result = BulkSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO targets (group_id, name, host, probe_type, interval_seconds, packet_count, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows) => {
      const ids = [];
      for (const t of rows) {
        const info = insert.run(t.group_id, t.name, t.host, t.probe_type, t.interval_seconds, t.packet_count, t.enabled ? 1 : 0);
        ids.push(info.lastInsertRowid);
      }
      return ids;
    });

    const ids = insertMany(result.data.targets);
    return { inserted: ids.length, ids };
  });

  // POST /api/admin/targets/bulk-interval — apply interval to all targets
  app.post('/targets/bulk-interval', auth, async (req, reply) => {
    const { z } = require('zod');
    const schema = z.object({ interval_seconds: z.number().int().min(5).max(3600) });
    const result = schema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const db = getDb();
    const info = db.prepare('UPDATE targets SET interval_seconds = ?').run(result.data.interval_seconds);
    return { updated: info.changes };
  });
};
