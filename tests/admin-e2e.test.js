'use strict';
// Boots the real admin server against a throwaway database and drives it over HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  DATABASE_PATH: path.join(dir, 'e2e.db'),
  ADMIN_PORT: String(PORT),
  ADMIN_HOST: '127.0.0.1',
  SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
  METRICS_TOKEN: 'e2e-metrics-token-0123456789',
  NODE_ENV: 'production',
};
process.env.DATABASE_PATH = env.DATABASE_PATH;
process.env.SESSION_SECRET = env.SESSION_SECRET;

const root = path.join(__dirname, '..');
const totp = require('../server/shared/totp');
let server;

// Minimal cookie-jar client
function client() {
  const jar = {};
  const call = async (method, url, body, extra = {}) => {
    const headers = { ...extra.headers };
    if (jar.csrf_token) headers['x-csrf-token'] = jar.csrf_token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) delete jar[k]; else jar[k] = v;
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { call, jar, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

test.before(async () => {
  const migrate = spawnSync('node', ['scripts/migrate.js'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stderr);
  const { getDb } = require('../server/db/db');
  const bcrypt = require('bcrypt');
  const db = getDb();
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('alice', bcrypt.hashSync('first-password-123', 4));
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('bob', bcrypt.hashSync('bobs-password-123', 4));
  db.prepare("INSERT INTO groups (name) VALUES ('Core')").run();
  db.prepare("INSERT INTO targets (group_id, name, host, probe_type) VALUES (1, 'DNS', '1.1.1.1', 'icmp')").run();

  fs.mkdirSync(path.join(root, 'apps/admin/dist'), { recursive: true });
  server = spawn('node', ['server/admin/index.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('admin server did not start');
});

test.after(() => { server?.kill(); });

let alice;
const login = async (c, user, pass) => {
  await c.get('/api/admin/auth/me'); // picks up the CSRF cookie
  return c.call('POST', '/api/admin/auth/login', { username: user, password: pass });
};
const metrics = (c) => c.call('GET', '/metrics', undefined, { headers: { authorization: 'Bearer e2e-metrics-token-0123456789' } });

test('unauthenticated requests are rejected; CSRF is enforced', async () => {
  const c = client();
  assert.equal((await c.get('/api/admin/targets')).status, 401);
  assert.equal((await c.get('/metrics')).status, 401);
  assert.equal((await metrics(c)).status, 200);
  assert.equal((await c.call('GET', '/metrics', undefined, { headers: { authorization: 'Bearer wrong' } })).status, 401);

  alice = client();
  assert.equal((await login(alice, 'alice', 'first-password-123')).status, 200);
  const cookie = Object.entries(alice.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(BASE + '/api/admin/groups', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"name":"x"}' });
  assert.equal(res.status, 403, 'valid session but no CSRF header');
});

test('wrong password is rejected and unknown users look identical', async () => {
  const c = client();
  const a = await login(c, 'alice', 'nope-nope-nope');
  const b = await login(c, 'nobody', 'nope-nope-nope');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('targets: option-like hosts refused, tcp/http validated, icmp6 accepted', async () => {
  assert.equal((await alice.post('/api/admin/targets', { group_id: 1, name: 'x', host: '-f', probe_type: 'icmp' })).status, 400);
  assert.equal((await alice.post('/api/admin/targets', { group_id: 1, name: 'x', host: 'noport', probe_type: 'tcp' })).status, 400);
  assert.equal((await alice.post('/api/admin/targets', { group_id: 1, name: 'web', host: 'https://example.com/up', probe_type: 'http' })).status, 200);
  assert.equal((await alice.post('/api/admin/targets', { group_id: 1, name: 'v6', host: '2606:4700::1111', probe_type: 'icmp6' })).status, 200);
});

test('notification URLs are validated', async () => {
  assert.equal((await alice.post('/api/admin/notifications', { name: 'm', type: 'webhook', url: 'http://169.254.169.254/' })).status, 400);
  assert.equal((await alice.post('/api/admin/notifications', { name: 'ok', type: 'slack', url: 'https://hooks.slack.com/services/x' })).status, 200);
});

test('password change needs the current password and signs out other sessions', async () => {
  const other = client();
  assert.equal((await login(other, 'alice', 'first-password-123')).status, 200);
  assert.equal((await other.get('/api/admin/auth/me')).status, 200);

  assert.equal((await alice.post('/api/admin/auth/change-password', { current_password: 'wrong-wrong-1', new_password: 'second-password-456' })).status, 403);
  assert.equal((await alice.post('/api/admin/auth/change-password', { current_password: 'first-password-123', new_password: 'short' })).status, 400);
  const ok = await alice.post('/api/admin/auth/change-password', { current_password: 'first-password-123', new_password: 'second-password-456' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.other_sessions_revoked >= 1);

  assert.equal((await alice.get('/api/admin/auth/me')).status, 200, 'current session survives');
  assert.equal((await other.get('/api/admin/auth/me')).status, 401, 'other session was revoked');
  const fresh = client();
  assert.equal((await login(fresh, 'alice', 'first-password-123')).status, 401, 'old password no longer works');
  assert.equal((await login(fresh, 'alice', 'second-password-456')).status, 200);
});

test('the reset endpoint is for other admins only', async () => {
  assert.equal((await alice.put('/api/admin/users/1/password', { password: 'sneaky-password-789' })).status, 400);
  assert.equal((await alice.put('/api/admin/users/2/password', { password: 'bobs-new-password-1' })).status, 200);
});

test('2FA: enrol, login with code, replay blocked, recovery code single-use', async () => {
  assert.equal((await alice.post('/api/admin/auth/2fa/setup', { password: 'wrong' })).status, 403);
  const setup = await alice.post('/api/admin/auth/2fa/setup', { password: 'second-password-456' });
  assert.equal(setup.status, 200);
  assert.match(setup.body.qr_svg, /<svg/);
  assert.match(setup.body.otpauth_uri, /^otpauth:\/\/totp\//);

  const now = Math.floor(Date.now() / 1000 / 30);
  assert.equal((await alice.post('/api/admin/auth/2fa/enable', { code: '000000' })).status, 400);
  const enabled = await alice.post('/api/admin/auth/2fa/enable', { code: totp.hotp(setup.body.secret, now) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.recovery_codes.length, 10);
  const recovery = enabled.body.recovery_codes;
  assert.equal((await alice.get('/api/admin/auth/me')).body.totp_enabled, true);

  const c = client();
  const step1 = await login(c, 'alice', 'second-password-456');
  assert.equal(step1.status, 200);
  assert.equal(step1.body.requires_2fa, true);
  assert.equal((await c.get('/api/admin/auth/me')).status, 401, 'no session after the password step');

  assert.equal((await c.post('/api/admin/auth/login/2fa', { challenge: step1.body.challenge, code: '123456' })).status, 401);
  assert.equal((await c.post('/api/admin/auth/login/2fa', { challenge: 'forged.1.abc', code: '123456' })).status, 401);

  // Enrolment consumed the current step, so use the next one (inside the +-1 window)
  const next = totp.hotp(setup.body.secret, now + 1);
  assert.equal((await c.post('/api/admin/auth/login/2fa', { challenge: step1.body.challenge, code: next })).status, 200);
  assert.equal((await c.get('/api/admin/auth/me')).status, 200);

  const c2 = client();
  const s2 = await login(c2, 'alice', 'second-password-456');
  assert.equal((await c2.post('/api/admin/auth/login/2fa', { challenge: s2.body.challenge, code: next })).status, 401, 'TOTP replay rejected');

  const r = await c2.post('/api/admin/auth/login/2fa', { challenge: s2.body.challenge, code: recovery[0] });
  assert.equal(r.status, 200);
  assert.equal(r.body.recovery_codes_remaining, 9);
  const c3 = client();
  const s3 = await login(c3, 'alice', 'second-password-456');
  assert.equal((await c3.post('/api/admin/auth/login/2fa', { challenge: s3.body.challenge, code: recovery[0] })).status, 401, 'recovery code is single use');
});

test('another admin can reset 2FA (lost device) but you cannot reset your own that way', async () => {
  assert.equal((await alice.del('/api/admin/users/1/2fa')).status, 400);
  assert.equal((await alice.del('/api/admin/users/2/2fa')).status, 200);
});

test('maintenance windows: validation, CRUD, active state, metrics', async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await alice.post('/api/admin/maintenance', { name: 'bad', starts_at: now, ends_at: now - 5 })).status, 400);
  assert.equal((await alice.post('/api/admin/maintenance', { name: 'bad', scope: 'group', starts_at: now, ends_at: now + 60 })).status, 400);
  assert.equal((await alice.post('/api/admin/maintenance', { name: 'bad', scope: 'group', scope_id: 999, starts_at: now, ends_at: now + 60 })).status, 400);

  const w = await alice.post('/api/admin/maintenance', { name: 'Switch upgrade', scope: 'group', scope_id: 1, starts_at: now - 60, ends_at: now + 3600 });
  assert.equal(w.status, 200);
  assert.equal(w.body.active, true);
  assert.equal(w.body.scope_name, 'Core');
  assert.equal((await alice.get('/api/admin/maintenance')).body.length, 1);
  assert.match((await metrics(alice)).body, /meridian_target_in_maintenance\{[^}]*\} 1/);
  assert.equal((await alice.del(`/api/admin/maintenance/${w.body.id}`)).status, 200);
  assert.equal((await alice.get('/api/admin/maintenance')).body.length, 0);
});

test('incidents can be acknowledged and un-acknowledged', async () => {
  const { getDb } = require('../server/db/db');
  const id = getDb().prepare('INSERT INTO incidents (target_id, started_at, notified_at) VALUES (1, unixepoch() - 300, unixepoch() - 300)').run().lastInsertRowid;
  assert.equal((await alice.get('/api/admin/incidents?status=open')).body.length, 1);
  const ack = await alice.post(`/api/admin/incidents/${id}/ack`, { note: 'ISP ticket opened' });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.ack_by, 'alice');
  assert.equal((await alice.del(`/api/admin/incidents/${id}/ack`)).status, 200);
  getDb().prepare('UPDATE incidents SET ended_at = unixepoch() WHERE id = ?').run(id);
  assert.equal((await alice.post(`/api/admin/incidents/${id}/ack`, {})).status, 409, 'cannot ack a recovered incident');
});

test('config import merges by default and keeps existing data', async () => {
  const before = (await alice.get('/api/admin/targets')).body.length;
  const res = await alice.post('/api/admin/config/import', {
    version: 1,
    groups: [
      { name: 'Core', targets: [{ name: 'DNS', host: '1.1.1.1', probe_type: 'icmp' }, { name: 'New', host: '9.9.9.9', probe_type: 'icmp6' }] },
      { name: 'Fresh', targets: [] },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.imported.targets, 1, 'existing target skipped, new one added');
  assert.equal(res.body.imported.skipped, 1);
  assert.equal(res.body.imported.groups, 1);
  assert.equal((await alice.get('/api/admin/targets')).body.length, before + 1);
  const bad = await alice.post('/api/admin/config/import', { version: 1, groups: [{ name: 'X', targets: [{ name: 'evil', host: '-f', probe_type: 'icmp' }] }] });
  assert.equal(bad.status, 400);
});

test('audit log records admin actions without request bodies', async () => {
  const log = await alice.get('/api/admin/audit');
  assert.equal(log.status, 200);
  const actions = log.body.map((e) => e.action);
  for (const a of ['login', 'password_changed', '2fa_enabled', 'login_failed']) assert.ok(actions.includes(a), `missing ${a} in ${actions}`);
  assert.ok(actions.some((a) => a.startsWith('POST /targets')));
  assert.ok(!JSON.stringify(log.body).includes('second-password-456'));
});

test('notification channels: new types validated, group filter + recovery switch stored, status fields present', async () => {
  const bad = (type, url) => alice.post('/api/admin/notifications', { name: 'x', type, url });
  assert.equal((await bad('pagerduty', 'https://events.pagerduty.com')).status, 400);
  assert.equal((await bad('pushover', 'pushover://short@short')).status, 400);
  assert.equal((await bad('opsgenie', 'opsgenie://abc')).status, 400);
  assert.equal((await bad('gotify', 'file:///etc/passwd')).status, 400);
  const ok = await alice.post('/api/admin/notifications', {
    name: 'Pager', type: 'pagerduty', url: 'pagerduty://R0UTINGKEY0123456789abcdef012345', group_ids: [1], send_recovery: false,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.group_ids, [1]);
  assert.equal(ok.body.send_recovery, 0);
  const list = (await alice.get('/api/admin/notifications')).body;
  const ch = list.find((c) => c.name === 'Pager');
  assert.deepEqual(ch.group_ids, [1]);
  assert.ok('last_ok_at' in ch && 'last_error' in ch);
  const upd = await alice.put(`/api/admin/notifications/${ch.id}`, { name: 'Pager', type: 'pagerduty', url: ch.url, group_ids: [], send_recovery: true });
  assert.equal(upd.body.group_ids, null, 'empty filter means all groups');
});

test('visibility: groups and targets can be made private and the flag round-trips (incl. export/import)', async () => {
  const g = await alice.post('/api/admin/groups', { name: 'Tailnet', is_public: 0 });
  assert.equal(g.status, 200);
  assert.equal(g.body.is_public, 0);
  const t = await alice.post('/api/admin/targets', { group_id: g.body.id, name: 'Internal', host: '10.1.1.1', probe_type: 'icmp', is_public: 0 });
  assert.equal(t.status, 200);
  const list = (await alice.get('/api/admin/targets')).body.find((x) => x.name === 'Internal');
  assert.equal(list.is_public, 0); assert.equal(list.group_is_public, 0);
  assert.equal((await alice.get('/api/admin/groups')).body.find((x) => x.name === 'Tailnet').is_public, 0);
  const exp = (await alice.get('/api/admin/config/export')).body;
  assert.equal(exp.groups.find((x) => x.name === 'Tailnet').public, false);
  assert.equal((await alice.put(`/api/admin/groups/${g.body.id}`, { name: 'Tailnet', is_public: 1 })).body.is_public, 1);
});

test('traceroute settings are validated', async () => {
  assert.equal((await alice.put('/api/admin/settings', { traceroute_method: 'icmp', route_confirm_runs: 3 })).status, 200);
  assert.equal((await alice.put('/api/admin/settings', { traceroute_method: 'carrier-pigeon' })).status, 400);
  assert.equal((await alice.put('/api/admin/settings', { route_confirm_runs: 0 })).status, 400);
});

test('the bundled NZ RSP example file is a valid import and creates the expected groups', async () => {
  const file = JSON.parse(fs.readFileSync(path.join(root, 'examples/nz-rsp-targets.json'), 'utf8'));
  const res = await alice.post('/api/admin/config/import', file);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.imported.targets >= 40);
  const groups = (await alice.get('/api/admin/groups')).body.map((g) => g.name);
  for (const n of ['NZ - Domestic', 'Pacific Islands', 'DNS Infrastructure', 'Africa', 'South America']) assert.ok(groups.includes(n), n);
  const again = await alice.post('/api/admin/config/import', file);
  assert.equal(again.body.imported.targets, 0, 'importing twice adds nothing');
});
