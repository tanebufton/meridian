'use strict';

const { spawn } = require('child_process');
const { promises: dnsPromises } = require('dns');

const PRIVATE_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^127\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function isPrivate(ip) {
  if (!ip) return false;
  return PRIVATE_RANGES.some((r) => r.test(ip));
}

function parseLine(line) {
  const m = line.match(/^\s*(\d+)\s+(.*)/);
  if (!m) return null;

  const hop = parseInt(m[1], 10);
  const rest = m[2].trim();

  if (/^[*\s]+$/.test(rest)) {
    return { hop, ip: null, rtts: [null, null, null], timeout: true, hidden: false, rdns: null };
  }

  const ipMatch = rest.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  const ip = ipMatch ? ipMatch[1] : null;

  const segments = [...rest.matchAll(/(\d+(?:\.\d+)?)\s*ms|\*/g)];
  const rtts = segments.map((s) => (s[0] === '*' ? null : parseFloat(s[1])));
  const hidden = ip ? isPrivate(ip) : false;

  return {
    hop,
    ip: hidden ? null : ip,
    rtts: rtts.length ? rtts : [null, null, null],
    timeout: rtts.every((r) => r === null),
    hidden,
    rdns: null,
  };
}

async function reverseLookup(ip) {
  try {
    const names = await dnsPromises.reverse(ip);
    return names[0] || null;
  } catch (err) {
    console.error(`rDNS lookup failed for ${ip}: ${err.code || err.message}`);
    return null;
  }
}

async function spawnTrace(host) {
  return new Promise((resolve) => {
    const args = ['-n', '-m', '20', '-w', '2', '-q', '3', host];
    const proc = spawn('traceroute', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ hops: [], error: 'Timed out after 60s' });
    }, 60_000);

    proc.on('close', () => {
      clearTimeout(timer);
      const hops = stdout.split('\n').map(parseLine).filter(Boolean);
      const error = hops.length === 0 && stderr.trim() ? stderr.trim() : null;
      resolve({ hops, error });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ hops: [], error: err.message });
    });
  });
}

async function runTraceroute(host) {
  const { hops, error } = await spawnTrace(host);

  if (hops.length === 0) return { hops, error };

  // rDNS lookups in parallel for all public (non-private) IPs
  const rdns = await Promise.all(
    hops.map((h) => (h.ip && !h.hidden ? reverseLookup(h.ip) : Promise.resolve(null)))
  );

  return {
    hops: hops.map((h, i) => ({ ...h, rdns: rdns[i] })),
    error,
  };
}

module.exports = { runTraceroute, isPrivate };
