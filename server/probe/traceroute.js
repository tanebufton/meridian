'use strict';

const { spawn } = require('child_process');
const { promises: dnsPromises } = require('dns');
const { isSafeHost } = require('../shared/hosts');

const PRIVATE_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^127\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

const PRIVATE_IPV6_RANGES = [
  /^::1$/,           // loopback
  /^fe80:/i,         // link-local
  /^fc00:/i,         // unique local
  /^fd/i,            // unique local
];

function isPrivate(ip) {
  if (!ip) return false;
  if (ip.includes(':')) return PRIVATE_IPV6_RANGES.some((r) => r.test(ip));
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

const IPV4_TOKEN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_TOKEN = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
const isIp = (t) => IPV4_TOKEN.test(t) || (t.includes(':') && IPV6_TOKEN.test(t));

/**
 * Parse one traceroute output line into a hop.
 *
 * A hop line has up to three probes and each can be answered by a DIFFERENT router when the path
 * is load-balanced ("ECMP"):
 *     8  10.0.0.1  4.1 ms  10.0.0.2  4.3 ms  10.0.0.1  4.0 ms
 * The previous parser kept only the first address, so equal-cost paths looked like route changes.
 * This keeps every reply: `ips` lists each distinct public address, `ip` is the most frequent one,
 * and `ecmp` flags a hop answered by more than one router.
 */
function parseLine(line, _useIPv6 = false) {
  const m = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  const hop = parseInt(m[1], 10);
  const tokens = m[2].trim().split(/\s+/);

  const probes = []; // { ip, rtt } in probe order; ip/rtt null for a timeout
  let current = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^\(|\)$/g, '');
    if (t === '*') { probes.push({ ip: null, rtt: null }); continue; }
    if (isIp(t)) { current = t; probes.push({ ip: t, rtt: null, open: true }); continue; }
    if (/^\d+(?:\.\d+)?$/.test(t) && tokens[i + 1] === 'ms') {
      const last = probes[probes.length - 1];
      if (last && last.ip && last.open) { last.rtt = parseFloat(t); last.open = false; }
      else if (current) probes.push({ ip: current, rtt: parseFloat(t) }); // "ip  1.2 ms  1.3 ms": same router, more probes
      i++;
    }
  }
  const answered = probes.filter((p) => p.ip);
  const rtts = probes.map((p) => (p.ip ? p.rtt : null));
  const clean = (arr) => arr.map(({ ip, rtt }) => ({ ip, rtt }));

  if (answered.length === 0) {
    return { hop, ip: null, ips: [], ecmp: false, rtts: rtts.length ? rtts : [null, null, null], timeout: true, hidden: false, rdns: null, probes: clean(probes) };
  }

  const counts = new Map();
  for (const p of answered) counts.set(p.ip, (counts.get(p.ip) || 0) + 1);
  const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const publicIps = [...counts.keys()].filter((ip) => !isPrivate(ip));
  const hidden = isPrivate(primary);

  return {
    hop,
    ip: hidden ? null : primary,
    ips: publicIps,
    ecmp: publicIps.length > 1,
    rtts: rtts.length ? rtts : [null, null, null],
    timeout: false,
    hidden,
    rdns: null,
    probes: clean(probes),
  };
}

function parseOutput(stdout, useIPv6 = false) {
  const header = stdout.match(/^traceroute(?:6)? to \S+ \(([^)]+)\)/m);
  const hops = stdout.split('\n').map((l) => parseLine(l, useIPv6)).filter(Boolean);
  return { hops, destIp: header ? header[1] : null };
}

async function reverseLookup(ip) {
  try {
    const names = await dnsPromises.reverse(ip);
    return names[0] || null;
  } catch {
    return null;
  }
}

// icmp: ICMP echo — passes the most firewalls and reached 10/10 destinations in testing (needs root)
// tcp : SYN to :443 — good fallback where ICMP is filtered
// udp : the traceroute default; many networks drop it, so only 3/10 destinations were reached
const METHOD_ARGS = { icmp: ['-I'], tcp: ['-T', '-p', '443'], udp: [] };

function spawnTrace(host, useIPv6, method, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    if (!isSafeHost(host)) return resolve({ hops: [], destIp: null, error: 'Invalid host' });
    // `traceroute -6` instead of the separate traceroute6 binary (absent on newer distros)
    const args = [...(useIPv6 ? ['-6'] : []), ...METHOD_ARGS[method], '-n', '-m', '30', '-w', '2', '-q', '3', '--', host];
    const proc = spawn('traceroute', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseOutput(stdout, useIPv6);
      const error = extra.error ?? (parsed.hops.length === 0 && stderr.trim() ? stderr.trim() : null);
      resolve({ ...parsed, error });
    };
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    // On timeout keep what we have: a partial path is far more useful than nothing
    const timer = setTimeout(() => { proc.kill(); finish({ error: `Timed out after ${timeoutMs / 1000}s (partial result)` }); }, timeoutMs);
    proc.on('close', () => finish());
    proc.on('error', (err) => { stderr = err.message; finish({ error: err.message }); });
  });
}

const lastAnswered = (hops) => [...hops].reverse().find((h) => !h.timeout);
const reached = (r) => {
  const last = lastAnswered(r.hops);
  return !!(last && r.destIp && (last.ips.includes(r.destIp) || last.probes.some((p) => p.ip === r.destIp)));
};
const quality = (r) => (reached(r) ? 1000 : 0) + r.hops.filter((h) => !h.timeout).length - r.hops.filter((h) => h.timeout).length;

/**
 * Trace with the first method that reaches the destination. 'auto' tries ICMP, then TCP, then UDP
 * and keeps the best result, so a target that blocks one kind of probe still gets a full path.
 */
async function trace(host, useIPv6 = false, method = 'auto') {
  const order = method === 'auto' ? ['icmp', 'tcp', 'udp'] : [method];
  let best = null;
  for (const m of order) {
    const r = await spawnTrace(host, useIPv6, m);
    r.method = m;
    r.complete = reached(r);
    if (!best || quality(r) > quality(best)) best = r;
    if (r.complete) break;
    // ICMP/TCP need raw sockets; without them there is no point trying the same thing again
    if (/not permitted|permission/i.test(r.error || '') && m !== 'udp') continue;
  }
  return best;
}

async function runTraceroute(host, useIPv6 = false, method = 'auto') {
  const r = await trace(host, useIPv6, method);
  if (r.hops.length === 0) return r;

  // rDNS lookups in parallel for all public hops
  const rdns = await Promise.all(r.hops.map((h) => (h.ip && !h.hidden ? reverseLookup(h.ip) : Promise.resolve(null))));
  return { ...r, hops: r.hops.map((h, i) => ({ ...h, rdns: rdns[i] })) };
}

const runTraceroute6 = (host, method) => runTraceroute(host, true, method);

module.exports = { runTraceroute, runTraceroute6, isPrivate, parseLine, parseOutput, reached, METHOD_ARGS };
