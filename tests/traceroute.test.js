'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, seedTarget } = require('./helpers');
const db = freshDb();
const tr = require('../server/probe/traceroute');
const asn = require('../server/probe/asn');
const route = require('../server/probe/route');
const { traceAndCache } = require('../server/probe/traceroute-backfill');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

// ── parser ──────────────────────────────────────────────────────────────────
test('parses a real ICMP traceroute: private hop hidden, silent hops are timeouts, destination detected', () => {
  const { hops, destIp } = tr.parseOutput(fx('traceroute-github-icmp.txt'));
  assert.equal(destIp, '4.195.217.80');
  assert.equal(hops[0].hidden, true, '192.168.4.1 is private');
  assert.equal(hops[0].ip, null);
  assert.equal(hops[1].ip, '103.241.56.99');
  assert.deepEqual(hops[1].rtts, [3.053, 3.039, 3.025]);
  assert.equal(hops[8].timeout, true);
  assert.equal(hops[8].rtts.length, 3);
  assert.equal(hops[10].ip, '51.10.4.126');
  assert.equal(hops.length, 16);
});

test('keeps every reply on a load-balanced hop (ECMP) instead of only the first', () => {
  const h = tr.parseLine(' 8  10.9.0.1  1.0 ms 203.0.113.5  4.1 ms 203.0.113.6  4.3 ms  203.0.113.5  4.0 ms');
  assert.deepEqual(h.ips.sort(), ['203.0.113.5', '203.0.113.6']);
  assert.equal(h.ecmp, true);
  assert.equal(h.ip, '203.0.113.5', 'most frequent responder is primary');
  const plain = tr.parseLine(' 5  8.8.8.8  10.1 ms  10.2 ms  10.0 ms');
  assert.equal(plain.ecmp, false);
  assert.deepEqual(plain.rtts, [10.1, 10.2, 10.0]);
});

test('IPv6 hops, partial replies and annotations', () => {
  const v6 = tr.parseLine(' 3  2001:db8:1::1  5.2 ms  5.1 ms  5.0 ms');
  assert.equal(v6.ip, '2001:db8:1::1');
  const partial = tr.parseLine(' 6  198.51.100.7  9.0 ms * 9.2 ms');
  assert.deepEqual(partial.rtts, [9.0, null, 9.2]);
  assert.equal(partial.timeout, false);
  assert.equal(tr.parseLine('traceroute to x (1.2.3.4), 25 hops max'), null);
});

test('reached(): only true when the last answering hop is the destination', () => {
  const full = tr.parseOutput(fx('traceroute-adguard-icmp.txt'));
  assert.equal(tr.reached(full), true);
  assert.equal(tr.reached(tr.parseOutput(fx('traceroute-github-icmp.txt'))), true, 'the ICMP run reached it');
  const lines = fx('traceroute-github-icmp.txt').trim().split('\n');
  const cut = tr.parseOutput(lines.slice(0, -4).join('\n')); // same trace, final hops lost
  assert.equal(tr.reached(cut), false);
});

// ── ASN lookup ──────────────────────────────────────────────────────────────
test('ASN: cache keys, DNS names (v4 and v6) and TXT parsing', () => {
  assert.deepEqual(asn.keyFor('8.8.4.4'), { prefix: '8.8.4.0/24', qname: '4.8.8.origin.asn.cymru.com' });
  const k6 = asn.keyFor('2606:4700:4700::1111');
  assert.equal(k6.prefix, '2606:4700:4700::/48');
  assert.equal(k6.qname, '0.0.7.4.0.0.7.4.6.0.6.2.origin6.asn.cymru.com');
  assert.deepEqual(asn.parseOrigin('15169 | 8.8.8.0/24 | US | arin | 2023-12-28'), { asn: 15169, bgpPrefix: '8.8.8.0/24', cc: 'US' });
  assert.equal(asn.parseOrigin('13335 15169 | 1.1.1.0/24 | AU | apnic | 2011').asn, 13335, 'multi-origin: first wins');
  assert.deepEqual(asn.parseAsName('15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US'), { cc: 'US', name: 'GOOGLE - Google LLC, US' });
  assert.equal(asn.keyFor('not-an-ip'), null);
});

