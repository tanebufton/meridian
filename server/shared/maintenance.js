'use strict';

// Maintenance windows. A window covers all targets, one group, or one target, and may
// repeat daily/weekly at the same offset from `starts_at` (UTC arithmetic, so a repeating
// window drifts by an hour across DST changes — set it in UTC if that matters).

const PERIOD = { daily: 86400, weekly: 604800 };

/** Describe a window relative to `now`: whether it is active, when the current/next
 *  occurrence starts and ends. Returns null for a finished one-off window. */
function describe(w, now) {
  const dur = w.ends_at - w.starts_at;
  if (dur <= 0) return null;
  const period = PERIOD[w.repeat];

  if (!period) {
    if (now >= w.ends_at) return null;
    return { active: now >= w.starts_at, start: w.starts_at, end: w.ends_at };
  }

  const len = Math.min(dur, period);
  if (now < w.starts_at) return { active: false, start: w.starts_at, end: w.starts_at + len };
  const offset = (now - w.starts_at) % period;
  const cycleStart = now - offset;
  if (offset < len) return { active: true, start: cycleStart, end: cycleStart + len };
  return { active: false, start: cycleStart + period, end: cycleStart + period + len };
}

function covers(w, target) {
  if (w.scope === 'all') return true;
  if (w.scope === 'group') return w.scope_id === target.group_id;
  if (w.scope === 'target') return w.scope_id === target.id;
  return false;
}

let cache = { at: 0, rows: [] };

/** All windows, cached for a few seconds so hot paths (every probe) stay cheap. */
function allWindows(db, now = Math.floor(Date.now() / 1000), ttl = 10) {
  if (now - cache.at >= ttl || now < cache.at) {
    cache = { at: now, rows: db.prepare('SELECT * FROM maintenance_windows').all() };
  }
  return cache.rows;
}

function invalidate() { cache = { at: 0, rows: [] }; }

/** The active window covering this target right now, or null. */
function activeFor(db, target, now = Math.floor(Date.now() / 1000)) {
  for (const w of allWindows(db, now)) {
    if (!covers(w, target)) continue;
    const d = describe(w, now);
    if (d && d.active) return { ...w, ...d };
  }
  return null;
}

/** Every currently-active window (for the public banner and summary). */
function activeWindows(db, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const w of allWindows(db, now, 0)) {
    const d = describe(w, now);
    if (d && d.active) out.push({ ...w, ...d });
  }
  return out;
}

/** Targets (id → window) currently in maintenance, from a list of {id, group_id}. */
function maintenanceMap(db, targets, now = Math.floor(Date.now() / 1000)) {
  const active = activeWindows(db, now);
  const map = new Map();
  if (active.length === 0) return map;
  for (const t of targets) {
    const w = active.find((x) => covers(x, t));
    if (w) map.set(t.id, w);
  }
  return map;
}

module.exports = { describe, covers, activeFor, activeWindows, maintenanceMap, invalidate };
