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

  // Update query planner statistics so new indexes are used immediately
  db.prepare('ANALYZE').run();

  console.log('Migration complete.');
  closeDb();
}

run();
