'use strict';
// Browser smoke tests against the real servers and the BUILT apps (npm run build first).
// These exist because several regressions were invisible to unit tests and to the build: a charting
// upgrade silently deleted the spread bands, and a missing import crashed a modal.
// Skipped (not failed) when the apps aren't built or no Chromium is installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ui-'));
const rnd = () => 20000 + Math.floor(Math.random() * 20000);
const PUB = rnd(), ADM = PUB + 1;
const env = {
  ...process.env, DATABASE_PATH: path.join(dir, 'ui.db'), PUBLIC_PORT: String(PUB), PUBLIC_HOST: '127.0.0.1',
  ADMIN_PORT: String(ADM), ADMIN_HOST: '127.0.0.1', SESSION_SECRET: 'ui-test-secret-ui-test-secret-123456', NODE_ENV: 'production',
};
process.env.DATABASE_PATH = env.DATABASE_PATH;

let browser, skipReason = null;
const procs = [];
const ids = {};

async function waitUp(url) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`${url} did not start`);
}

test.before(async () => {
  for (const app of ['public', 'admin']) {
    if (!fs.existsSync(path.join(root, `apps/${app}/dist/index.html`))) { skipReason = `apps/${app} is not built (run: npm run build)`; return; }
  }
  let chromium;
  try { ({ chromium } = require('playwright')); browser = await chromium.launch(); }
  catch (e) { skipReason = `Chromium unavailable (${String(e.message).split('\n')[0]})`; return; }

  assert.equal(spawnSync('node', ['scripts/migrate.js'], { cwd: root, env, encoding: 'utf8' }).status, 0);
  const db = require('../../server/db/db').getDb();
  const bcrypt = require('bcrypt');
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('ui-admin', bcrypt.hashSync('ui-password-1234', 4));
  ids.g = Number(db.prepare("INSERT INTO groups (name, description) VALUES ('Core Links', 'Backbone')").run().lastInsertRowid);
  const hidden = Number(db.prepare("INSERT INTO groups (name, is_public) VALUES ('Private Lab', 0)").run().lastInsertRowid);
  db.prepare("INSERT INTO targets (group_id, name, host, probe_type, is_public) VALUES (?, 'Secret Box', '10.5.5.5', 'icmp', 1)").run(hidden);
  ids.t = [];
  for (const [n, h] of [['Alpha', '203.0.113.1'], ['Bravo', '203.0.113.2'], ['Charlie', '203.0.113.3']]) {
    const id = Number(db.prepare("INSERT INTO targets (group_id, name, host, probe_type) VALUES (?, ?, ?, 'icmp')").run(ids.g, n, h).lastInsertRowid);
    ids.t.push(id);
    for (let i = 120; i >= 0; i--) {
      const base = 20 + id * 3 + Math.sin(i / 7) * 4;
      db.prepare(`INSERT INTO probe_results (target_id, timestamp, latency_min, latency_avg, latency_max, latency_p50, latency_p95, packet_loss)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, now - i * 120, base - 3, base, base + 9, base - 0.5, base + 6, i > 0 && i % 31 === 0 ? 40 : 0);
    }
  }
  db.prepare('INSERT INTO incidents (target_id, started_at, ended_at, notified_at) VALUES (?, ?, ?, ?)').run(ids.t[0], now - 9000, now - 8000, now - 9000);
  db.prepare("INSERT INTO maintenance_windows (name, scope, scope_id, starts_at, ends_at) VALUES ('Planned work', 'target', ?, ?, ?)").run(ids.t[0], now - 6000, now - 5000);
  const hop = (n, ip, asn, name) => ({ hop: n, ip, ips: [ip], ecmp: n === 2, rtts: [1, 1, 1], timeout: false, hidden: false, rdns: null, asn, as_name: name, cc: 'NZ' });
  const hops = [hop(1, '198.51.100.1', 55850, 'MERCURY - Mercury NZ Limited, NZ'), hop(2, '198.51.100.2', 4637, 'ASN-TELSTRA - Telstra Global, HK'), hop(3, '203.0.113.1', 15169, 'GOOGLE - Google LLC, US')];
  db.prepare('INSERT INTO traceroute_cache (target_id, result_json, ran_at, as_path_json, method, complete) VALUES (?, ?, ?, ?, ?, 1)').run(ids.t[0], JSON.stringify(hops), now, JSON.stringify({ path: [55850, 4637, 15169] }), 'icmp');
  db.prepare('INSERT INTO traceroute_history (target_id, result_json, ran_at, as_path_json) VALUES (?, ?, ?, ?)').run(ids.t[0], JSON.stringify(hops), now - 40000, JSON.stringify({ path: [55850, 3356, 15169] }));
  db.prepare('INSERT INTO traceroute_history (target_id, result_json, ran_at, as_path_json) VALUES (?, ?, ?, ?)').run(ids.t[0], JSON.stringify(hops), now - 7000, JSON.stringify({ path: [55850, 4637, 15169] }));
  // Completeness notice: shown for a new-engine trace that didn't reach the host, never for legacy rows (no method)
  db.prepare('INSERT INTO traceroute_cache (target_id, result_json, ran_at, as_path_json, method, complete) VALUES (?, ?, ?, ?, ?, 0)').run(ids.t[1], JSON.stringify(hops), now, JSON.stringify({ path: [55850, 15169] }), 'icmp');
  db.prepare('INSERT INTO traceroute_cache (target_id, result_json, ran_at) VALUES (?, ?, ?)').run(ids.t[2], JSON.stringify(hops), now - 90000);
  require('../../server/probe/rollup').backfillAggregates();
  db.close();

  procs.push(spawn('node', ['server/api/index.js'], { cwd: root, env, stdio: 'ignore' }));
  procs.push(spawn('node', ['server/admin/index.js'], { cwd: root, env, stdio: 'ignore' }));
  await waitUp(`http://127.0.0.1:${PUB}/health`); await waitUp(`http://127.0.0.1:${ADM}/health`);
});
test.after(async () => { await browser?.close(); procs.forEach((p) => p.kill()); });

const P = (u = '/') => `http://127.0.0.1:${PUB}${u}`;
const A = (u = '/') => `http://127.0.0.1:${ADM}${u}`;
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[134]/.test(m.text())) page.errors.push(m.text()); });
  return page;
}
const guard = (t) => { if (skipReason) { t.skip(skipReason); return false; } return true; };

