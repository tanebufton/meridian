'use strict';

const { spawn } = require('child_process');
const { isSafeHost } = require('../shared/hosts');

/**
 * Run a ping probe against host with packetCount packets.
 * Returns { latency_min, latency_avg, latency_max, latency_mdev, packet_loss, rtts, error }
 *
 * -i 1  : 1s between packets, matching fping/Smokeping default period.
 *          Using 0.5s caused ICMP rate-limiting on CDN targets (false 100% loss).
 * -W 5  : 5s per-packet reply timeout. Default 1s records 100% loss on high-latency hosts.
 * -w    : hard deadline so a stalled probe never blocks the scheduler slot.
 */
function pingHost(host, packetCount, useIPv6 = false) {
  return new Promise((resolve) => {
    // Hosts come from the database. Never let one be parsed as an option (e.g. "-f").
    if (!isSafeHost(host)) {
      return resolve({
        latency_min: null, latency_avg: null, latency_max: null, latency_mdev: null,
        packet_loss: 100, rtts: Array(packetCount).fill(null), resolved_ip: null,
        error: 'Invalid host',
      });
    }
    const deadline = packetCount + 15;
    // `ping -6` rather than `ping6`: the ping6 binary is absent on many modern distros.
    const args = [...(useIPv6 ? ['-6'] : []), '-c', String(packetCount), '-i', '1', '-W', '5', '-w', String(deadline), '--', host];
    const proc = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', () => resolve(parsePingOutput(stdout, stderr, packetCount)));

    proc.on('error', (err) => {
      resolve({
        resolved_ip:  null,
        latency_min:  null,
        latency_avg:  null,
        latency_max:  null,
        latency_mdev: null,
        packet_loss:  100,
        rtts:         Array(packetCount).fill(null),
        error: err.message,
      });
    });
  });
}

/**
 * Turn the text of a finished `ping` run into a probe result. Pure, so it can be tested against
 * captured output (iputils and busybox formats, total loss, resolver errors...).
 */
function parsePingOutput(stdout, stderr, packetCount) {
  // Individual packet RTTs: "64 bytes from X: icmp_seq=N ttl=Y time=Z ms"
  const rttBySeq = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/icmp_seq=(\d+).*time=([\d.]+)/);
    if (m) rttBySeq[parseInt(m[1], 10)] = parseFloat(m[2]);
  }
  // Ordered array — null means that packet was lost (seq is 1-based)
  const rtts = Array.from({ length: packetCount }, (_, i) => rttBySeq[i + 1] ?? null);

  // Summary line: "rtt min/avg/max/mdev = X/Y/Z/W ms" (iputils) or "round-trip min/avg/max = X/Y/Z ms" (busybox)
  const rttMatch = stdout.match(/(?:rtt|round-trip)\s+min\/avg\/max(?:\/\w+)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?/);
  const lossMatch = stdout.match(/([\d.]+)%\s+packet\s+loss/);
  const packet_loss = lossMatch ? parseFloat(lossMatch[1]) : 100;

  // Resolved IP: "PING hostname (1.2.3.4) 56(84) bytes" — same shape for v4 and v6
  const resolvedMatch = stdout.match(/^PING\s+\S+\s+\(([0-9a-fA-F:.]+)\)/m);
  const resolved_ip = resolvedMatch ? resolvedMatch[1] : null;

  if (rttMatch) {
    return {
      latency_min:  parseFloat(rttMatch[1]),
      latency_avg:  parseFloat(rttMatch[2]),
      latency_max:  parseFloat(rttMatch[3]),
      latency_mdev: rttMatch[4] !== undefined ? parseFloat(rttMatch[4]) : null,
      packet_loss, rtts, resolved_ip, error: null,
    };
  }
  const errMsg = stderr.trim() || stdout.trim() || 'ping failed';
  return {
    latency_min: null, latency_avg: null, latency_max: null, latency_mdev: null,
    packet_loss: 100, rtts, resolved_ip, error: errMsg.slice(0, 500),
  };
}

function ping6Host(host, packetCount) {
  return pingHost(host, packetCount, true);
}

module.exports = { pingHost, ping6Host, parsePingOutput };
