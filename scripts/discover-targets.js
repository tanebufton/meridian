#!/usr/bin/env node
'use strict';

/**
 * Build a target list for YOUR network.
 *
 * Which hosts give you a useful picture depends entirely on where you sit: the carriers you use, the
 * IXPs you're at, and which sites are served from a CDN node next door. This traces a candidate list
 * from this machine, then keeps the candidates that add a route you don't already monitor:
 *   - a carrier/peer you reach it through that none of your targets use yet  (+2)
 *   - a destination network you don't monitor yet                              (+1)
 *   - a complete trace (only as a tie-break between candidates that add something)  (+1)
 *   - CDN-fronted (answers in <5 ms from a CDN network)                        (excluded: it measures the
 *     CDN node near you, not that country)
 *
 *   node scripts/discover-targets.js                       # default candidate list, writes discovered-targets.json
 *   node scripts/discover-targets.js --candidates my.txt --out new.json --min-score 2 --own-asn 64500
 *
 * Candidate file: one `category|name|hostname` per line. The result is an import file
 * (Settings → Data → Import → "Add what's missing"). Needs a migrated database (npm run migrate),
 * ICMP traceroute (root or CAP_NET_RAW) and outbound DNS for the AS lookups.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { spawn } = require('child_process');

// Networks that front other people's sites. A foreign host answering in a couple of ms from one of
// these is a CDN edge near you, not a host in that country.
const CDN_ASNS = new Set([13335, 20940, 16625, 54113, 19551, 209242, 32934, 2906, 13414, 15169, 396982, 8075, 14618, 16509, 60068, 24429, 20446, 29990]);

/**
 * Pure scoring so it can be unit-tested. `existing` describes what you already monitor:
 *   { carriers: Map<asn, count>, destAsns: Set<asn>, hosts: Set<string> }
 */
function scoreCandidates(candidates, existing, { ownAsn, minScore = 1 } = {}) {
  const own = ownAsn ?? mostCommonFirst(candidates);
  const seenNext = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c.path?.length || existing.hosts.has(c.host)) continue;
    const i = c.path.indexOf(own);
    const next = i === -1 ? c.path[0] : c.path[i + 1];
    const dest = c.path[c.path.length - 1];
    const fronted = c.avg != null && c.avg < 5 && CDN_ASNS.has(dest) && !(c.cc && c.cc === c.homeCc);
    let score = 0;
    const why = [];
    if (next != null && !(existing.carriers.get(next) > 0)) { score += 2; why.push(`new carrier/peer AS${next}`); }
    else if (next != null && !seenNext.has(`${next}>${dest}`) && next !== dest && c.path.length > 2) { why.push(`via AS${next}`); }
    if (dest != null && !existing.destAsns.has(dest)) { score += 1; why.push(`new network AS${dest}`); }
    if (c.complete && score > 0) score += 1;   // a tie-break between candidates that add something, never a reason on its own
    if (fronted) { score = -1; why.push('CDN-fronted'); }
    if (next != null) seenNext.add(`${next}>${dest}`);
    out.push({ ...c, next, dest, score, why, fronted });
  }
  // Within the same (carrier, destination network) keep only the best-scoring one: ten hosts on the same
  // company in the same region add noise, not information.
  const best = new Map();
  for (const r of out.sort((a, b) => b.score - a.score)) {
    const k = `${r.next}>${r.dest}`;
    if (!best.has(k)) best.set(k, r);
  }
  return [...best.values()].filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score || (a.avg ?? 9e9) - (b.avg ?? 9e9));
}

