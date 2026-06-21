#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { getDb, closeDb } = require('../server/db/db');

const schemaPath = path.join(__dirname, '../server/db/schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

function run() {
  const db = getDb();

  // Execute all statements in the schema (idempotent — all use IF NOT EXISTS)
  const statements = schemaSql
    .split(';')
    .map(s =>
      s
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter(s => s.length > 0);

  const transaction = db.transaction(() => {
    for (const stmt of statements) {
      db.prepare(stmt).run();
    }
  });

  transaction();

  // Add columns that were introduced after initial schema (ALTER TABLE IF NOT EXISTS
  // is not supported in SQLite, so we attempt and swallow the "duplicate column" error)
  const backfillColumns = [
    'ALTER TABLE probe_results ADD COLUMN latency_mdev REAL',
    'ALTER TABLE probe_results ADD COLUMN rtts_json TEXT',
    'ALTER TABLE targets ADD COLUMN notes TEXT',
  ];
  for (const stmt of backfillColumns) {
    try { db.prepare(stmt).run(); } catch { /* column already exists */ }
  }

  // Widen the probe_type CHECK constraint to include 'icmp6'.
  // SQLite does not support ALTER TABLE ... DROP CONSTRAINT, so we recreate the table.
  const constraintRow = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='targets'`
  ).get();
  if (constraintRow && !constraintRow.sql.includes("'icmp6'")) {
    db.pragma('foreign_keys = OFF');
    // legacy_alter_table prevents SQLite 3.26+ from rewriting FK references in
    // dependent tables (probe_results, etc.) to point at the temporary rename
    // target. Without it, those tables end up referencing "_targets_old" which
    // is then dropped, breaking every INSERT into those tables.
    db.pragma('legacy_alter_table = ON');
    db.transaction(() => {
      db.prepare('ALTER TABLE targets RENAME TO _targets_old').run();
      db.prepare(`
        CREATE TABLE targets (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          name             TEXT NOT NULL,
          host             TEXT NOT NULL,
          probe_type       TEXT NOT NULL CHECK(probe_type IN ('icmp', 'icmp6', 'dns')),
          interval_seconds INTEGER NOT NULL DEFAULT 60,
          packet_count     INTEGER NOT NULL DEFAULT 10,
          enabled          INTEGER NOT NULL DEFAULT 1,
          notes            TEXT,
          created_at       INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `).run();
      db.prepare(
        `INSERT INTO targets (id, group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes, created_at)
         SELECT id, group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes, COALESCE(created_at, unixepoch()) FROM _targets_old`
      ).run();
      db.prepare('DROP TABLE _targets_old').run();
    })();
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
    console.log('Migrated targets table: added icmp6 to probe_type CHECK constraint.');
  }

  // Update query planner statistics so new indexes are used immediately
  db.prepare('ANALYZE').run();

  console.log('Migration complete.');
  closeDb();
}

run();
