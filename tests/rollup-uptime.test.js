'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, seedTarget, addProbe } = require('./helpers');
const db = freshDb();
const rollup = require('../server/probe/rollup');
const uptime = require('../server/probe/uptime');

const now = Math.floor(Date.now() / 1000);
const total5 = (id) => db.prepare("SELECT SUM(sample_count) s FROM probe_aggregates WHERE target_id=? AND resolution='5min'").get(id).s;

test('backfill is idempotent (previously inflated counts on every restart)', () => {
  const t = seedTarget(db);
  for (let i = 0; i < 100; i++) addProbe(db, t.id, now - 3000 + i * 30, { loss: i % 10 === 0 ? 100 : 0 });
  rollup.backfillAggregates();
  const first = total5(t.id);
  assert.equal(first, 100);
  rollup.backfillAggregates(); rollup.backfillAggregates();
  assert.equal(total5(t.id), 100);
  rollup.rollup5Min(); rollup.rollup1Hour();
  assert.equal(total5(t.id), 100);
});

test('fail_count tracks fully failed probes and rolls up into hours', () => {
  const t = seedTarget(db);
  const base = Math.floor((now - 3 * 3600) / 3600) * 3600;
  for (let i = 0; i < 12; i++) addProbe(db, t.id, base + i * 300 + 10, { loss: i < 3 ? 100 : 0 });
  rollup.backfillAggregates();
  const h = db.prepare("SELECT sample_count, fail_count FROM probe_aggregates WHERE target_id=? AND resolution='1hour' AND period_start=?").get(t.id, base);
  assert.deepEqual({ ...h }, { sample_count: 12, fail_count: 3 });
});

test('uptime stitches raw + 5min + 1hour tiers without double counting', () => {
  const t = seedTarget(db);
  // 10 days of hourly probes, the most recent 2 days down for 1 probe in 4
  const rows = [];
  for (let h = 10 * 24; h >= 0; h--) rows.push(now - h * 3600 - 5);
  rows.forEach((ts, i) => addProbe(db, t.id, ts, { loss: ts > now - 2 * 86400 && i % 4 === 0 ? 100 : 0 }));
  rollup.backfillAggregates();

  const expect = (windowSec) => {
    const r = db.prepare(
      `SELECT COUNT(*) n, SUM(packet_loss>=100) f FROM probe_results WHERE target_id=? AND timestamp>=?`
    ).get(t.id, now - windowSec);
    return ((r.n - r.f) / r.n) * 100;
  };
  uptime.recalcUptime(t.id, 'icmp', now);
  const u = db.prepare('SELECT * FROM target_uptime WHERE target_id=?').get(t.id);
  assert.ok(Math.abs(u.uptime_24h - expect(86400)) < 0.001, `24h ${u.uptime_24h} vs ${expect(86400)}`);
  // longer windows come from buckets, so allow for the ≤1h edge of the oldest bucket
  assert.ok(Math.abs(u.uptime_7d - expect(7 * 86400)) < 1, `7d ${u.uptime_7d} vs ${expect(7 * 86400)}`);
  assert.ok(Math.abs(u.uptime_30d - expect(30 * 86400)) < 1, `30d ${u.uptime_30d} vs ${expect(30 * 86400)}`);
});

test('30-day uptime survives raw data being pruned', () => {
  const t = seedTarget(db);
  for (let h = 20 * 24; h >= 0; h--) addProbe(db, t.id, now - h * 3600 - 5, { loss: h % 5 === 0 ? 100 : 0 });
  rollup.backfillAggregates();
  db.prepare('DELETE FROM probe_results WHERE target_id=? AND timestamp < ?').run(t.id, now - 3 * 86400);
  uptime.recalcUptime(t.id, 'icmp', now);
  const u = db.prepare('SELECT uptime_30d FROM target_uptime WHERE target_id=?').get(t.id);
  assert.ok(Math.abs(u.uptime_30d - 80) < 1.5, `got ${u.uptime_30d}`);
});