function mostCommonFirst(cands) {
  const m = new Map();
  for (const c of cands) if (c.path?.length) m.set(c.path[0], (m.get(c.path[0]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

module.exports = { scoreCandidates, CDN_ASNS };
if (require.main !== module) return;

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node scripts/discover-targets.js [--candidates file] [--out file] [--min-score N] [--own-asn N]

  --candidates  one "category|name|hostname" per line (default: examples/target-candidates.txt)
  --out         import file to write (default: ./discovered-targets.json)
  --min-score   keep candidates scoring at least this (default 2: a new carrier, or a new network plus a complete trace)
  --own-asn     your AS number; otherwise taken from Settings or detected from the traces`);
  process.exit(0);
}
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const pingOnce = (h) => new Promise((resolve) => {
  const p = spawn('ping', ['-c', '5', '-i', '0.3', '-W', '2', '--', h]);
  let o = ''; p.stdout.on('data', (d) => { o += d; });
  p.on('close', () => { const m = o.match(/= ([\d.]+)\/([\d.]+)\//); const l = o.match(/([\d.]+)% packet loss/); resolve({ avg: m ? +m[2] : null, loss: l ? +l[1] : 100 }); });
});
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }

(async () => {
  require('dotenv').config({ quiet: true });
  const { getDb } = require('../server/db/db');
  const { runTraceroute } = require('../server/probe/traceroute');
  const { annotateHops, lookupAsns } = require('../server/probe/asn');
  const { asPath } = require('../server/probe/route');
  const db = getDb();

  const file = path.resolve(arg('candidates', path.join(__dirname, '../examples/target-candidates.txt')));
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('|'));
  console.log(`${lines.length} candidates from ${file}`);

  const live = [];
  await pool(lines, 14, async ([cat, name, host]) => {
    let ip; try { ip = (await dns.resolve4(host))[0]; } catch { return; }
    const p = await pingOnce(host);
    if (p.avg != null && p.loss <= 40) live.push({ cat, name, host, ip, ...p });
  });
  console.log(`${live.length} resolve and answer ping; tracing them (this takes a few minutes)...`);

  const traced = [];
  await pool(live, 6, async (c) => {
    try {
      const r = await runTraceroute(c.host, false, 'icmp');
      const hops = await annotateHops(db, r.hops);
      const cc = (await lookupAsns(db, [r.destIp || c.ip])).get(r.destIp || c.ip)?.cc || null;
      traced.push({ ...c, path: asPath(hops), complete: !!r.complete, cc });
    } catch { /* unreachable or no raw sockets */ }
  });

  // What you already monitor, from the latest trace of each enabled target
  const existing = { carriers: new Map(), destAsns: new Set(), hosts: new Set(db.prepare('SELECT host FROM targets').all().map((r) => r.host)) };
  const own = arg('own-asn') ? Number(arg('own-asn')) : (require('../server/shared/settings').loadSettings().own_asn || mostCommonFirst(traced));
  for (const r of db.prepare("SELECT c.as_path_json j FROM traceroute_cache c JOIN targets t ON t.id = c.target_id WHERE t.enabled = 1 AND c.method IS NOT NULL").all()) {
    let p; try { p = JSON.parse(r.j).path; } catch { continue; }
    if (!p || !p.length) continue;
    existing.destAsns.add(p[p.length - 1]);
    const i = p.indexOf(own); const next = i === -1 ? p[0] : p[i + 1];
    if (next != null) existing.carriers.set(next, (existing.carriers.get(next) || 0) + 1);
  }

  const ranked = scoreCandidates(traced, existing, { ownAsn: own, minScore: Number(arg('min-score', 2)) });
  const groups = new Map();
  for (const r of ranked) {
    const g = `Discovered - ${r.cc || 'Other'}`;
    if (!groups.has(g)) groups.set(g, { name: g, description: 'Found by scripts/discover-targets.js', sort_order: 0, public: true, targets: [] });
    groups.get(g).targets.push({ name: r.name, host: r.host, probe_type: 'icmp', interval_seconds: 300, packet_count: 10, enabled: true, notes: `Adds: ${r.why.join(', ')}` });
  }
  const outFile = path.resolve(arg('out', 'discovered-targets.json'));
  fs.writeFileSync(outFile, JSON.stringify({ version: 1, groups: [...groups.values()] }, null, 2));

  console.log(`\nYour AS: ${own ?? 'unknown'} · already monitoring ${existing.carriers.size} next-hop networks across ${existing.destAsns.size} destination networks`);
  console.log(`${traced.filter((t) => t.fronted).length} candidates were CDN-fronted and dropped\n`);
  for (const r of ranked.slice(0, 60)) console.log(`${String(r.score).padStart(2)}  ${String(Math.round(r.avg)).padStart(4)}ms  ${(r.cc || '??').padEnd(2)}  ${r.name.padEnd(28)} ${r.why.join(' · ')}`);
  console.log(`\nWrote ${ranked.length} targets to ${outFile}. Review it, then import via Settings → Data → Import → "Add what's missing".`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
