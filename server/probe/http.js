'use strict';

const http = require('http');
const https = require('https');
const { parseHttpTarget } = require('../shared/hosts');

const TIMEOUT_MS = 10_000;

/**
 * HTTP(S) probe. One GET per run; latency is time to response headers (includes DNS,
 * TCP and TLS). 2xx and 3xx count as up (redirects are not followed), anything else —
 * including a timeout, TLS failure or 4xx/5xx — counts as a total failure.
 */
function httpProbe(url) {
  return new Promise((resolve) => {
    const failed = (error) => resolve({
      latency_min: null, latency_avg: null, latency_max: null, latency_mdev: null,
      packet_loss: 100, rtts: [null], resolved_ip: null, error: String(error).slice(0, 500),
    });

    const u = parseHttpTarget(url);
    if (!u) return failed('Invalid URL');

    const started = process.hrtime.bigint();
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: { 'User-Agent': 'Meridian/1.0 (+uptime probe)', Accept: '*/*' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e3) / 1e3;
      const ip = res.socket?.remoteAddress || null;
      res.destroy(); // headers are enough; don't download the body
      if (res.statusCode >= 400) return failed(`HTTP ${res.statusCode}`);
      resolve({
        latency_min: ms, latency_avg: ms, latency_max: ms, latency_mdev: 0,
        packet_loss: 0, rtts: [ms], resolved_ip: ip, error: null,
      });
    });

    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', (err) => failed(err.code || err.message));
    req.end();
  });
}

module.exports = { httpProbe };
