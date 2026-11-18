'use strict';

const net = require('net');
const { parseTcpTarget } = require('../shared/hosts');

const TIMEOUT_MS = 5000;

function connectOnce(host, port) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(res);
    };
    socket.setTimeout(TIMEOUT_MS, () => finish({ error: 'Connection timed out' }));
    socket.once('connect', () => {
      finish({ ms: Number(process.hrtime.bigint() - started) / 1e6, ip: socket.remoteAddress || null });
    });
    socket.once('error', (err) => finish({ error: err.code || err.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * TCP connect probe. Makes `count` connection attempts one second apart (like ping's
 * -i 1) and reports the same shape as an ICMP probe: connect time is the latency and a
 * refused/timed-out attempt is a lost packet, so charts, rollups and uptime all work.
 */
async function tcpProbe(hostPort, count) {
  const parsed = parseTcpTarget(hostPort);
  const empty = (error) => ({
    latency_min: null, latency_avg: null, latency_max: null, latency_mdev: null,
    packet_loss: 100, rtts: Array(count).fill(null), resolved_ip: null, error,
  });
  if (!parsed) return empty('Invalid TCP target (expected host:port)');

  const rtts = [];
  let ip = null;
  let lastError = null;
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    const r = await connectOnce(parsed.host, parsed.port);
    if (r.error) { rtts.push(null); lastError = r.error; }
    else { rtts.push(Math.round(r.ms * 1000) / 1000); ip = r.ip || ip; }
    if (i < count - 1) await sleep(Math.max(0, 1000 - (Date.now() - t0)));
  }

  const ok = rtts.filter((v) => v !== null);
  if (ok.length === 0) return { ...empty(lastError || 'Connection failed'), rtts };

  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  const mdev = Math.sqrt(ok.reduce((a, b) => a + (b - avg) ** 2, 0) / ok.length);
  return {
    latency_min: Math.min(...ok),
    latency_avg: avg,
    latency_max: Math.max(...ok),
    latency_mdev: mdev,
    packet_loss: ((count - ok.length) / count) * 100,
    rtts,
    resolved_ip: ip,
    error: null,
  };
}

module.exports = { tcpProbe };
