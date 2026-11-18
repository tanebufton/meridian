#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

const { getDb, closeDb, dbPath } = require('../server/db/db');
const { LATEST_VERSION, currentVersion, runMigrations } = require('../server/db/migrations');

const schemaSql = fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8');

function run() {
  const db = getDb();

  // Create anything that does not exist yet (every statement is IF NOT EXISTS)
  db.exec(schemaSql);

  const before = currentVersion(db);
  if (before < LATEST_VERSION && fs.existsSync(dbPath) && db.prepare('SELECT COUNT(*) AS n FROM groups').get().n > 0) {
    // Snapshot before changing an existing database. VACUUM INTO is safe on a live WAL db.
    const backup = `${dbPath}.pre-migrate-v${before}-${Date.now()}`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`Backup written: ${backup}`);
  }

  const applied = runMigrations(db, (m) => console.log(m));

  const issues = db.pragma('foreign_key_check');
  if (issues.length) {
    console.error(`WARNING: foreign_key_check reports ${issues.length} problem row(s):`, issues.slice(0, 5));
    process.exitCode = 1;
  }

  // Update query planner statistics so new indexes are used immediately
  db.exec('ANALYZE');

  console.log(applied.length ? `Migration complete (now at v${LATEST_VERSION}).` : `Already up to date (v${LATEST_VERSION}).`);
  closeDb();
}

run();
