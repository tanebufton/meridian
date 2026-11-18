'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { freshDb } = require('./helpers');
const db = freshDb();
const n = require('../server/probe/notifier');

// A stand-in for every provider: records requests, answers with a scripted status
const calls = [];
let script = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.statusCode = script.length ? script.shift() : 200;
    res.end('{}');
  });
});
let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  n.endpoints.pagerduty = `${base}/pd`;
  n.endpoints.pushover = `${base}/pushover`;
  n.endpoints.opsgenie = { us: `${base}/og`, eu: `${base}/og-eu` };
  n.endpoints.telegram = base;
  n.retry.delays = [0, 0];
});
test.after(() => server.close());
test.beforeEach(() => { calls.length = 0; script = []; n._reset(); db.prepare('DELETE FROM notification_channels').run(); });

const down = { event: 'down', incidentId: 7, target: 'Core Router', host: '10.0.0.1', group: 'Core', status: 'DOWN', cause: 'ping failed', durationSeconds: 120, targetUrl: 'https://s.example/target/3', timestamp: '2026-01-01T00:00:00Z' };
const up = { ...down, event: 'recovered', status: 'UP' };
const json = (c) => JSON.parse(c.body);

test('PagerDuty: trigger then resolve share a dedup key; severity and links set', async () => {
  const ch = { type: 'pagerduty', url: 'pagerduty://R0UTINGKEY0123456789abcdef012345' };
  await n.sendToChannel(ch, down);
  await n.sendToChannel(ch, up);
  const [t, r] = calls.map(json);
  assert.equal(t.event_action, 'trigger');
  assert.equal(t.routing_key, 'R0UTINGKEY0123456789abcdef012345');
  assert.equal(t.payload.severity, 'critical');
  assert.match(t.payload.summary, /Core Router is DOWN/);
  assert.equal(t.links[0].href, down.targetUrl);
  assert.equal(r.event_action, 'resolve');
  assert.equal(r.dedup_key, t.dedup_key, 'resolve must match the trigger or the page never clears');
  assert.equal(calls[0].url, '/pd');
});

