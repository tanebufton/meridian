'use strict';

const fs = require('fs');
const path = require('path');
const { getDb, dbPath } = require('../db/db');

// Only files we created are ever listed or pruned: the manual pre-migrate/pre-import copies and anything the
// operator put in the folder are never touched.
const PATTERN = /^meridian-auto-\d{8}-\d{6}\.db$/;
const backupDir = () => path.join(path.dirname(dbPath), 'backups');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function listBackups(dir = backupDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => PATTERN.test(f)).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, size: st.size, at: Math.floor(st.mtimeMs / 1000) };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

/** Delete all but the newest `keep` automatic backups. */
function prune(keep, dir = backupDir()) {
  const old = listBackups(dir).slice(Math.max(0, keep));
  for (const f of old) fs.unlinkSync(path.join(dir, f.name));
  return old.length;
}

/**
 * Write a consistent snapshot of the live database (safe while it is being written to) and prune old ones.
 * keep = 0 turns automatic backups off. Contains password hashes and 2FA secrets, so owner-only.
 */
function runBackup({ keep = 7, dir = backupDir(), now = new Date(), db = getDb() } = {}) {
  if (!(keep > 0)) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `meridian-auto-${stamp(now)}.db`);
  if (fs.existsSync(file)) return { file, skipped: true, pruned: 0 };
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);
  return { file, size: fs.statSync(file).size, pruned: prune(keep, dir) };
}

module.exports = { runBackup, listBackups, prune, backupDir, PATTERN };
