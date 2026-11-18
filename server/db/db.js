'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ quiet: true });

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/meridian.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL'); // safe with WAL, far fewer fsyncs
  _db.pragma('busy_timeout = 5000');  // three processes share this file
  _db.pragma('foreign_keys = ON');
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Exit with a clear message if the database has not been migrated to the schema this
 * code expects. Called at server start so a missed `npm run migrate` fails loudly
 * instead of producing obscure "no such column" errors at request time.
 */
function requireSchema() {
  const { LATEST_VERSION, currentVersion } = require('./migrations');
  const have = currentVersion(getDb());
  if (have < LATEST_VERSION) {
    console.error(`Database schema is at v${have} but this code needs v${LATEST_VERSION}. Run: npm run migrate`);
    process.exit(1);
  }
}

module.exports = { getDb, closeDb, requireSchema, dbPath };
