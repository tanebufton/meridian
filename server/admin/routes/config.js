'use strict';

const { z } = require('zod');
const { getDb, dbPath } = require('../../db/db');
const { requireAuth } = require('../middleware');
const { PROBE_TYPES } = require('../../shared/schemas');
const { validateHostFor } = require('../../shared/hosts');

const ImportTargetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255),
  probe_type: z.enum(PROBE_TYPES),
  interval_seconds: z.number().int().min(5).max(3600).default(60),
  packet_count: z.number().int().min(1).max(100).default(5),
  enabled: z.boolean().default(true),
  notes: z.string().max(500).optional().nullable(),
  public: z.boolean().default(true),
}).superRefine((t, ctx) => {
  const problem = validateHostFor(t.probe_type, t.host);
  if (problem) ctx.addIssue({ code: 'custom', path: ['host'], message: `${t.name}: ${problem}` });
});

const ImportGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  sort_order: z.number().int().min(0).default(0),
  public: z.boolean().default(true),
  targets: z.array(ImportTargetSchema).default([]),
});

const ImportSchema = z.object({
  version: z.literal(1),
  // merge: add what is missing and leave everything else (and all history) alone.
  // replace: wipe all groups and targets first — this deletes ALL probe history.
  mode: z.enum(['merge', 'replace']).default('merge'),
  groups: z.array(ImportGroupSchema).min(1).max(500),
});

module.exports = async function configRoutes(app) {
  const auth = { preHandler: requireAuth };

  // GET /api/admin/backups: the automatic nightly database backups
  app.get('/backups', auth, async () => {
    const { listBackups, backupDir } = require('../../shared/backup');
    return { dir: backupDir(), keep: require('../../shared/settings').loadSettings().backup_keep, files: listBackups() };
  });

  // POST /api/admin/backups: take one now
  app.post('/backups', auth, async (req, reply) => {
    const { runBackup, listBackups } = require('../../shared/backup');
    const keep = require('../../shared/settings').loadSettings().backup_keep;
    const r = runBackup({ keep: keep > 0 ? keep : 7 });
    return reply.send({ ok: true, file: require('path').basename(r.file), files: listBackups() });
  });

  // GET /api/admin/config/export
  app.get('/config/export', auth, async () => {
    const db = getDb();
    const groups = db.prepare(
      'SELECT id, name, description, sort_order, is_public FROM groups ORDER BY sort_order ASC, id ASC'
    ).all();

    const targets = db.prepare(
      'SELECT group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes, is_public FROM targets ORDER BY id ASC'
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
        public: t.is_public === 1,
      });
    }

    return {
      version: 1,
      exported_at: new Date().toISOString(),
      groups: groups.map((g) => ({
        name: g.name,
        description: g.description || null,
        sort_order: g.sort_order,
        public: g.is_public === 1,
        targets: targetsByGroup[g.id] || [],
      })),
    };
  });

  // POST /api/admin/config/import
  app.post('/config/import', auth, async (req, reply) => {
    const result = ImportSchema.safeParse(req.body);
    if (!result.success) {
      const issue = result.error.issues[0];
      return reply.status(400).send({ error: issue.message || 'Invalid import file', path: issue.path.join('.') });
    }

    const { groups, mode } = result.data;
    const db = getDb();

    let backup = null;
    if (mode === 'replace') {
      // Replacing cascades to every probe result, so keep a restorable copy first
      backup = `${dbPath}.pre-import-${Date.now()}`;
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      require('fs').chmodSync(backup, 0o600); // contains password hashes
    }

    const doImport = db.transaction(() => {
      if (mode === 'replace') {
        db.prepare('DELETE FROM targets').run();
        db.prepare('DELETE FROM groups').run();
      }

      const findGroup = db.prepare('SELECT id FROM groups WHERE name = ?');
      const findTarget = db.prepare('SELECT 1 FROM targets WHERE group_id = ? AND name = ? AND host = ?');
      const addGroup = db.prepare('INSERT INTO groups (name, description, sort_order, is_public) VALUES (?, ?, ?, ?)');
      const addTarget = db.prepare(
        `INSERT INTO targets (group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes, is_public)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      let newGroups = 0, newTargets = 0, skipped = 0;
      groups.forEach((g, i) => {
        let gid = mode === 'merge' ? findGroup.get(g.name)?.id : undefined;
        if (!gid) {
          gid = addGroup.run(g.name, g.description ?? null, g.sort_order ?? i, g.public ? 1 : 0).lastInsertRowid;
          newGroups++;
        }
        for (const t of g.targets) {
          if (mode === 'merge' && findTarget.get(gid, t.name, t.host)) { skipped++; continue; }
          addTarget.run(gid, t.name, t.host, t.probe_type, t.interval_seconds, t.packet_count, t.enabled ? 1 : 0, t.notes ?? null, t.public ? 1 : 0);
          newTargets++;
        }
      });
      return { groups: newGroups, targets: newTargets, skipped };
    });

    return { ok: true, mode, imported: doImport(), backup };
  });
};
