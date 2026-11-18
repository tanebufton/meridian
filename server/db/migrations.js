'use strict';

// Versioned, idempotent migrations. schema.sql creates anything missing for fresh
// installs (CREATE ... IF NOT EXISTS); the steps below upgrade existing databases.
// Each step must be safe to run against a database that already has its changes.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(db, table, column, ddl) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

const migrations = [
  {
    version: 1,
    name: 'add columns introduced after the original schema',
    up(db) {
      addColumn(db, 'probe_results', 'latency_mdev', 'REAL');
      addColumn(db, 'probe_results', 'rtts_json', 'TEXT');
      addColumn(db, 'targets', 'notes', 'TEXT');
      // Fresh schema.sql had no mdev on aggregates even though the rollups write it
      addColumn(db, 'probe_aggregates', 'latency_mdev', 'REAL');
      addColumn(db, 'probe_aggregates', 'fail_count', 'INTEGER');
    },
  },
  {
    version: 2,
    name: 'drop CHECK constraint on targets.probe_type (validated in the app instead)',
    up(db) {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='targets'`).get();
      if (!row || !/CHECK\s*\(\s*probe_type/i.test(row.sql)) return;

      // SQLite's documented 12-step table rebuild: create new, copy, drop old, rename
      // new. Never rename the OLD table away — that rewrites child FKs to point at the
      // renamed table, which is what corrupted dependent tables previously.
      const seq = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='targets'`).get();
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`CREATE TABLE targets_new (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            name             TEXT NOT NULL,
            host             TEXT NOT NULL,
            probe_type       TEXT NOT NULL,
            interval_seconds INTEGER NOT NULL DEFAULT 60,
            packet_count     INTEGER NOT NULL DEFAULT 10,
            enabled          INTEGER NOT NULL DEFAULT 1,
            notes            TEXT,
            created_at       INTEGER NOT NULL DEFAULT (unixepoch())
          )`);
          db.exec(`INSERT INTO targets_new (id, group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes, created_at)
                   SELECT id, group_id, name, host, probe_type, interval_seconds, packet_count, enabled, notes, COALESCE(created_at, unixepoch()) FROM targets`);
          db.exec('DROP TABLE targets');
          db.exec('ALTER TABLE targets_new RENAME TO targets');
          if (seq) db.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name='targets'`).run(seq.seq);
          const bad = db.pragma('foreign_key_check');
          if (bad.length) throw new Error(`foreign_key_check failed after targets rebuild: ${JSON.stringify(bad.slice(0, 3))}`);
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    },
  },
  {
    version: 3,
    name: 'repair aggregates inflated by repeated startup backfill',
    up(db) {
      // The old backfill ADDED raw sample counts to existing buckets on every probe
      // restart. Rebuild every bucket that raw data still fully covers; older buckets
      // (raw already pruned) cannot be reconstructed and keep their stored values.
      const { rollup5MinSince, rollup1HourSince } = require('../probe/rollup');
      const oldest = db.prepare('SELECT MIN(timestamp) AS m FROM probe_results').get().m;
      if (oldest == null) return;
      const from5 = Math.ceil(oldest / 300) * 300;
      const from1h = Math.ceil(from5 / 3600) * 3600;
      db.transaction(() => {
        rollup5MinSince(db, from5);
        rollup1HourSince(db, from1h);
      })();
    },
  },
  {
    version: 4,
    name: 'two-factor authentication columns on admin_users',
    up(db) {
      addColumn(db, 'admin_users', 'totp_secret', 'TEXT');
      addColumn(db, 'admin_users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'admin_users', 'totp_last_step', 'INTEGER');
      addColumn(db, 'admin_users', 'recovery_codes', 'TEXT');
    },
  },
  {
    version: 5,
    name: 'notification channels: more types, per-channel filters, delivery status',
    up(db) {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_channels'`).get();
      if (row && /CHECK\s*\(\s*type/i.test(row.sql)) {
        // The old CHECK only allowed five channel types. Same safe rebuild as for targets.
        db.pragma('foreign_keys = OFF');
        try {
          db.transaction(() => {
            db.exec(`CREATE TABLE notification_channels_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, url TEXT NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
              groups_json TEXT, send_recovery INTEGER NOT NULL DEFAULT 1,
              last_ok_at INTEGER, last_error TEXT, last_error_at INTEGER)`);
            db.exec(`INSERT INTO notification_channels_new (id, name, type, url, enabled, created_at)
                     SELECT id, name, type, url, enabled, created_at FROM notification_channels`);
            db.exec('DROP TABLE notification_channels');
            db.exec('ALTER TABLE notification_channels_new RENAME TO notification_channels');
          })();
        } finally { db.pragma('foreign_keys = ON'); }
      }
      addColumn(db, 'notification_channels', 'groups_json', 'TEXT');
      addColumn(db, 'notification_channels', 'send_recovery', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'notification_channels', 'last_ok_at', 'INTEGER');
      addColumn(db, 'notification_channels', 'last_error', 'TEXT');
      addColumn(db, 'notification_channels', 'last_error_at', 'INTEGER');
    },
  },
  {
    version: 6,
    name: 'latency percentiles, public/private visibility, route-change tracking',
    up(db) {
      addColumn(db, 'probe_results', 'latency_p50', 'REAL');
      addColumn(db, 'probe_results', 'latency_p95', 'REAL');
      addColumn(db, 'probe_aggregates', 'latency_p50', 'REAL');
      addColumn(db, 'probe_aggregates', 'latency_p95', 'REAL');
      addColumn(db, 'groups', 'is_public', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'targets', 'is_public', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'traceroute_cache', 'as_path_json', 'TEXT');
      addColumn(db, 'traceroute_cache', 'pending_json', 'TEXT');
      addColumn(db, 'traceroute_cache', 'pending_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'traceroute_cache', 'method', 'TEXT');
      addColumn(db, 'traceroute_cache', 'complete', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'traceroute_history', 'as_path_json', 'TEXT');
    },
  },
];

const LATEST_VERSION = migrations[migrations.length - 1].version;

function currentVersion(db) {
  const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`).get();
  if (!t) return 0;
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
}

/** Apply pending migrations in order. Returns the list applied. */
function runMigrations(db, log = () => {}) {
  const have = currentVersion(db);
  const applied = [];
  for (const m of migrations) {
    if (m.version <= have) continue;
    log(`Applying migration ${m.version}: ${m.name}`);
    m.up(db);
    db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name);
    applied.push(m);
  }
  return applied;
}

module.exports = { migrations, LATEST_VERSION, currentVersion, runMigrations, hasColumn };
