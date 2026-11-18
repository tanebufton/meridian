'use strict';

// Deciding when a traceroute result is a REAL route change.
//
// Comparing hop by hop on exact IP flagged almost every run: load balancers (ECMP) answer from
// different addresses each time, and routers that stay silent shift every later hop's position.
// Replaying 171 days of your history, that produced 4,201 "changes" for 141 targets.
//
// A route is better described by the networks it crosses: the ordered list of AS numbers. Moving
// between routers inside one network, or flipping between equal-cost links, leaves it unchanged;
// switching transit provider changes it.

/** Ordered AS path of the public hops, consecutive repeats collapsed, unknown hops skipped. */
function asPath(hops) {
  const path = [];
  for (const h of hops) {
    if (!h || h.hidden || h.timeout || h.asn == null) continue;
    if (path[path.length - 1] !== h.asn) path.push(h.asn);
  }
  return path;
}

function isSubsequence(small, big) {
  let i = 0;
  for (const x of big) if (x === small[i]) i++;
  return i === small.length;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Fallback when AS data is missing (DNS blocked, first run): compare the set of /24s crossed.
const p24 = (ip) => (ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.'));
function prefixSet(hops) {
  const s = new Set();
  for (const h of hops) for (const ip of (h.ips && h.ips.length ? h.ips : h.ip ? [h.ip] : [])) s.add(p24(ip));
  return s;
}

/**
 * @param prev / next  { path: number[], complete: boolean, hops?: [...] }
 * @returns true when the two describe genuinely different routes
 */
function routeChanged(prev, next) {
  const a = prev.path || [];
  const b = next.path || [];

  if (a.length >= 1 && b.length >= 1) {
    if (sameList(a, b)) return false;
    // Both runs got all the way: any difference is real.
    if (prev.complete && next.complete) return true;
    // One run was cut short by silent routers, so its path may simply be missing networks.
    // Only call it a change if neither path is a subsequence of the other.
    return !(isSubsequence(a, b) || isSubsequence(b, a));
  }

  // No AS data on one side at all: fall back to the networks (/24s) crossed, tolerant of ECMP
  if (!prev.hops || !next.hops) return false;
  const A = prefixSet(prev.hops), B = prefixSet(next.hops);
  const union = new Set([...A, ...B]);
  if (union.size === 0) return false;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return (union.size - both) / union.size >= 0.5;
}

/** Which ASNs were added/removed between two paths (for showing what actually changed). */
function diffPaths(prev, next) {
  return { added: next.filter((x) => !prev.includes(x)), removed: prev.filter((x) => !next.includes(x)) };
}

module.exports = { asPath, routeChanged, diffPaths, isSubsequence, prefixSet };
