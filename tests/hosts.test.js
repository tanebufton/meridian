'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../server/shared/hosts');

test('isSafeHost rejects option-like and weird hosts', () => {
  for (const ok of ['example.com', '1.1.1.1', '2606:4700::1111', 'fe80::1%eth0', '::1', '::ffff:1.2.3.4', 'my_host-1.lan']) assert.ok(h.isSafeHost(ok), ok);
  for (const bad of ['-f', '--help', '', '.hidden', 'a b', 'a;b', '$(id)', 'x\n', 'a'.repeat(300)]) assert.ok(!h.isSafeHost(bad), JSON.stringify(bad));
});

test('tcp and http targets', () => {
  assert.deepEqual(h.parseTcpTarget('example.com:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(h.parseTcpTarget('[::1]:22'), { host: '::1', port: 22 });
  assert.equal(h.parseTcpTarget('example.com:99999'), null);
  assert.equal(h.parseTcpTarget('example.com'), null);
  assert.ok(h.parseHttpTarget('https://example.com/health'));
  assert.equal(h.parseHttpTarget('ftp://example.com'), null);
  assert.equal(h.validateHostFor('http', 'nope'), 'HTTP targets must be a full http:// or https:// URL');
  assert.equal(h.validateHostFor('icmp', '-f') !== null, true);
  assert.equal(h.probeHostname({ probe_type: 'http', host: 'https://[2001:db8::1]/x' }), '2001:db8::1');
});

test('notification URL validation', () => {
  assert.equal(h.validateChannelUrl('slack', 'https://hooks.slack.com/x'), null);
  assert.equal(h.validateChannelUrl('webhook', 'http://192.168.1.5:8123/api/webhook/x'), null);
  assert.ok(h.validateChannelUrl('webhook', 'http://169.254.169.254/latest'));
  assert.ok(h.validateChannelUrl('webhook', 'file:///etc/passwd'));
  assert.equal(h.validateChannelUrl('telegram', 'tgram://123:abc/456'), null);
  assert.ok(h.validateChannelUrl('telegram', 'https://x'));
});