test('public overview: private group is absent, incident history shown, no JS errors', async (t) => {
  if (!guard(t)) return;
  const page = await newPage();
  await page.goto(P('/')); await page.waitForSelector('.group-card');
  assert.equal(await page.locator('.group-card').count(), 1);
  const body = await page.textContent('body');
  assert.ok(!body.includes('Private Lab') && !body.includes('Secret Box'), 'private group must not leak into the page');
  assert.match(await page.title(), /Meridian/);
  assert.deepEqual(page.errors, []);
});

test('group page: one batched request, spread bands render, loss bars draw', async (t) => {
  if (!guard(t)) return;
  const page = await newPage();
  const resultCalls = [];
  page.on('request', (r) => { if (/\/api\/v1\/(groups\/\d+|targets\/\d+)\/results/.test(r.url())) resultCalls.push(r.url()); });
  await page.goto(P(`/group/${ids.g}`)); await page.waitForSelector('.target-card');
  await page.waitForSelector('.target-card .recharts-area-area');
  assert.equal(resultCalls.length, 1, `expected one request, saw ${resultCalls.length}`);
  assert.equal(await page.locator('.target-card .recharts-area-area').count(), 3, 'a min–max band per card (a charting upgrade once deleted these silently)');
  await page.click('text=List'); await page.waitForSelector('.list-table');
  assert.equal(await page.locator('.list-table tbody tr').count(), 3);
  assert.deepEqual(page.errors, []);
});

test('target page: chart overlays, AS path, route-change history and tools', async (t) => {
  if (!guard(t)) return;
  const page = await newPage();
  await page.goto(P(`/target/${ids.t[0]}?range=24h`)); await page.waitForSelector('.recharts-area-area');
  await page.waitForSelector('.recharts-reference-line', { state: 'attached', timeout: 10000 }); // route-change marker (an SVG <g> has no box, so it is never "visible")
  assert.ok(await page.locator('.recharts-reference-area').count() >= 2, 'outage and maintenance shading');
  assert.ok(await page.locator('.recharts-line').count() >= 2, 'average and 95th percentile lines');
  await page.waitForSelector('.aspath .aschip');
  assert.ok((await page.textContent('.aspath')).includes('AS4637'));
  await page.click('text=Traceroute'); await page.waitForSelector('table');
  assert.match(await page.textContent('table'), /Telstra Global/);
  assert.match(await page.textContent('body'), /Route changes/);
  await page.click('button:text-is("Fit")'); await page.click('button:text-is("Log")'); await page.click('button:text-is("Linear")');
  await page.click('summary:has-text("Share")'); await page.waitForSelector('text=Download CSV');
  assert.deepEqual(page.errors, []);
});