test('Pushover: form-encoded, high priority for down, normal for recovery, link included', async () => {
  const ch = { type: 'pushover', url: 'pushover://uQiRzpo4DXghDmr9QzzfQu27cmVRsG@azGDORePK8gMaC0QOYAMyEEuzJnyUi?sound=siren' };
  await n.sendToChannel(ch, down);
  await n.sendToChannel(ch, up);
  assert.match(calls[0].headers['content-type'], /x-www-form-urlencoded/);
  const a = new URLSearchParams(calls[0].body), b = new URLSearchParams(calls[1].body);
  assert.equal(a.get('priority'), '1'); assert.equal(b.get('priority'), '0');
  assert.equal(a.get('user'), 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG');
  assert.equal(a.get('token'), 'azGDORePK8gMaC0QOYAMyEEuzJnyUi');
  assert.equal(a.get('sound'), 'siren');
  assert.equal(a.get('url'), down.targetUrl);
});

test('Opsgenie: create with alias, close by alias, EU region honoured, GenieKey auth', async () => {
  await n.sendToChannel({ type: 'opsgenie', url: 'opsgenie://abcd1234-abcd-1234-abcd-123456789012?region=eu' }, down);
  await n.sendToChannel({ type: 'opsgenie', url: 'opsgenie://abcd1234-abcd-1234-abcd-123456789012' }, up);
  assert.equal(calls[0].url, '/og-eu');
  assert.equal(calls[0].headers.authorization, 'GenieKey abcd1234-abcd-1234-abcd-123456789012');
  assert.equal(json(calls[0]).alias, 'meridian-incident-7');
  assert.equal(calls[1].url, '/og/meridian-incident-7/close?identifierType=alias');
});

test('Teams, Gotify, ntfy (token + digest), Slack, Discord, Telegram, webhook payload shapes', async () => {
  await n.sendToChannel({ type: 'teams', url: `${base}/teams` }, down);
  assert.equal(json(calls[0]).attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  await n.sendToChannel({ type: 'teams', url: `${base.replace('127.0.0.1', 'localhost')}/x.office.com` }, down).catch(() => {});
  calls.length = 0;
  await n.sendToChannel({ type: 'gotify', url: `${base}/message?token=abc` }, down);
  assert.equal(calls[0].url, '/message?token=abc'); assert.equal(json(calls[0]).priority, 8);
  calls.length = 0;
  await n.sendToChannel({ type: 'ntfy', url: `${base}/topic?token=tk_secret` }, down);
  assert.equal(calls[0].url, '/topic', 'token is moved out of the URL');
  assert.equal(calls[0].headers.authorization, 'Bearer tk_secret');
  assert.equal(json(calls[0]).priority, 5);
  calls.length = 0;
  await n.sendToChannel({ type: 'telegram', url: 'tgram://123:ABC/456' }, down);
  assert.equal(calls[0].url, '/bot123:ABC/sendMessage'); assert.equal(json(calls[0]).chat_id, '456');
  calls.length = 0;
  await n.sendToChannel({ type: 'webhook', url: `${base}/hook` }, up);
  const w = json(calls[0]);
  assert.equal(w.event, 'recovered'); assert.equal(w.incident_id, 7); assert.equal(w.duration_seconds, 120);
});

test('retries transient failures but not client errors', async () => {
  script = [503, 503, 200];
  await n.sendToChannel({ type: 'webhook', url: `${base}/h` }, down);
  assert.equal(calls.length, 3, 'two 503s then success');
  calls.length = 0; script = [400];
  await assert.rejects(n.sendToChannel({ type: 'webhook', url: `${base}/h` }, down), /HTTP 400/);
  assert.equal(calls.length, 1, 'a 4xx is a config problem: do not hammer the endpoint');
  calls.length = 0; script = [429, 200];
  await n.sendToChannel({ type: 'webhook', url: `${base}/h` }, down);
  assert.equal(calls.length, 2, '429 is retried');
});

const addChannel = (type, url, extra = {}) => db.prepare('INSERT INTO notification_channels (name,type,url,groups_json,send_recovery) VALUES (?,?,?,?,?)')
  .run(`${type}-ch`, type, url, extra.groups ? JSON.stringify(extra.groups) : null, extra.recovery === false ? 0 : 1).lastInsertRowid;
const fire = (o = {}) => n.fireStatusChange({ kind: 'down', targetId: 1, groupId: 1, name: 'T', host: 'h', groupName: 'G', incidentId: 1, durationSeconds: 0, ...o });

test('per-channel group filter and recovery switch', async () => {
  addChannel('webhook', `${base}/all`);
  addChannel('webhook', `${base}/only-g2`, { groups: [2] });
  addChannel('webhook', `${base}/no-recovery`, { recovery: false });
  await fire({ groupId: 1 });
  assert.deepEqual(calls.map((c) => c.url).sort(), ['/all', '/no-recovery']);
  calls.length = 0;
  await fire({ kind: 'recovered', groupId: 2 });
  assert.deepEqual(calls.map((c) => c.url).sort(), ['/all', '/only-g2']);
});

test('delivery status is recorded: last_ok on success, last_error on failure, cleared again on success', async () => {
  const id = addChannel('webhook', `${base}/s`);
  script = [400];
  await fire();
  let row = db.prepare('SELECT * FROM notification_channels WHERE id=?').get(id);
  assert.match(row.last_error, /HTTP 400/); assert.ok(row.last_error_at);
  await fire();
  row = db.prepare('SELECT * FROM notification_channels WHERE id=?').get(id);
  assert.equal(row.last_error, null); assert.ok(row.last_ok_at);
});

test('flood: chat channels are batched into one digest, paging channels still get every event', async () => {
  n.flood.threshold = 2;
  addChannel('slack', `${base}/slack`);
  addChannel('pagerduty', 'pagerduty://R0UTINGKEY0123456789abcdef012345');
  for (let i = 0; i < 6; i++) await fire({ name: `T${i}`, incidentId: i });
  assert.equal(calls.filter((c) => c.url === '/pd').length, 6, 'every outage pages');
  assert.equal(calls.filter((c) => c.url === '/slack').length, 2, 'chat stops after the threshold');
  calls.length = 0;
  await n.flushDigest();
  const digest = calls.filter((c) => c.url === '/slack');
  assert.equal(digest.length, 1);
  assert.match(json(digest[0]).text, /4 alerts were batched/);
  assert.equal(calls.filter((c) => c.url === '/pd').length, 0, 'paging channels never receive digests');
  n.flood.threshold = 5;
});

test('route-change messages: formatted per channel, never sent to paging channels', async () => {
  const rc = { event: 'route_change', target: 'Baidu', host: 'www.baidu.com', group: 'CDNs', status: 'ROUTE_CHANGE', prevPath: [55850, 4637], newPath: [55850, 3356],
    pathText: 'was: AS55850 → AS4637\nnow: AS55850 → AS3356', targetUrl: 'https://s.example/target/14', timestamp: '2026-01-01T00:00:00Z' };
  await n.sendToChannel({ type: 'slack', url: `${base}/slack` }, rc);
  assert.match(json(calls[0]).text, /Route to Baidu changed[\s\S]*was: AS55850 → AS4637[\s\S]*now: AS55850 → AS3356/);
  calls.length = 0;
  await n.sendToChannel({ type: 'pushover', url: 'pushover://uQiRzpo4DXghDmr9QzzfQu27cmVRsG@azGDORePK8gMaC0QOYAMyEEuzJnyUi' }, rc);
  const p = new URLSearchParams(calls[0].body);
  assert.equal(p.get('priority'), '-1', 'silent push');
  assert.equal(p.get('title'), 'Route changed: Baidu');
  calls.length = 0;
  await n.sendToChannel({ type: 'webhook', url: `${base}/hook` }, rc);
  assert.deepEqual(json(calls[0]).as_path, [55850, 3356]); assert.deepEqual(json(calls[0]).previous_as_path, [55850, 4637]); assert.equal(json(calls[0]).event, 'route_change');
  calls.length = 0;
  assert.deepEqual(await n.sendToChannel({ type: 'pagerduty', url: 'pagerduty://R0UTINGKEY0123456789abcdef012345' }, rc), { skipped: true });
  assert.deepEqual(await n.sendToChannel({ type: 'opsgenie', url: 'opsgenie://abcd1234-abcd-1234-abcd-123456789012' }, rc), { skipped: true });
  assert.equal(calls.length, 0, 'a route change must never page anyone');
});

test('fireRouteChange: skips paging channels, honours group filters, ignores the recovery switch', async () => {
  addChannel('slack', `${base}/chat`);
  addChannel('pagerduty', 'pagerduty://R0UTINGKEY0123456789abcdef012345');
  addChannel('webhook', `${base}/only-g2`, { groups: [2] });
  addChannel('webhook', `${base}/no-recovery`, { recovery: false });
  await n.fireRouteChange({ targetId: 1, groupId: 1, name: 'T', host: 'h', groupName: 'G', prevPath: [1, 2], newPath: [1, 3], names: new Map([[3, 'Lumen']]) });
  assert.deepEqual(calls.map((c) => c.url).sort(), ['/chat', '/no-recovery']);
  assert.match(json(calls.find((c) => c.url === '/chat')).text, /AS3 Lumen/);
});