test('ASN: one lookup per /24, cached afterwards, failures not cached, misses cached', async () => {
  let origin = 0, names = 0;
  const resolver = {
    origin: async (q) => { origin++; if (q.startsWith('9.9.9')) { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } if (q.startsWith('5.5.5')) { const e = new Error('x'); e.code = 'ETIMEOUT'; throw e; } return '64500 | 203.0.113.0/24 | NZ | apnic | 2020'; },
    asName: async () => { names++; return '64500 | NZ | apnic | 2020 | EXAMPLE-NET - Example Net, NZ'; },
  };
  const m = await asn.lookupAsns(db, ['203.0.113.1', '203.0.113.99'], { resolver });
  assert.equal(origin, 1, 'two addresses, one /24, one DNS lookup');
  assert.equal(m.get('203.0.113.99').asn, 64500);
  assert.match(m.get('203.0.113.1').name, /EXAMPLE-NET/);
  await asn.lookupAsns(db, ['203.0.113.50'], { resolver });
  assert.equal(origin, 1, 'cached');
  assert.equal(names, 1);
  // transient failure (timeout) is not cached; NXDOMAIN is
  await asn.lookupAsns(db, ['5.5.5.5'], { resolver }); await asn.lookupAsns(db, ['5.5.5.5'], { resolver });
  assert.equal(origin, 3, 'timeouts are retried');
  await asn.lookupAsns(db, ['9.9.9.9'], { resolver }); const before = origin; await asn.lookupAsns(db, ['9.9.9.9'], { resolver });
  assert.equal(origin, before, 'an NXDOMAIN miss is remembered');
});

// ── route-change rules ──────────────────────────────────────────────────────
const P = (...p) => ({ path: p, complete: true });
test('same AS path = no change, however the individual routers differ', () => {
  assert.equal(route.routeChanged(P(9500, 4637, 15169), P(9500, 4637, 15169)), false);
});
test('a different transit provider on complete runs IS a change', () => {
  assert.equal(route.routeChanged(P(9500, 4637, 15169), P(9500, 3356, 15169)), true);
});
test('a run cut short by silent routers is not a change (subsequence), but a genuine reroute still is', () => {
  const full = P(9500, 4637, 15169, 8075);
  assert.equal(route.routeChanged(full, { path: [9500, 4637, 8075], complete: false }), false);
  assert.equal(route.routeChanged(full, { path: [9500, 3356, 8075], complete: false }), true);
});
test('a trace that merely got one network further is not a change (single-AS path vs longer)', () => {
  assert.equal(route.routeChanged({ path: [55850], complete: false }, { path: [55850, 2713], complete: false }), false);
  assert.equal(route.routeChanged({ path: [55850], complete: true }, { path: [4637], complete: true }), true);
});
test('asPath collapses repeats and skips hidden/unknown/timeout hops', () => {
  const hops = [{ hidden: true }, { asn: 9500 }, { asn: 9500 }, { timeout: true }, { asn: null }, { asn: 4637 }, { asn: 9500 }];
  assert.deepEqual(route.asPath(hops), [9500, 4637, 9500]);
});
test('without AS data, falls back to /24 sets: ECMP neighbours are the same, different networks differ', () => {
  const a = [{ ips: ['203.0.113.5'] }, { ips: ['198.51.100.1'] }];
  const sameNets = [{ ips: ['203.0.113.77'] }, { ips: ['198.51.100.200'] }];
  const other = [{ ips: ['192.0.2.1'] }, { ips: ['100.64.9.9'.replace('100.64', '172.217')] }];
  assert.equal(route.routeChanged({ path: [], hops: a }, { path: [], hops: sameNets }), false);
  assert.equal(route.routeChanged({ path: [], hops: a }, { path: [], hops: other }), true);
});

// ── record-or-ignore flow ───────────────────────────────────────────────────
const hop = (n, ip, asnNo) => ({ hop: n, ip, ips: [ip], ecmp: false, rtts: [1, 1, 1], timeout: false, hidden: false, rdns: null, asn: asnNo });
const run = (asns, complete = true) => ({ hops: asns.map((a, i) => hop(i + 1, `203.0.113.${i + 1}`, a)), method: 'icmp', complete });
const deps = (seq) => ({ runTraceroute: async () => seq.shift(), annotateHops: async (_d, h) => h });
const history = (id) => db.prepare('SELECT * FROM traceroute_history WHERE target_id=? ORDER BY id').all(id);

test('first run records a baseline; identical and ECMP-only runs add nothing', async () => {
  const t = seedTarget(db);
  await traceAndCache(t, null, deps([run([9500, 4637, 15169])]));
  assert.equal(history(t.id).length, 1);
  await traceAndCache(t, null, deps([run([9500, 4637, 15169]), run([9500, 4637, 15169])]));
  await traceAndCache(t, null, deps([run([9500, 4637, 15169])]));
  assert.equal(history(t.id).length, 1);
});