test('traceroute completeness notice: only for new-engine incomplete traces, never for legacy rows', async (t) => {
  if (!guard(t)) return;
  const page = await newPage();
  await page.goto(P(`/target/${ids.t[1]}`)); await page.click('text=Traceroute'); await page.waitForSelector('table');
  assert.match(await page.textContent('body'), /destination itself didn't answer/);
  await page.goto(P(`/target/${ids.t[2]}`)); await page.click('text=Traceroute'); await page.waitForSelector('table');
  const body = await page.textContent('body');
  assert.ok(!/destination itself didn't answer/.test(body), 'a legacy trace must not claim to be incomplete');
  assert.match(body, /previous traceroute engine/);
  await page.goto(P(`/target/${ids.t[0]}`)); await page.click('text=Traceroute'); await page.waitForSelector('table');
  assert.ok(!/destination itself didn't answer/.test(await page.textContent('body')), 'a complete trace shows no warning');
  assert.deepEqual(page.errors, []);
});

test('theme toggle and mobile layout', async (t) => {
  if (!guard(t)) return;
  const page = await newPage();
  await page.goto(P('/')); await page.waitForSelector('.group-card');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.click('.theme-btn'); assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  const m = await newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  await m.goto(P('/')); await m.waitForSelector('.group-card');
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no horizontal scroll on a phone');
  await m.click('.mobile-bar .icon-btn'); await m.waitForSelector('.left-sidebar.open');
  assert.deepEqual([...page.errors, ...m.errors], []);
});

test('admin: sign in, dashboard, Bulk Add modal opens (regression), settings tabs, 2FA QR', async (t) => {
  if (!guard(t)) return;
  const page = await newPage();
  await page.goto(A('/login')); await page.fill('#u', 'ui-admin'); await page.fill('#p', 'ui-password-1234'); await page.click('button[type=submit]');
  await page.waitForSelector('.tiles');
  await page.goto(A('/targets')); await page.waitForSelector('table tbody tr');
  assert.ok((await page.textContent('table')).includes('private'), 'private badge on the hidden target');
  await page.click('button:text-is("Bulk Add")'); await page.waitForSelector('.modal'); // used to throw a ReferenceError
  await page.keyboard.press('Escape');
  for (const tab of ['alerting', 'account', 'users', 'data', 'audit']) {
    await page.goto(A(`/settings?tab=${tab}`)); await page.waitForSelector('.card');
  }
  await page.goto(A('/settings?tab=alerting')); await page.click('text=+ Add channel'); await page.waitForSelector('.modal');
  const types = await page.$$eval('.modal select option', (o) => o.map((x) => x.textContent));
  for (const n of ['PagerDuty', 'Pushover', 'Opsgenie']) assert.ok(types.includes(n), n);
  await page.keyboard.press('Escape'); await page.click('.overlay', { position: { x: 4, y: 4 } }).catch(() => {});
  await page.goto(A('/settings?tab=account')); await page.waitForSelector('text=Set up two-factor authentication');
  await page.click('text=Set up two-factor authentication');
  await page.fill('form:has-text("Confirm your password") input', 'ui-password-1234'); await page.click('button:text-is("Continue")');
  await page.waitForSelector('.qr img');
  assert.ok(await page.$eval('.qr img', (i) => i.complete && i.naturalWidth > 0), 'QR code image decodes');
  assert.deepEqual(page.errors, []);
});

test('TV mode: chrome-free, rotates scenes, keyboard control, target scene, and warns when data goes stale', async (t) => {
  if (!guard(t)) return;
  const page = await newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(P('/tv?interval=5&views=overview,groups,problems,incidents,target:' + ids.t[0]));
  await page.waitForSelector('.tv-hero');
  assert.equal(await page.locator('.left-sidebar').count(), 0, 'no navigation chrome on the wall display');
  assert.match(await page.textContent('.tv-hero'), /All systems operational/);
  assert.equal(await page.textContent('.tv-title'), 'Overview');
  assert.ok(!(await page.textContent('body')).includes('Private Lab'), 'private groups never appear on the wall display either');

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.tv-title')?.textContent === 'Groups');
  assert.equal(await page.locator('.tv-tile').count(), 1);
  // 'problems' has nothing to show, so it is skipped; the next scene is the incident history
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.tv-title')?.textContent === 'Incidents');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.tv-target-chart .recharts-area-area');
  assert.match(await page.textContent('.tv-title'), /Alpha/);

  await page.keyboard.press('Space'); await page.waitForSelector('text=Paused');
  const frozen = await page.textContent('.tv-title');
  await page.waitForTimeout(6500);
  assert.equal(await page.textContent('.tv-title'), frozen, 'paused: no rotation');
  await page.keyboard.press('?'); await page.waitForSelector('.tv-help');
  await page.keyboard.press('Escape');

  // Rotation without input
  await page.keyboard.press('Space');
  const before = await page.textContent('.tv-title');
  await page.waitForFunction((b) => document.querySelector('.tv-title')?.textContent !== b, before, { timeout: 9000 });
  assert.deepEqual(page.errors, []);

  // Stale data: pretend every probe is ten minutes old
  const stale = await newPage({ viewport: { width: 1920, height: 1080 } });
  await stale.route('**/api/v1/groups', async (route) => {
    const res = await route.fetch(); const body = await res.json();
    for (const g of body) for (const tg of g.targets) tg.last_checked = Math.floor(Date.now() / 1000) - 600;
    await route.fulfill({ response: res, json: body });
  });
  await stale.goto(P('/tv')); await stale.waitForSelector('.tv-stale');
  assert.match(await stale.textContent('.tv-stale'), /out of date/);
});
