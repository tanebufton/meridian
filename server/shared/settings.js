'use strict';

// Single source of truth for runtime settings (data/settings.json overrides on top of
// env defaults). Replaces four copies of the same loader. The parsed file is cached
// and re-read only when its mtime changes, so it is cheap to call on hot paths.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

function settingsFile() {
  return path.resolve(
    process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
    'settings.json'
  );
}

function envInt(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function defaults() {
  return {
    retention_raw_days: envInt('RETENTION_RAW_DAYS', 7),
    retention_5min_days: envInt('RETENTION_5MIN_DAYS', 30),
    retention_1hour_days: envInt('RETENTION_1HOUR_DAYS', 365),
    default_probe_interval: envInt('DEFAULT_PROBE_INTERVAL', 60),
    default_packet_count: envInt('DEFAULT_PACKET_COUNT', 10),
    // Alerting
    alert_after_failures: 2,      // consecutive DOWN probes before an incident opens / alert fires
    recover_after_successes: 1,   // consecutive non-DOWN probes before an incident closes
    renotify_minutes: 0,          // re-alert on still-open, unacknowledged incidents (0 = off)
    // Traceroute: 'auto' tries ICMP, then TCP, then UDP (UDP alone reaches few destinations)
    traceroute_method: 'auto',
    notify_route_changes: false,  // tell chat channels when a confirmed route change is recorded
    route_confirm_runs: 2,        // a changed AS path must be seen this many runs in a row to be recorded
    // Public banner
    banner_enabled: false,
    banner_text: null,
    banner_type: 'info',
    public_base_url: null,
  };
}

let cache = { file: null, mtimeMs: -1, overrides: {} };

function readOverrides() {
  const file = settingsFile();
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { cache = { file, mtimeMs: 0, overrides: {} }; return cache.overrides; }
  if (cache.file === file && cache.mtimeMs === mtimeMs) return cache.overrides;
  let overrides;
  try { overrides = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { overrides = {}; }
  cache = { file, mtimeMs, overrides };
  return overrides;
}

function loadSettings() {
  return { ...defaults(), ...readOverrides() };
}

// Atomic write (tmp + rename) so a concurrent reader in another process never sees a
// half-written file.
function saveSettings(settings) {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
  cache.mtimeMs = -1;
}

module.exports = { loadSettings, saveSettings, settingsFile };
