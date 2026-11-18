'use strict';
// Each test file runs in its own process (node --test), so pointing DATABASE_PATH at a
// fresh temp file BEFORE requiring db.js gives it an isolated, fully migrated database.
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  delete require.cache[require.resolve('../server/db/db')];
  const { getDb } = require('../server/db/db');
  const { runMigrations } = require('../server/db/migrations');
  const db = getDb();
  db.exec(fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8'));
  runMigrations(db);
  return db;
}

function seedTarget(db, over = {}) {
  const gid = db.prepare("INSERT INTO groups (name) VALUES ('G')").run().lastInsertRowid;
  const tid = db.prepare(
    `INSERT INTO targets (group_id, name, host, probe_type) VALUES (?, ?, ?, ?)`
  ).run(gid, over.name || 'T', over.host || 'example.com', over.probe_type || 'icmp').lastInsertRowid;
  return { id: Number(tid), group_id: Number(gid), name: 'T', host: 'example.com', probe_type: 'icmp', ...over };
}

function addProbe(db, targetId, ts, { loss = 0, avg = 10, error = null, dns = null } = {}) {
  db.prepare(
    `INSERT INTO probe_results (target_id, timestamp, latency_avg, latency_min, latency_max, packet_loss, dns_success, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(targetId, ts, loss >= 100 ? null : avg, loss >= 100 ? null : avg, loss >= 100 ? null : avg, dns === null ? loss : null, dns, error);
}

module.exports = { freshDb, seedTarget, addProbe };
