'use strict';

const { spawn } = require('child_process');

/**
 * Run a ping probe against host with packetCount packets.
 * Returns { latency_min, latency_avg, latency_max, latency_mdev, packet_loss, rtts, error }
 *
 * -i 1  : 1s between packets, matching fping/Smokeping default period.
 *          Using 0.5s caused ICMP rate-limiting on CDN targets (false 100% loss).
 * -W 5  : 5s per-packet reply timeout. Default 1s records 100% loss on high-latency hosts.
 * -w    : hard deadline so a stalled probe never blocks the scheduler slot.
 */
function pingHost(host, packetCount) {
  return new Promise((resolve) => {
    const deadline = packetCount + 15;
    const args = ['-c', String(packetCount), '-i', '1', '-W', '5', '-w', String(deadline), host];
    const proc = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', () => {
      // Parse individual packet RTTs: "64 bytes from X: icmp_seq=N ttl=Y time=Z ms"
      const rttBySeq = {};
      for (const line of stdout.split('\n')) {
        const m = line.match(/icmp_seq=(\d+).*time=([\d.]+)/);
        if (m) rttBySeq[parseInt(m[1], 10)] = parseFloat(m[2]);
      }
      // Ordered array — null means that packet was lost (seq is 1-based)
      const rtts = Array.from({ length: packetCount }, (_, i) => rttBySeq[i + 1] ?? null);

      // Summary line: "rtt min/avg/max/mdev = X/Y/Z/W ms"
      const rttMatch = stdout.match(/(?:rtt|round-trip)\s+min\/avg\/max(?:\/\w+)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/);

      // Packet loss: "N% packet loss"
      const lossMatch = stdout.match(/([\d.]+)%\s+packet\s+loss/);
      const packet_loss = lossMatch ? parseFloat(lossMatch[1]) : 100;

      // Resolved IP: first line is "PING hostname (1.2.3.4) ..."
      const resolvedMatch = stdout.match(/^PING\s+\S+\s+\((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)/m);
      const resolved_ip = resolvedMatch ? resolvedMatch[1] : null;

      if (rttMatch) {
        resolve({
          latency_min:  parseFloat(rttMatch[1]),
          latency_avg:  parseFloat(rttMatch[2]),
          latency_max:  parseFloat(rttMatch[3]),
          latency_mdev: parseFloat(rttMatch[4]),
          packet_loss,
          rtts,
          resolved_ip,
          error: null,
        });
      } else {
        const errMsg = stderr.trim() || stdout.trim() || 'ping failed';
        resolve({
          latency_min:  null,
          latency_avg:  null,
          latency_max:  null,
          latency_mdev: null,
          packet_loss:  100,
          rtts,
          resolved_ip,
          error: errMsg.slice(0, 500),
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
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

module.exports = { pingHost };
