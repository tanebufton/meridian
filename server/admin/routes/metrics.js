'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { getDb, dbPath } = require('../../db/db');
const { getTargetStates } = require('../../shared/status');
const { activeWindows } = require('../../shared/maintenance');

// Prometheus text exposition (v0.0.4). Enabled by setting METRICS_TOKEN in .env, then:
//   scrape_configs:
//     - job_name: meridian
//       metrics_path: /metrics
//       authorization: { credentials: <METRICS_TOKEN> }
//       static_configs: [{ targets: ['meridian-host:3002'] }]
// A logged-in admin session also works (handy for eyeballing it in a browser).

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labels = (obj) => '{' + Object.entries(obj).map(([k, v]) => `${k}="${esc(v)}"`).join(',') + '}';

// A short token is brute-forceable, so anything under 16 characters is treated as "not set"
const configuredToken = () => (process.env.METRICS_TOKEN && process.env.METRICS_TOKEN.length >= 16 ? process.env.METRICS_TOKEN : null);

function tokenOk(header) {
  const want = configuredToken();
  if (!want || !header) return false;
  const m = String(header).match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function render() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const states = getTargetStates(db, now);

  const out = [];
  const family = (name, help, type = 'gauge') => { out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); };
  const sample = (name, lab, value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    out.push(`${name}${lab ? labels(lab) : ''} ${value}`);
  };
  const base = (s) => ({ target_id: s.id, target: s.name, host: s.host, group: s.group_name, probe_type: s.probe_type });

  family('meridian_target_up', '1 if the target is not DOWN according to its latest probe');
  for (const s of states) if (s.status !== 'UNKNOWN') sample('meridian_target_up', base(s), s.status === 'DOWN' ? 0 : 1);

  family('meridian_target_degraded', '1 if the latest probe shows partial packet loss');
  for (const s of states) if (s.status !== 'UNKNOWN') sample('meridian_target_degraded', base(s), s.status === 'DEGRADED' ? 1 : 0);

  family('meridian_target_latency_seconds', 'Latency of the latest probe (min/avg/max across its packets)');
  for (const s of states) {
    const ms = s.probe_type === 'dns'
      ? { avg: s.dns_time }
      : { min: s.latency_min, avg: s.latency_avg, max: s.latency_max };
    for (const [stat, v] of Object.entries(ms)) if (v != null) sample('meridian_target_latency_seconds', { ...base(s), stat }, v / 1000);
  }

  family('meridian_target_jitter_seconds', 'Latency standard deviation (mdev) of the latest probe');
  for (const s of states) if (s.latency_mdev != null) sample('meridian_target_jitter_seconds', base(s), s.latency_mdev / 1000);

  family('meridian_target_packet_loss_ratio', 'Packet loss of the latest probe, 0 to 1');
  for (const s of states) if (s.packet_loss != null) sample('meridian_target_packet_loss_ratio', base(s), s.packet_loss / 100);

  family('meridian_target_uptime_ratio', 'Share of successful probes over the window, 0 to 1');
  for (const s of states) {
    for (const [w, v] of [['24h', s.uptime_24h], ['7d', s.uptime_7d], ['30d', s.uptime_30d]]) {
      if (v != null) sample('meridian_target_uptime_ratio', { ...base(s), window: w }, v / 100);
    }
  }

  family('meridian_target_last_probe_timestamp_seconds', 'Unix time of the latest probe (alert if this stops advancing)');
  for (const s of states) if (s.last_checked) sample('meridian_target_last_probe_timestamp_seconds', base(s), s.last_checked);

  family('meridian_target_in_maintenance', '1 if a maintenance window currently covers the target');
  for (const s of states) sample('meridian_target_in_maintenance', base(s), s.in_maintenance ? 1 : 0);

  family('meridian_target_incident_open', '1 if there is an open (confirmed) incident for the target');
  for (const s of states) sample('meridian_target_incident_open', base(s), s.incident_id ? 1 : 0);

  family('meridian_target_incident_acknowledged', '1 if the open incident has been acknowledged');
  for (const s of states) if (s.incident_id) sample('meridian_target_incident_acknowledged', base(s), s.incident_ack_at ? 1 : 0);

  family('meridian_targets', 'Enabled targets by current status');
  const counts = { up: 0, degraded: 0, down: 0, unknown: 0, maintenance: 0 };
  for (const s of states) {
    if (s.in_maintenance) counts.maintenance++;
    else counts[s.status.toLowerCase()]++;
  }
  for (const [state, n] of Object.entries(counts)) sample('meridian_targets', { state }, n);

  family('meridian_incidents_total', 'Incidents opened since the start of recorded history', 'counter');
  sample('meridian_incidents_total', null, db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n);

  family('meridian_maintenance_windows_active', 'Maintenance windows active right now');
  sample('meridian_maintenance_windows_active', null, activeWindows(db, now).length);

  family('meridian_probe_results_rows', 'Rows in the raw probe_results table');
  sample('meridian_probe_results_rows', null, db.prepare('SELECT COUNT(*) AS n FROM probe_results').get().n);

  family('meridian_database_size_bytes', 'Size of the SQLite database file');
  try { sample('meridian_database_size_bytes', null, fs.statSync(dbPath).size); } catch { /* ignore */ }

  return out.join('\n') + '\n';
}

module.exports = async function metricsRoutes(app) {
  app.get('/metrics', async (req, reply) => {
    if (!tokenOk(req.headers.authorization) && !req.session) {
      // Disabled unless a token is configured; never reveal that the route exists otherwise
      if (!configuredToken()) return reply.status(404).send({ error: 'Not found' });
      return reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
    }
    return reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(render());
  });
};
