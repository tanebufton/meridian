// Shared formatting helpers for the public dashboard

export function fmtMs(val, d = 1) {
  if (val === null || val === undefined) return '—';
  return `${Number(val).toFixed(d)}ms`;
}
export function fmtPct(val, d = 1) {
  if (val === null || val === undefined) return '—';
  return `${Number(val).toFixed(d)}%`;
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtAgo(ts) {
  if (!ts) return null;
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return `${Math.max(0, secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export const fmtTs = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '—');

// A target in a maintenance window is shown as MAINTENANCE whatever its probe says
export const effectiveStatus = (t) => (t.in_maintenance ? 'MAINTENANCE' : t.status);

const RANK = { DOWN: 4, DEGRADED: 3, MAINTENANCE: 2, UP: 1, UNKNOWN: 0 };
export function worstStatus(targets) {
  let worst = 'UNKNOWN';
  for (const t of targets) {
    const s = effectiveStatus(t);
    if (RANK[s] > RANK[worst] && !(s === 'MAINTENANCE' && RANK[worst] >= RANK.UP)) worst = s;
  }
  return worst;
}

export const STATUS_LABEL = { UP: 'Up', DEGRADED: 'Degraded', DOWN: 'Down', MAINTENANCE: 'Maintenance', UNKNOWN: 'Unknown' };

export function latencyColor(ms) {
  if (ms == null) return 'var(--text)';
  if (ms < 50) return 'var(--success)';
  if (ms < 150) return 'var(--warning)';
  return 'var(--danger)';
}
export function lossColor(pct) {
  if (pct == null) return 'var(--text-muted)';
  if (pct === 0) return 'var(--success)';
  if (pct < 5) return 'var(--warning)';
  return 'var(--danger)';
}
