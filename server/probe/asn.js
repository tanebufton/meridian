'use strict';

// Origin-AS lookups through Team Cymru's DNS service (no API key, answered over plain DNS).
//   <rev-ip>.origin.asn.cymru.com TXT  -> "15169 | 8.8.8.0/24 | US | arin | 2023-12-28"
//   AS15169.asn.cymru.com        TXT  -> "15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US"
// Results are cached by /24 (IPv4) or /48 (IPv6): one lookup covers every hop in that block.

const dns = require('dns').promises;

const DAY = 86400;
const TTL_FOUND = 30 * DAY;
const TTL_MISS = 3 * DAY;
const TTL_NAME = 90 * DAY;

function expandV6(ip) {
  let head = ip.split('%')[0];
  if (head.includes('.')) return null; // IPv4-mapped: not worth handling
  const [a, b] = head.split('::');
  const left = a ? a.split(':') : [];
  const right = b !== undefined ? (b ? b.split(':') : []) : [];
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (b === undefined && left.length !== 8)) return null;
  return [...left, ...Array(b !== undefined ? fill : 0).fill('0'), ...right].map((g) => g.padStart(4, '0'));
}

/** The cache key + DNS name for an address, or null if it can't be looked up. */
function keyFor(ip) {
  if (!ip) return null;
  if (ip.includes(':')) {
    const g = expandV6(ip);
    if (!g) return null;
    const nibbles = g.slice(0, 3).join(''); // /48 = first 12 nibbles
    return { prefix: `${g.slice(0, 3).join(':')}::/48`, qname: `${nibbles.split('').reverse().join('.')}.origin6.asn.cymru.com` };
  }
  const o = ip.split('.');
  if (o.length !== 4) return null;
  return { prefix: `${o[0]}.${o[1]}.${o[2]}.0/24`, qname: `${o[2]}.${o[1]}.${o[0]}.origin.asn.cymru.com` };
}

function parseOrigin(txt) {
  const parts = String(txt).split('|').map((s) => s.trim());
  const asn = parseInt(parts[0].split(/\s+/)[0], 10); // multi-origin prefixes list several ASNs: take the first
  if (!Number.isFinite(asn)) return null;
  return { asn, bgpPrefix: parts[1] || null, cc: parts[2] || null };
}

function parseAsName(txt) {
  const parts = String(txt).split('|').map((s) => s.trim());
  return { cc: parts[1] || null, name: parts.slice(4).join(' | ') || null };
}

async function txt(name) {
  const r = await dns.resolveTxt(name);
  return r[0].join('');
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * Resolve many addresses at once. Returns Map<ip, {asn, name, cc}>; addresses that couldn't be
 * resolved are simply absent (failures are not cached, so they're retried next time).
 */
async function lookupAsns(db, ips, { now = Math.floor(Date.now() / 1000), resolver = { origin: txt, asName: txt } } = {}) {
  const wanted = new Map(); // prefix -> {qname, ips[]}
  for (const ip of new Set(ips.filter(Boolean))) {
    const k = keyFor(ip);
    if (!k) continue;
    if (!wanted.has(k.prefix)) wanted.set(k.prefix, { ...k, ips: [] });
    wanted.get(k.prefix).ips.push(ip);
  }

  const getCache = db.prepare('SELECT asn, bgp_prefix, cc, fetched_at FROM asn_cache WHERE prefix = ?');
  const putCache = db.prepare(
    `INSERT INTO asn_cache (prefix, asn, bgp_prefix, cc, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(prefix) DO UPDATE SET asn = excluded.asn, bgp_prefix = excluded.bgp_prefix, cc = excluded.cc, fetched_at = excluded.fetched_at`
  );

  const needOrigin = [];
  const byPrefix = new Map();
  for (const [prefix, w] of wanted) {
    const c = getCache.get(prefix);
    const fresh = c && now - c.fetched_at < (c.asn == null ? TTL_MISS : TTL_FOUND);
    if (fresh) byPrefix.set(prefix, c); else needOrigin.push([prefix, w]);
  }

  await pool(needOrigin, 8, async ([prefix, w]) => {
    try {
      const o = parseOrigin(await resolver.origin(w.qname));
      if (o) { putCache.run(prefix, o.asn, o.bgpPrefix, o.cc, now); byPrefix.set(prefix, { asn: o.asn, cc: o.cc }); }
      else { putCache.run(prefix, null, null, null, now); }
    } catch (err) {
      // NXDOMAIN = nobody announces it (cache the miss); anything else = transient, retry later
      if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') putCache.run(prefix, null, null, null, now);
    }
  });

  // names for the ASNs we now know about
  const asns = [...new Set([...byPrefix.values()].map((c) => c.asn).filter((a) => a != null))];
  const getInfo = db.prepare('SELECT name, cc, fetched_at FROM asn_info WHERE asn = ?');
  const putInfo = db.prepare(
    `INSERT INTO asn_info (asn, name, cc, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(asn) DO UPDATE SET name = excluded.name, cc = excluded.cc, fetched_at = excluded.fetched_at`
  );
  const info = new Map();
  const needName = [];
  for (const a of asns) {
    const c = getInfo.get(a);
    if (c && now - c.fetched_at < TTL_NAME) info.set(a, c); else needName.push(a);
  }
  await pool(needName, 8, async (a) => {
    try { const n = parseAsName(await resolver.asName(`AS${a}.asn.cymru.com`)); putInfo.run(a, n.name, n.cc, now); info.set(a, n); }
    catch { /* name is cosmetic; the ASN itself is what matters */ }
  });

  const out = new Map();
  for (const [prefix, w] of wanted) {
    const c = byPrefix.get(prefix);
    if (!c || c.asn == null) continue;
    const i = info.get(c.asn);
    for (const ip of w.ips) out.set(ip, { asn: c.asn, name: i?.name ?? null, cc: c.cc ?? i?.cc ?? null });
  }
  return out;
}

/** Annotate each hop with asn / as_name / cc (and per-address asns for load-balanced hops). */
async function annotateHops(db, hops, opts) {
  const all = hops.flatMap((h) => (h.hidden ? [] : h.ips && h.ips.length ? h.ips : h.ip ? [h.ip] : []));
  const m = await lookupAsns(db, all, opts);
  return hops.map((h) => {
    const a = h.ip ? m.get(h.ip) : null;
    return { ...h, asn: a ? a.asn : null, as_name: a ? a.name : null, cc: a ? a.cc : null };
  });
}

module.exports = { lookupAsns, annotateHops, keyFor, parseOrigin, parseAsName, expandV6 };
