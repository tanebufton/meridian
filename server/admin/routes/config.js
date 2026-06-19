'use strict';

const { z } = require('zod');
const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');

const ImportTargetSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  probe_type: z.enum(['icmp', 'dns']),
  interval_seconds: z.number().int().min(5).max(3600).default(60),
  packet_count: z.number().int().min(1).max(100).default(5),
  enabled: z.boolean().default(true),
  notes: z.string().max(500).optional().nullable(),
});

const ImportGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  sort_order: z.number().int().min(0).default(0),
  targets: z.array(ImportTargetSchema).default([]),
});

const ImportSchema = z.object({
  version: z.literal(1),
  groups: z.array(ImportGroupSchema).min(1).max(500),
});

module.exports = async function configRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/config/export
  app.get('/config/export', auth, async () => {
    const db = getDb();
    const groups = db.prepare(
      'SELECT id, name, description, sort_order FROM groups ORDER BY sort_order ASC, id ASC'
    ).all();

    const targets = db.prepare(
      'SELECT group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes FROM targets ORDER BY id ASC'
    ).all();

    const targetsByGroup = {};
    for (const t of targets) {
      if (!targetsByGroup[t.group_id]) targetsByGroup[t.group_id] = [];
      targetsByGroup[t.group_id].push({
        name: t.name,
        host: t.host,
        probe_type: t.probe_type,
        interval_seconds: t.interval_seconds,
        packet_count: t.packet_count,
        enabled: t.enabled === 1,
        notes: t.notes || null,
      });
    }

    return {
      version: 1,
      exported_at: new Date().toISOString(),
      groups: groups.map((g) => ({
        name: g.name,
        description: g.description || null,
        sort_order: g.sort_order,
        targets: targetsByGroup[g.id] || [],
      })),
    };
  });

  // POST /api/admin/config/import
  app.post('/config/import', auth, async (req, reply) => {
    const result = ImportSchema.safeParse(req.body);
    if (!result.success) return reply.status(400).send({ error: result.error.flatten() });

    const { groups } = result.data;
    const db = getDb();

    const doImport = db.transaction(() => {
      db.prepare('DELETE FROM targets').run();
      db.prepare('DELETE FROM groups').run();

      let totalTargets = 0;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const gInfo = db.prepare(
          'INSERT INTO groups (name, description, sort_order) VALUES (?, ?, ?)'
        ).run(g.name, g.description ?? null, g.sort_order ?? i);

        for (const t of g.targets) {
          db.prepare(
            `INSERT INTO targets (group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            gInfo.lastInsertRowid, t.name, t.host, t.probe_type,
            t.interval_seconds, t.packet_count, t.enabled ? 1 : 0, t.notes ?? null
          );
          totalTargets++;
        }
      }
      return { groups: groups.length, targets: totalTargets };
    });

    const counts = doImport();
    return { ok: true, imported: counts };
  });
};
