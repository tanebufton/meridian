'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, seedTarget, addProbe } = require('./helpers');
const db = freshDb();
const incidents = require('../server/probe/incidents');
const { getStatus } = require('../server/shared/constants');

const settings = { alert_after_failures: 2, recover_after_successes: 1, renotify_minutes: 0 };
const T0 = 1_700_000_000;

function step(target, ts, loss, opts = {}) {
  addProbe(db, target.id, ts, { loss, error: loss >= 100 ? 'ping failed' : null });
  const status = getStatus(loss, null, target.probe_type, loss >= 100);
  return incidents.evaluate(db, target, status, { ...settings, ...opts.settings }, { now: ts, inMaintenance: !!opts.maint });
}

test('one failed probe does not open an incident; two do', () => {
  const t = seedTarget(db);
  assert.deepEqual(step(t, T0, 100), []);
  const ev = step(t, T0 + 60, 100);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'down');
  const inc = db.prepare('SELECT * FROM incidents WHERE target_id=?').get(t.id);
  assert.equal(inc.started_at, T0, 'incident is back-dated to the first failed probe');
  assert.equal(inc.ended_at, null);
});

test('a blip that recovers before confirmation never alerts', () => {
  const t = seedTarget(db);
  assert.deepEqual(step(t, T0, 100), []);
  assert.deepEqual(step(t, T0 + 60, 0), []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM incidents WHERE target_id=?').get(t.id).n, 0);
});

test('recovery closes the incident and reports duration; staying down does not re-alert', () => {
  const t = seedTarget(db);
  step(t, T0, 100); step(t, T0 + 60, 100);
  assert.deepEqual(step(t, T0 + 120, 100), [], 'no repeat alert while still down');
  const ev = step(t, T0 + 180, 0);
  assert.equal(ev[0].kind, 'recovered');
  assert.equal(ev[0].durationSeconds, 180);
  assert.notEqual(db.prepare('SELECT ended_at FROM incidents WHERE target_id=?').get(t.id).ended_at, null);
});

test('maintenance holds the alert, then sends it when the window ends if still down', () => {
  const t = seedTarget(db);
  assert.deepEqual(step(t, T0, 100, { maint: true }), []);
  assert.deepEqual(step(t, T0 + 60, 100, { maint: true }), []);
  const inc = db.prepare('SELECT * FROM incidents WHERE target_id=?').get(t.id);
  assert.equal(inc.maintenance, 1);
  assert.equal(inc.notified_at, null);
  const ev = step(t, T0 + 120, 100);
  assert.equal(ev[0].kind, 'down', 'alert released once maintenance is over');
  assert.deepEqual(step(t, T0 + 180, 100), [], 'and only once');
});

test('an incident that recovered silently during maintenance sends no recovery alert', () => {
  const t = seedTarget(db);
  step(t, T0, 100, { maint: true }); step(t, T0 + 60, 100, { maint: true });
  assert.deepEqual(step(t, T0 + 120, 0, { maint: true }), []);
  assert.notEqual(db.prepare('SELECT ended_at FROM incidents WHERE target_id=?').get(t.id).ended_at, null);
});

test('reminders fire on schedule and stop once acknowledged', () => {
  const t = seedTarget(db);
  const s = { renotify_minutes: 10 };
  step(t, T0, 100, { settings: s }); step(t, T0 + 60, 100, { settings: s });
  assert.deepEqual(step(t, T0 + 300, 100, { settings: s }), [], 'too early');
  const r = step(t, T0 + 700, 100, { settings: s });
  assert.equal(r[0].kind, 'reminder');
  db.prepare('UPDATE incidents SET ack_at=?, ack_by=? WHERE target_id=?').run(T0 + 710, 'me', t.id);
  assert.deepEqual(step(t, T0 + 1400, 100, { settings: s }), [], 'acknowledged: no more reminders');
});

test('DNS targets use dns_success', () => {
  const t = seedTarget(db, { probe_type: 'dns' });
  const run = (ts, ok) => {
    addProbe(db, t.id, ts, { dns: ok ? 1 : 0, error: ok ? null : 'ENOTFOUND' });
    return incidents.evaluate(db, t, ok ? 'UP' : 'DOWN', { ...settings, alert_after_failures: 1 }, { now: ts, inMaintenance: false });
  };
  assert.equal(run(T0, false)[0].kind, 'down');
  assert.equal(run(T0 + 60, true)[0].kind, 'recovered');
});

test('incidents for disabled targets are closed', () => {
  const t = seedTarget(db);
  step(t, T0, 100); step(t, T0 + 60, 100);
  db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(t.id);
  assert.ok(incidents.closeForDisabled(db, T0 + 100) >= 1);
});
