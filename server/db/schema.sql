PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS targets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  host             TEXT NOT NULL,
  probe_type       TEXT NOT NULL CHECK(probe_type IN ('icmp', 'dns')),
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  packet_count     INTEGER NOT NULL DEFAULT 10,
  enabled          INTEGER NOT NULL DEFAULT 1,
  notes            TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS probe_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id     INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  timestamp     INTEGER NOT NULL DEFAULT (unixepoch()),
  latency_min   REAL,
  latency_avg   REAL,
  latency_max   REAL,
  latency_mdev  REAL,
  packet_loss   REAL,
  rtts_json     TEXT,
  dns_time      REAL,
  dns_success   INTEGER,
  resolved_ip   TEXT,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS probe_aggregates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id     INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  period_start  INTEGER NOT NULL,
  resolution    TEXT NOT NULL CHECK(resolution IN ('5min', '1hour')),
  latency_min   REAL,
  latency_avg   REAL,
  latency_max   REAL,
  packet_loss   REAL,
  sample_count  INTEGER NOT NULL,
  UNIQUE(target_id, period_start, resolution)
);

CREATE TABLE IF NOT EXISTS target_uptime (
  target_id   INTEGER PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  uptime_24h  REAL,
  uptime_7d   REAL,
  uptime_30d  REAL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login    INTEGER
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Traceroute results cache (one row per target, refreshed ~daily)
CREATE TABLE IF NOT EXISTS traceroute_cache (
  target_id   INTEGER PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  ran_at      INTEGER NOT NULL
);

-- Traceroute path-change history (one row per dramatic route change)
CREATE TABLE IF NOT EXISTS traceroute_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id   INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  ran_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traceroute_history_target_ran_at ON traceroute_history(target_id, ran_at DESC);

-- Per-target time-range queries (uptime recalc, chart data for 1h/6h/12h)
CREATE INDEX IF NOT EXISTS idx_probe_results_target_timestamp ON probe_results(target_id, timestamp DESC);

-- Retention cleanup: DELETE FROM probe_results WHERE timestamp < ?
-- Also improves rollup cross-target timestamp scan
CREATE INDEX IF NOT EXISTS idx_probe_results_timestamp ON probe_results(timestamp);

-- Per-target per-resolution range queries (24h/7d/30d chart data)
-- Column order: target_id → resolution → period_start lets SQLite satisfy
-- all three predicates without a separate filter pass
CREATE INDEX IF NOT EXISTS idx_probe_aggregates_target_res_period ON probe_aggregates(target_id, resolution, period_start DESC);

-- Cross-target resolution scan used by rollup1Hour and backfill
-- Fixes the SCAN + TEMP B-TREE that shows up in EXPLAIN QUERY PLAN
CREATE INDEX IF NOT EXISTS idx_probe_aggregates_resolution_period ON probe_aggregates(resolution, period_start DESC);

