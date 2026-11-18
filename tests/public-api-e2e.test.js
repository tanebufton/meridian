'use strict';
// Boots the real public API and checks (a) the endpoints work and (b) private groups/targets leak nowhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pub-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const env = { ...process.env, DATABASE_PATH: path.join(dir, 'p.db'), PUBLIC_PORT: String(PORT), PUBLIC_HOST: '127.0.0.1', NODE_ENV: 'production', TRUST_CF_HEADERS: 'false', TRUSTED_PROXIES: '', METRICS_TOKEN: '' };
process.env.DATABASE_PATH = env.DATABASE_PATH;
let server;
const get = async (u) => { const r = await fetch(BASE + u); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers }; };

const ids = {};
test.before(async () => {
  assert.equal(spawnSync('node', ['scripts/migrate.js'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  const db = require('../server/db/db').getDb();
  const now = Math.floor(Date.now() / 1000);
  const grp = (name, pub) => db.prepare('INSERT INTO groups (name, is_public) VALUES (?, ?)').run(name, pub).lastInsertRowid;
  const tgt = (g, name, host, pub) => db.prepare('INSERT INTO targets (group_id, name, host, probe_type, is_public) VALUES (?, ?, ?, ?, ?)').run(g, name, host, 'icmp', pub).lastInsertRowid;
  ids.pubG = Number(grp('Public Group', 1)); ids.privG = Number(grp('Tailnet', 0));
  ids.pub = Number(tgt(ids.pubG, 'Visible', '8.8.8.8', 1));
  ids.hiddenT = Number(tgt(ids.pubG, 'Hidden Target', '10.9.9.9', 0));
  ids.inPriv = Number(tgt(ids.privG, 'In Private Group', '100.64.1.1', 1));
  for (const id of [ids.pub, ids.hiddenT, ids.inPriv]) {
    for (let i = 0; i < 5; i++) db.prepare('INSERT INTO probe_results (target_id, timestamp, latency_min, latency_avg, latency_max, latency_p50, latency_p95, packet_loss) VALUES (?, ?, 9, 10, 12, 10, 11.5, 0)').run(id, now - i * 60);
    db.prepare('INSERT INTO incidents (target_id, started_at, ended_at, notified_at) VALUES (?, ?, ?, ?)').run(id, now - 7200, now - 3600, now - 7200);
    db.prepare('INSERT INTO traceroute_cache (target_id, result_json, ran_at) VALUES (?, ?, ?)').run(id, '[]', now);
  }
  db.prepare("INSERT INTO maintenance_windows (name, scope, scope_id, starts_at, ends_at) VALUES ('Secret tailnet work', 'group', ?, ?, ?)").run(ids.privG, now - 60, now + 3600);
  db.prepare("INSERT INTO maintenance_windows (name, scope, scope_id, starts_at, ends_at) VALUES ('Visible work', 'target', ?, ?, ?)").run(ids.pub, now - 60, now + 3600);
  // Routing summary fixtures: two public targets via different carriers (one direct), plus private ones that must not count
  ids.pub2 = Number(tgt(ids.pubG, 'Second Visible', '8.8.4.4', 1));
  const cache = (id, path) => db.prepare("INSERT OR REPLACE INTO traceroute_cache (target_id, result_json, ran_at, as_path_json, method, complete) VALUES (?, '[]', ?, ?, 'icmp', 1)").run(id, now, JSON.stringify({ path }));
  cache(ids.pub, [55850, 4637, 15169]);
  cache(ids.pub2, [55850, 15169]);
  cache(ids.hiddenT, [55850, 3356, 999]);
  cache(ids.inPriv, [55850, 3356, 999]);
  db.prepare("INSERT INTO asn_info (asn, name, cc, fetched_at) VALUES (4637, 'ASN-TELSTRA - Telstra Global, HK', 'HK', ?)").run(now);
  db.prepare('INSERT INTO traceroute_history (target_id, result_json, ran_at, as_path_json) VALUES (?, ?, ?, ?)').run(ids.pub, '[]', now - 5000, JSON.stringify({ path: [9500, 15169] }));
  db.prepare('INSERT INTO traceroute_history (target_id, result_json, ran_at, as_path_json) VALUES (?, ?, ?, ?)').run(ids.pub, '[]', now - 1000, JSON.stringify({ path: [9500, 3356, 15169] }));
  db.close?.();

  fs.mkdirSync(path.join(root, 'apps/public/dist'), { recursive: true });
  server = spawn('node', ['server/api/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('api did not start');
});
test.after(() => server?.kill());

test('security headers: scripts are same-origin only; unsafe-inline is never allowed for scripts', async () => {
  const csp = (await get('/health')).headers.get('content-security-policy');
  const script = csp.match(/script-src ([^;]*)/)[1];
  assert.equal(script, "'self'", 'no external script hosts unless explicitly running behind Cloudflare');
  assert.ok(!/unsafe-inline|unsafe-eval/.test(script));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match((await get('/health')).headers.get('x-robots-tag') || '', /noindex/);
});

test('groups, summary and sidebar data only include public targets', async () => {
  const g = (await get('/api/v1/groups')).body;
  assert.deepEqual(g.map((x) => x.name), ['Public Group']);
  assert.deepEqual(g[0].targets.map((t) => t.name).sort(), ['Second Visible', 'Visible']);
  const s = (await get('/api/v1/summary')).body;
  assert.equal(s.total, 2, 'private targets are not counted');
  assert.deepEqual(s.maintenance_windows.map((w) => w.name), ['Visible work'], 'a window on a private group is not announced');
  assert.ok(!JSON.stringify(s).includes('tailnet') && !JSON.stringify(s).includes('Tailnet'));
});

test('every per-target endpoint 404s for a private target or a target in a private group', async () => {
  for (const id of [ids.hiddenT, ids.inPriv]) {
    for (const u of ['', '/results?range=1h', '/uptime', '/traceroute', '/traceroute/history', '/availability', '/events?range=24h']) {
      assert.equal((await get(`/api/v1/targets/${id}${u}`)).status, 404, `/targets/${id}${u}`);
    }
    assert.equal((await get(`/badge/${id}.svg`)).status, 404);
    assert.deepEqual((await get(`/api/v1/targets/${id}/incidents`)).body.incidents, []);
  }
  assert.equal((await get(`/api/v1/groups/${ids.privG}/results`)).status, 404);
});

test('incident list and Atom feed exclude private targets', async () => {
  const list = (await get('/api/v1/incidents?days=7')).body.incidents;
  assert.deepEqual(list.map((i) => i.target_name), ['Visible']);
  const feed = (await get('/feed.atom')).body;
  assert.ok(feed.includes('Visible') && !feed.includes('Hidden Target') && !feed.includes('In Private Group'));
});

test('the visible target works everywhere, including the group batch endpoint', async () => {
  for (const u of ['', '/results?range=1h', '/uptime', '/availability']) assert.equal((await get(`/api/v1/targets/${ids.pub}${u}`)).status, 200, u);
  assert.equal((await get(`/badge/${ids.pub}.svg`)).status, 200);
  const batch = (await get(`/api/v1/groups/${ids.pubG}/results?range=1h`)).body;
  assert.deepEqual(Object.keys(batch.targets).sort(), [String(ids.pub), String(ids.pub2)].sort(), 'the hidden sibling is not in the batch');
});

test('results carry latency percentiles', async () => {
  const rows = (await get(`/api/v1/targets/${ids.pub}/results?range=1h`)).body.data;
  assert.equal(rows[0].latency_p95, 11.5);
  assert.equal(rows[0].latency_p50, 10);
});

test('routing summary: carriers, direct peering and concentration come from public traces only', async () => {
  const r = (await get('/api/v1/routing')).body;
  assert.equal(r.own_asn, 55850, 'our own AS is whatever the paths start with');
  assert.equal(r.traced, 2, 'private targets are not counted');
  assert.deepEqual(r.carriers.map((c) => c.asn).sort((a, b) => a - b), [4637, 15169]);
  const telstra = r.carriers.find((c) => c.asn === 4637);
  assert.equal(telstra.name, 'Telstra Global'); assert.equal(telstra.direct_targets, 0, 'transit: not the destination itself');
  const google = r.carriers.find((c) => c.asn === 15169);
  assert.equal(google.direct_targets, 1, 'handed straight to the destination network = direct peering');
  assert.equal(r.carriers.reduce((n, c) => n + c.share, 0).toFixed(2), '1.00');
  assert.ok(!JSON.stringify(r).includes('Tailnet') && !r.carriers.some((c) => c.asn === 3356), 'nothing from private groups leaks');
  assert.equal(r.regions[0].group, 'Public Group');
});

test('routing: a configured own-AS is honoured, and a path that does not contain it is never mis-attributed', async () => {
  const { saveSettings } = require('../server/shared/settings');
  // Auto-detected AS55850: every public path contains it, so nothing is unattributed
  assert.equal((await get('/api/v1/routing')).body.unattributed, 0);
  assert.equal((await get('/api/v1/routing')).body.own_asn_source, 'detected');

  // Pretend our routers are invisible and our real AS is 64500: no path contains it, so the first AS seen
  // is the carrier (previously the first AS was silently treated as the next hop after a wrong guess)
  saveSettings({ own_asn: 64500 });
  const r = (await get('/api/v1/routing')).body;
  assert.equal(r.own_asn, 64500); assert.equal(r.own_asn_source, 'configured');
  assert.equal(r.carriers.find((c) => c.asn === 55850)?.targets, 2, 'AS55850 is correctly the carrier, for both public targets');

  // Detected AS that some paths don't pass through: those are left out, not misreported
  saveSettings({ own_asn: null });
  const db = new (require('better-sqlite3'))(process.env.DATABASE_PATH);
  const extra = Number(db.prepare("INSERT INTO targets (group_id, name, host, probe_type, is_public) VALUES (?, 'Odd Path', '203.0.113.9', 'icmp', 1)").run(ids.pubG).lastInsertRowid);
  db.prepare("INSERT INTO traceroute_cache (target_id, result_json, ran_at, as_path_json, method, complete) VALUES (?, '[]', unixepoch(), ?, 'icmp', 1)").run(extra, JSON.stringify({ path: [3356, 6939] }));
  const r2 = (await get('/api/v1/routing')).body;
  assert.equal(r2.unattributed, 1);
  assert.ok(!r2.carriers.some((c) => c.asn === 6939), 'the stray path did not create a bogus carrier');
  db.prepare('DELETE FROM targets WHERE id = ?').run(extra);
  db.close();
  saveSettings({});
});

test('events endpoint: outage, maintenance window and route change inside the range', async () => {
  const ev = (await get(`/api/v1/targets/${ids.pub}/events?range=24h`)).body;
  assert.equal(ev.incidents.length, 1);
  assert.equal(ev.incidents[0].ongoing, false);
  assert.deepEqual(ev.maintenance.map((m) => m.name), ['Visible work']);
  assert.equal(ev.route_changes.length, 1, 'the first record is the baseline, not a change');
  assert.deepEqual(ev.route_changes[0].path, [9500, 3356, 15169]);
  assert.equal((await get(`/api/v1/targets/${ids.pub}/events?range=nope`)).status, 400);
});