test('a change must be confirmed: one odd run is forgotten, two matching runs are recorded', async () => {
  const t = seedTarget(db);
  await traceAndCache(t, null, deps([run([9500, 4637, 15169])]));
  // odd one-off
  await traceAndCache(t, null, deps([run([9500, 3356, 15169])]));
  assert.equal(history(t.id).length, 1, 'not recorded yet');
  assert.equal(db.prepare('SELECT pending_count FROM traceroute_cache WHERE target_id=?').get(t.id).pending_count, 1);
  await traceAndCache(t, null, deps([run([9500, 4637, 15169])]));
  assert.equal(db.prepare('SELECT pending_count FROM traceroute_cache WHERE target_id=?').get(t.id).pending_count, 0, 'reverted: pending cleared');
  assert.equal(history(t.id).length, 1, 'the blip left no trace');
  // real, persistent change
  await traceAndCache(t, null, deps([run([9500, 3356, 15169])]));
  await traceAndCache(t, null, deps([run([9500, 3356, 15169])]));
  const h = history(t.id);
  assert.equal(h.length, 2);
  assert.deepEqual(JSON.parse(h[1].as_path_json).path, [9500, 3356, 15169]);
  // and it is not recorded a third time
  await traceAndCache(t, null, deps([run([9500, 3356, 15169])]));
  assert.equal(history(t.id).length, 2);
});

test('the cache always shows the latest run, with method and completeness', async () => {
  const t = seedTarget(db);
  await traceAndCache(t, null, deps([run([9500, 4637], false)]));
  const c = db.prepare('SELECT method, complete, result_json FROM traceroute_cache WHERE target_id=?').get(t.id);
  assert.equal(c.method, 'icmp'); assert.equal(c.complete, 0); assert.equal(JSON.parse(c.result_json).length, 2);
});

test('a host that drops probes still counts as complete when the path reaches its network', async () => {
  const t = seedTarget(db);
  const filtered = { ...run([9500, 4637, 15169], false), destIp: '203.0.113.99' };
  await traceAndCache(t, null, { ...deps([filtered]), lookupDest: async () => 15169 });
  assert.equal(db.prepare('SELECT complete FROM traceroute_cache WHERE target_id=?').get(t.id).complete, 1, 'reached AS15169, the destination network');

  const t2 = seedTarget(db);
  const stoppedShort = { ...run([9500, 4637], false), destIp: '203.0.113.99' };
  await traceAndCache(t2, null, { ...deps([stoppedShort]), lookupDest: async () => 15169 });
  assert.equal(db.prepare('SELECT complete FROM traceroute_cache WHERE target_id=?').get(t2.id).complete, 0, 'stopped before the destination network');

  const t3 = seedTarget(db);
  await traceAndCache(t3, null, { ...deps([{ ...run([9500, 15169], false), destIp: '203.0.113.99' }]), lookupDest: async () => { throw new Error('dns down'); } });
  assert.equal(db.prepare('SELECT complete FROM traceroute_cache WHERE target_id=?').get(t3.id).complete, 0, 'a failed lookup never turns into a false "complete"');
});

test('route-change notification fires once, only for a CONFIRMED change, and only when enabled', async () => {
  const { saveSettings } = require('../server/shared/settings');
  const fired = [];
  const withNotify = (seq) => ({ ...deps(seq), fireRouteChange: async (e) => { fired.push(e); } });
  const t = seedTarget(db);

  saveSettings({ notify_route_changes: false });
  await traceAndCache(t, null, withNotify([run([9500, 4637, 15169])]));
  await traceAndCache(t, null, withNotify([run([9500, 3356, 15169])]));
  await traceAndCache(t, null, withNotify([run([9500, 3356, 15169])]));
  assert.equal(fired.length, 0, 'disabled: confirmed change is recorded but nobody is told');
  assert.equal(history(t.id).length, 2);

  saveSettings({ notify_route_changes: true });
  const t2 = seedTarget(db);
  await traceAndCache(t2, null, withNotify([run([9500, 4637, 15169])]));
  assert.equal(fired.length, 0, 'the first (baseline) trace is not a change');
  await traceAndCache(t2, null, withNotify([run([9500, 3356, 15169])]));
  assert.equal(fired.length, 0, 'one sighting is only suspected');
  await traceAndCache(t2, null, withNotify([run([9500, 4637, 15169])]));
  assert.equal(fired.length, 0, 'a blip that reverts is never announced');
  await traceAndCache(t2, null, withNotify([run([9500, 3356, 15169])]));
  await traceAndCache(t2, null, withNotify([run([9500, 3356, 15169])]));
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].prevPath, [9500, 4637, 15169]); assert.deepEqual(fired[0].newPath, [9500, 3356, 15169]);
  await traceAndCache(t2, null, withNotify([run([9500, 3356, 15169])]));
  assert.equal(fired.length, 1, 'and not again while the route stays the same');
  saveSettings({});
});
