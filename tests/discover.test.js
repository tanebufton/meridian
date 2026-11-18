'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreCandidates } = require('../scripts/discover-targets');

const own = 64500;
const existing = () => ({ carriers: new Map([[1299, 20], [3356, 15]]), destAsns: new Set([15169, 20473]), hosts: new Set(['already.example']) });
const c = (name, host, path, o = {}) => ({ name, host, path, avg: 100, complete: true, cc: 'DE', ...o });

test('ranks candidates by the new routes they add', () => {
  const r = scoreCandidates([
    c('Via a carrier you never use', 'a.example', [own, 2914, 99001]),
    c('Same carrier, same network as before', 'b.example', [own, 1299, 15169]),
    c('Known carrier, new network', 'c.example', [own, 1299, 99002]),
  ], existing(), { ownAsn: own });
  assert.equal(r[0].name, 'Via a carrier you never use', 'a new carrier + a new network scores highest');
  assert.equal(r[0].score, 4, 'carrier +2, network +1, complete +1');
  assert.ok(!r.some((x) => x.name.startsWith('Same carrier')), 'adds nothing new: dropped');
  assert.equal(r.find((x) => x.name.startsWith('Known carrier')).score, 2);
});

test('CDN-fronted hosts are excluded: a foreign site answering in 2 ms from a CDN network measures the CDN, not the country', () => {
  const r = scoreCandidates([
    c('Looks Fijian, is Cloudflare next door', 'cf.example', [own, 13335], { avg: 2, cc: 'US', homeCc: 'FJ' }),
    c('A genuinely remote host', 'far.example', [own, 3257, 99003], { avg: 170 }),
  ], existing(), { ownAsn: own });
  assert.deepEqual(r.map((x) => x.name), ['A genuinely remote host']);
});

test('already-monitored hosts are never suggested, and duplicates on the same carrier+network collapse to the best one', () => {
  const r = scoreCandidates([
    c('Monitored already', 'already.example', [own, 2914, 99004]),
    c('Hosting company, city A', 'a1.example', [own, 6453, 99005]),
    c('Hosting company, city B', 'a2.example', [own, 6453, 99005], { complete: false }),
  ], existing(), { ownAsn: own });
  assert.equal(r.length, 1);
  assert.equal(r[0].host, 'a1.example', 'the complete trace wins');
});

test('a path that never passes through your AS is attributed to its first network, not skipped silently', () => {
  const r = scoreCandidates([c('Own routers invisible', 'x.example', [7018, 99006])], existing(), { ownAsn: own });
  assert.equal(r[0].next, 7018);
});
