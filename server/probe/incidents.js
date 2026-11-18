'use strict';

const { getStatus } = require('../shared/constants');

/**
 * Incident lifecycle, evaluated after every probe. Stateless between runs: everything
 * is derived from the incidents table and the most recent probe results, so a worker
 * restart never loses or duplicates an alert.
 *
 *   open    : the last `alert_after_failures` probes were all DOWN (one lossy probe no
 *             longer pages anyone)
 *   notify  : once per incident, unless a maintenance window covers the target — then
 *             the alert is held and sent if the target is still down when it ends
 *   remind  : optionally every `renotify_minutes` while open and not acknowledged
 *   close   : after `recover_after_successes` consecutive non-DOWN probes; a recovery
 *             alert is sent only if we told someone it went down
 *
 * Returns the notification events to dispatch; all database changes are applied here.
 */
function evaluate(db, target, newStatus, settings, { now, inMaintenance }) {
  const events = [];
  const open = db.prepare(
    'SELECT * FROM incidents WHERE target_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(target.id);

  const recentStatuses = (n) => db.prepare(
    `SELECT packet_loss, dns_success, error, timestamp FROM probe_results
     WHERE target_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?`
  ).all(target.id, n).map((r) => ({
    status: getStatus(r.packet_loss ?? null, r.dns_success ?? null, target.probe_type, !!r.error),
    error: r.error,
    timestamp: r.timestamp,
  }));

  if (!open) {
    if (newStatus !== 'DOWN') return events;
    const need = Math.max(1, settings.alert_after_failures | 0);
    const recent = recentStatuses(need);
    if (recent.length < need || !recent.every((r) => r.status === 'DOWN')) return events;

    const startedAt = recent[recent.length - 1].timestamp;
    const cause = recent[0].error || null;
    const info = db.prepare(
      `INSERT INTO incidents (target_id, started_at, cause, maintenance, notified_at, last_notified_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(target.id, startedAt, cause, inMaintenance ? 1 : 0, inMaintenance ? null : now, inMaintenance ? null : now);

    if (!inMaintenance) {
      events.push({ kind: 'down', incidentId: info.lastInsertRowid, startedAt, cause, durationSeconds: now - startedAt });
    }
    return events;
  }

  if (newStatus !== 'DOWN') {
    const need = Math.max(1, settings.recover_after_successes | 0);
    const recent = recentStatuses(need);
    const recovered = recent.length >= need && recent.every((r) => r.status === 'UP' || r.status === 'DEGRADED');
    if (recovered) {
      db.prepare('UPDATE incidents SET ended_at = ? WHERE id = ?').run(now, open.id);
      if (open.notified_at) {
        events.push({ kind: 'recovered', incidentId: open.id, startedAt: open.started_at, durationSeconds: now - open.started_at });
      }
    }
    return events;
  }

  // Still down
  if (inMaintenance) return events;

  if (!open.notified_at) {
    // The incident began (or continued) under a maintenance window that has now ended
    db.prepare('UPDATE incidents SET notified_at = ?, last_notified_at = ? WHERE id = ?').run(now, now, open.id);
    events.push({ kind: 'down', incidentId: open.id, startedAt: open.started_at, cause: open.cause, durationSeconds: now - open.started_at });
  } else if (!open.ack_at && settings.renotify_minutes > 0 && now - open.last_notified_at >= settings.renotify_minutes * 60) {
    db.prepare('UPDATE incidents SET last_notified_at = ? WHERE id = ?').run(now, open.id);
    events.push({ kind: 'reminder', incidentId: open.id, startedAt: open.started_at, cause: open.cause, durationSeconds: now - open.started_at });
  }
  return events;
}

/** Close incidents for targets that were disabled, so they don't stay "open" forever. */
function closeForDisabled(db, now) {
  return db.prepare(
    `UPDATE incidents SET ended_at = ?
     WHERE ended_at IS NULL AND target_id IN (SELECT id FROM targets WHERE enabled = 0)`
  ).run(now).changes;
}

module.exports = { evaluate, closeForDisabled };
