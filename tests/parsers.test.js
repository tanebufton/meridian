'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePingOutput } = require('../server/probe/icmp');
const { percentile, probePercentiles } = require('../server/shared/stats');
const maintenance = require('../server/shared/maintenance');

const IPUTILS = `PING example.com (93.184.216.34) 56(84) bytes of data.
64 bytes from 93.184.216.34: icmp_seq=1 ttl=56 time=11.2 ms
64 bytes from 93.184.216.34: icmp_seq=2 ttl=56 time=10.8 ms
64 bytes from 93.184.216.34: icmp_seq=4 ttl=56 time=12.9 ms

--- example.com ping statistics ---
4 packets transmitted, 3 received, 25% packet loss, time 3004ms
rtt min/avg/max/mdev = 10.800/11.633/12.900/0.894 ms
`;

test('ping: iputils output with a lost packet keeps position (null in the lost slot)', () => {
  const r = parsePingOutput(IPUTILS, '', 4);
  assert.deepEqual(r.rtts, [11.2, 10.8, null, 12.9]);
  assert.equal(r.packet_loss, 25);
  assert.equal(r.latency_min, 10.8); assert.equal(r.latency_avg, 11.633); assert.equal(r.latency_max, 12.9); assert.equal(r.latency_mdev, 0.894);
  assert.equal(r.resolved_ip, '93.184.216.34');
  assert.equal(r.error, null);
});

test('ping: IPv6 header and busybox summary (no mdev)', () => {
  const v6 = parsePingOutput(`PING 2606:4700::1111 (2606:4700::1111) 56 data bytes
64 bytes from 2606:4700::1111: icmp_seq=1 ttl=57 time=3.1 ms

--- ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 3.100/3.100/3.100/0.000 ms`, '', 1);
  assert.equal(v6.resolved_ip, '2606:4700::1111');
  const bb = parsePingOutput(`PING h (1.2.3.4): 56 data bytes
64 bytes from 1.2.3.4: seq=0 ttl=57 time=3.1 ms
--- h ping statistics ---
1 packets transmitted, 1 packets received, 0% packet loss
round-trip min/avg/max = 3.100/3.100/3.100 ms`, '', 1);
  assert.equal(bb.latency_avg, 3.1); assert.equal(bb.latency_mdev, null); assert.equal(bb.packet_loss, 0);
});

test('ping: total loss and resolver failure report 100% loss with a useful error', () => {
  const dead = parsePingOutput(`PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.

--- 192.0.2.1 ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 2046ms`, '', 3);
  assert.equal(dead.packet_loss, 100); assert.equal(dead.latency_avg, null); assert.deepEqual(dead.rtts, [null, null, null]);
  assert.equal(dead.resolved_ip, '192.0.2.1');
  const nodns = parsePingOutput('', 'ping: nonexistent.invalid: Name or service not known', 2);
  assert.equal(nodns.packet_loss, 100); assert.match(nodns.error, /Name or service not known/);
});

test('percentiles: interpolation, edge cases, and a minimum sample size', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([10, 20], 50), 15);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 100], 95) - 80.8) < 1e-9, 'p95 sees the tail that the average hides');
  assert.equal(percentile([], 50), null);
  assert.deepEqual(probePercentiles([5, null, 7]), { p50: null, p95: null }, 'two samples are not a distribution');
  const { p50, p95 } = probePercentiles([10, 11, 12, 13, null, 50]);
  assert.equal(p50, 12); assert.ok(p95 > 13 && p95 <= 50);
});

test('maintenance occurrences: repeating windows expand inside a range, one-offs only if they overlap', () => {
  const day = 86400;
  const w = { starts_at: 10 * day + 2 * 3600, ends_at: 10 * day + 3 * 3600, repeat: 'daily' };
  const occ = maintenance.occurrences(w, 20 * day, 23 * day);
  assert.equal(occ.length, 3);
  assert.equal(occ[0].start, 20 * day + 2 * 3600);
  assert.equal(maintenance.occurrences({ starts_at: 100, ends_at: 200, repeat: 'none' }, 150, 300).length, 1);
  assert.equal(maintenance.occurrences({ starts_at: 100, ends_at: 200, repeat: 'none' }, 300, 400).length, 0);
  assert.equal(maintenance.occurrences({ starts_at: 7 * day, ends_at: 7 * day + 3600, repeat: 'weekly' }, 0, 6 * day).length, 0, 'not before the first start');
});
