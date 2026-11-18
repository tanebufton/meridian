'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-bk-'));
process.env.DATABASE_PATH = path.join(tmp, 'meridian.db');
const { runBackup, listBackups, prune } = require('../server/shared/backup');

const db = new Database(process.env.DATABASE_PATH);
db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hello')");
const dir = path.join(tmp, 'backups');

test('a backup is a complete, readable copy with owner-only permissions', () => {
  const r = runBackup({ keep: 7, dir, db, now: new Date(2026, 10, 1, 2, 0, 0) });
  assert.match(path.basename(r.file), /^meridian-auto-20261101-020000\.db$/);
  assert.equal(fs.statSync(r.file).mode & 0o077, 0, 'no group/other access: it contains password hashes');
  const copy = new Database(r.file, { readonly: true });
  assert.equal(copy.prepare('SELECT v FROM t').get().v, 'hello');
  copy.close();
});

test('retention keeps the newest N and never touches files it did not create', () => {
  fs.writeFileSync(path.join(dir, 'meridian.db.pre-migrate-v4-123'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  for (let d = 2; d <= 6; d++) runBackup({ keep: 100, dir, db, now: new Date(2026, 10, d, 2, 0, 0) });
  assert.equal(listBackups(dir).length, 6);
  assert.equal(prune(3, dir), 3);
  assert.deepEqual(listBackups(dir).map((f) => f.name.slice(14, 22)), ['20261106', '20261105', '20261104']);
  assert.ok(fs.existsSync(path.join(dir, 'meridian.db.pre-migrate-v4-123')) && fs.existsSync(path.join(dir, 'notes.txt')));
});

test('keep = 0 disables backups, and a repeat in the same second is a no-op', () => {
  assert.equal(runBackup({ keep: 0, dir, db }), null);
  const at = new Date(2026, 10, 9, 2, 0, 0);
  runBackup({ keep: 7, dir, db, now: at });
  assert.equal(runBackup({ keep: 7, dir, db, now: at }).skipped, true);
});
