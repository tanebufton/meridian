import { useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import {
  useTarget, useTargetResults, useGroups, useTraceroute, useTracerouteHistory,
  useTargetUptime, useTargetIncidents, useAvailability,
} from '../hooks/useApi';
import LatencyChart, { fmtTsAxis } from '../components/LatencyChart';
import StatusBadge from '../components/StatusBadge';
import { fmtDuration } from '../lib';

const RANGES = ['1h', '6h', '12h', '24h', '7d', '30d', '3mo'];

function fmt(val, unit = 'ms') {
  if (val === null || val === undefined) return '—';
  return `${Number(val).toFixed(1)}${unit}`;
}
function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString();
}

function LossChart({ data, probeType, range }) {
  if (!data || data.length === 0) return null;

  const isDns = probeType === 'dns';
  const chartData = data.map((d) => {
    // Prefer packet_loss (present in both raw ICMP and all aggregates after rollup fix).
    // Fall back to dns_success for raw DNS results where packet_loss is NULL.
    let loss;
    if (d.packet_loss !== null && d.packet_loss !== undefined) {
      loss = d.packet_loss;
    } else if (isDns && d.dns_success !== null && d.dns_success !== undefined) {
      loss = d.dns_success === 0 ? 100 : 0;
    } else {
      loss = null;
    }
    return { ts: d.timestamp, loss };
  });

  return (
    <ResponsiveContainer width="100%" height={80}>
      <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="ts" tickFormatter={(ts) => fmtTsAxis(ts, range)} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
        <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} unit="%" width={36} domain={[0, 100]} />
        <Tooltip
          contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
          labelFormatter={(v) => fmtTs(v)}
          formatter={(v) => [v !== null ? `${Number(v).toFixed(1)}%` : '—', isDns ? 'Failures' : 'Loss']}
        />
        <Bar dataKey="loss" fill="#ef4444" fillOpacity={0.75} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function fmtAgo(ts) {
  if (!ts) return null;
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function HopTable({ hops }) {
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: 32 }}>#</th>
          <th>IP</th>
          <th>Hostname</th>
          <th>RTT 1</th>
          <th>RTT 2</th>
          <th>RTT 3</th>
        </tr>
      </thead>
      <tbody>
        {hops.map((h, i) => (
          <tr key={i}>
            <td style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{h.hop}</td>
            <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
              {h.hidden
                ? <span style={{ color: 'var(--text-muted)' }}>private</span>
                : h.ip || <span style={{ color: 'var(--text-muted)' }}>*</span>
              }
            </td>
            <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {h.rdns || (h.hidden ? '' : '—')}
            </td>
            {[0, 1, 2].map((j) => (
              <td key={j} style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {h.rtts?.[j] != null
                  ? `${Number(h.rtts[j]).toFixed(1)}ms`
                  : <span style={{ color: 'var(--text-dim)' }}>*</span>
                }
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TracerouteHistory({ targetId, currentRanAt }) {
  const hist = useTracerouteHistory(targetId);
  const [expandedId, setExpandedId] = useState(null);

  const entries = (hist.data?.history || []).filter((e) => e.ran_at !== currentRanAt);
  if (hist.isLoading || entries.length === 0) return null;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 8 }}>
        Route Changes &nbsp;·&nbsp; {entries.length} recorded
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map((entry) => {
          const publicHops = entry.hops.filter((h) => h.ip && !h.hidden).length;
          const isOpen = expandedId === entry.id;
          return (
            <div key={entry.id} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', cursor: 'pointer', userSelect: 'none', background: isOpen ? 'var(--card-hover, var(--card))' : 'transparent' }}
                onClick={() => setExpandedId(isOpen ? null : entry.id)}
              >
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {isOpen ? '▾' : '▸'} {fmtTs(entry.ran_at)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  {entry.hops.length} hops &nbsp;·&nbsp; {publicHops} public
                </span>
              </div>
              {isOpen && (
                <div style={{ padding: '8px 10px 10px', borderTop: '1px solid var(--border)' }}>
                  <HopTable hops={entry.hops} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TraceroutePanel({ targetId }) {
  const tr = useTraceroute(targetId);
  const [open, setOpen] = useState(false);

  const ranAt = tr.data?.ran_at;
  const hops = tr.data?.hops;

  return (
    <div className="chart-card" style={{ marginTop: 14 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          {open ? '▾' : '▸'} Traceroute
        </span>
        {ranAt && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Updated {fmtAgo(ranAt)}
          </span>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {!hops || hops.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>
              {tr.isLoading
                ? 'Loading…'
                : ranAt
                ? 'Traceroute returned no hops — host may block ICMP probes, or will retry shortly.'
                : 'No traceroute data yet — the probe worker runs this automatically.'}
            </div>
          ) : (
            <HopTable hops={hops} />
          )}
          <TracerouteHistory targetId={targetId} currentRanAt={ranAt} />
        </div>
      )}
    </div>
  );
}


// 90-day availability, one bar per UTC day — the status-page staple
function AvailabilityBars({ targetId }) {
  const q = useAvailability(targetId, 90);
  if (q.isLoading) return null;
  const days = q.data?.data || [];
  if (!days.some((d) => d.uptime != null)) return null;
  const color = (u) => (u == null ? 'var(--border)' : u >= 99.9 ? 'var(--success)' : u >= 99 ? '#84cc16' : u >= 95 ? 'var(--warning)' : 'var(--danger)');
  const known = days.filter((d) => d.uptime != null);
  const avg = known.reduce((n, d) => n + d.uptime, 0) / known.length;
  return (
    <div className="chart-card" style={{ marginTop: 14 }}>
      <div className="chart-card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Last {days.length} days</span><span style={{ textTransform: 'none', letterSpacing: 0 }}>{avg.toFixed(avg >= 99.95 ? 2 : 1)}% average</span>
      </div>
      <div className="avail-bars" role="img" aria-label={`Daily availability over the last ${days.length} days`}>
        {days.map((d) => (
          <span key={d.day} className="avail-bar" style={{ background: color(d.uptime) }}
            title={`${new Date(d.day * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })}: ${d.uptime == null ? 'no data' : `${d.uptime.toFixed(2)}% up`}`} />
        ))}
      </div>
      <div className="avail-legend"><span>{days.length} days ago</span><span>Today</span></div>
    </div>
  );
}

function UptimeChips({ targetId }) {
  const q = useTargetUptime(targetId);
  if (!q.data) return null;
  const chip = (label, v) => (
    <div className="uptime-chip">
      <div className="uptime-pct" style={{ color: v == null ? 'var(--text-muted)' : v >= 99.9 ? 'var(--success)' : v >= 99 ? 'var(--warning)' : 'var(--danger)' }}>
        {v == null ? '—' : `${v.toFixed(v >= 99.95 ? 2 : 1)}%`}
      </div>
      <div className="uptime-label">{label}</div>
    </div>
  );
  return <>{chip('Uptime 24h', q.data.uptime_24h)}{chip('7d', q.data.uptime_7d)}{chip('30d', q.data.uptime_30d)}</>;
}

function IncidentList({ targetId }) {
  const q = useTargetIncidents(targetId);
  const list = (q.data?.incidents || []).slice(0, 8);
  if (list.length === 0) return null;
  return (
    <div className="chart-card" style={{ marginTop: 14 }}>
      <div className="chart-card-title">Recent incidents</div>
      {list.map((i) => (
        <div key={i.id} className="incident-row static">
          <span className={`incident-dot ${i.ongoing ? 'down' : 'ok'}`} />
          <span className="incident-name">{i.ongoing ? 'Ongoing' : 'Resolved'}{i.during_maintenance && <span className="badge badge-maint" style={{ marginLeft: 8 }}>maintenance</span>}</span>
          <span className="muted">{fmtDuration(i.duration_seconds)} · {fmtTs(i.started_at)}</span>
        </div>
      ))}
    </div>
  );
}

function Tools({ target, rows, range }) {
  const [copied, setCopied] = useState('');
  const origin = window.location.origin;
  const badge = `${origin}/badge/${target.id}.svg`;

  function csv() {
    const head = 'timestamp_iso,latency_min_ms,latency_avg_ms,latency_max_ms,packet_loss_pct,dns_time_ms\n';
    const num = (v) => (v == null ? '' : v);
    const body = rows.map((d) => [new Date(d.timestamp * 1000).toISOString(), num(d.latency_min), num(d.latency_avg), num(d.latency_max), num(d.packet_loss), num(d.dns_time)].join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([head + body + '\n'], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${target.name.replace(/[^\w.-]+/g, '_')}-${range}.csv` });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  async function copy(key, text) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1800); } catch { /* clipboard unavailable */ }
  }

  return (
    <details className="chart-card tools" style={{ marginTop: 14 }}>
      <summary>Share &amp; export</summary>
      <div className="tools-body">
        <div className="tools-row">
          <button className="chip-btn" onClick={csv} disabled={!rows.length}>Download CSV ({range})</button>
          <button className="chip-btn" onClick={() => copy('link', window.location.href)}>{copied === 'link' ? 'Copied ✓' : 'Copy link'}</button>
        </div>
        <div className="tools-badge">
          <img src={`/badge/${target.id}.svg`} alt={`${target.name} status badge`} height="20" />
          <button className="chip-btn" onClick={() => copy('md', `![${target.name}](${badge})`)}>{copied === 'md' ? 'Copied ✓' : 'Copy Markdown'}</button>
          <button className="chip-btn" onClick={() => copy('html', `<img src="${badge}" alt="${target.name} status">`)}>{copied === 'html' ? 'Copied ✓' : 'Copy HTML'}</button>
        </div>
      </div>
    </details>
  );
}

export default function TargetDetail() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const range = RANGES.includes(searchParams.get('range')) ? searchParams.get('range') : '6h';
  const setRange = (r) => setSearchParams({ range: r }, { replace: true });
  const groups = useGroups();
  const target = useTarget(id);
  const results = useTargetResults(id, range);

  if (target.isLoading) return <div className="spinner" />;
  if (target.isError) return <div className="error-state">Target not found.</div>;

  const t = target.data;

  // Find parent group for breadcrumb
  const parentGroup = groups.data?.find((g) => g.id === t.group_id);

  return (
    <div>
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, display: 'flex', gap: 5, alignItems: 'center', lineHeight: 1 }}>
        <Link to="/" className="detail-back">Overview</Link>
        <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>›</span>
        {parentGroup && (
          <>
            <Link to={`/group/${parentGroup.id}`} className="detail-back">{parentGroup.name}</Link>
            <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>›</span>
          </>
        )}
        <span style={{ color: 'var(--text)' }}>{t.name}</span>
      </div>

      {/* Header */}
      <div className="detail-header">
        <div>
          <div className="detail-title">{t.name} <StatusBadge status={t.in_maintenance ? 'MAINTENANCE' : t.status} /></div>
          <div className="detail-meta">
            <span style={{ fontFamily: 'monospace' }}>{t.host}</span>
            <span>{t.probe_type.toUpperCase()}</span>
            <span>every {t.interval_seconds}s</span>
            {t.latest?.resolved_ip && t.latest.resolved_ip !== t.host && (
              <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>→ {t.latest.resolved_ip}</span>
            )}
          </div>
        </div>
      </div>

      {t.in_maintenance && (
        <div className="banner" style={{ border: '1px solid rgba(139,92,246,0.35)', background: 'rgba(139,92,246,0.08)', color: 'var(--maint)' }}>
          <strong>Scheduled maintenance{t.maintenance_name ? `: ${t.maintenance_name}` : ''}.</strong>{' '}
          {t.maintenance_ends_at ? `Expected to finish around ${new Date(t.maintenance_ends_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''}
        </div>
      )}
      {!t.in_maintenance && t.incident_started_at && (
        <div className="banner" style={{ border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)', color: 'var(--danger)' }}>
          <strong>Currently down</strong> — for {fmtDuration(Math.floor(Date.now() / 1000) - t.incident_started_at)}.{t.incident_acknowledged ? ' Someone is looking into it.' : ''}
        </div>
      )}

      {/* Notes */}
      {t.notes && (
        <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--card)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          {t.notes}
        </div>
      )}

      {/* Latency + jitter stats (computed from visible range) */}
      {(() => {
        const rangeData = results.data?.data || [];
        const validRows = rangeData.filter((d) => d.latency_avg != null && d.packet_loss < 100);
        const minL = validRows.length ? Math.min(...validRows.map((d) => d.latency_min ?? d.latency_avg)) : null;
        const avgL = validRows.length ? validRows.reduce((s, d) => s + d.latency_avg, 0) / validRows.length : null;
        const maxL = validRows.length ? Math.max(...validRows.map((d) => d.latency_max ?? d.latency_avg)) : null;
        return (
          <div className="uptime-strip">
            <div className="uptime-chip">
              <div className="uptime-pct" style={{ color: 'var(--success)' }}>{minL != null ? `${minL.toFixed(1)}ms` : '—'}</div>
              <div className="uptime-label">Min</div>
            </div>
            <div className="uptime-chip">
              <div className="uptime-pct" style={{ color: 'var(--accent)' }}>{avgL != null ? `${avgL.toFixed(1)}ms` : '—'}</div>
              <div className="uptime-label">Avg</div>
            </div>
            <div className="uptime-chip">
              <div className="uptime-pct" style={{ color: 'var(--warning)' }}>{maxL != null ? `${maxL.toFixed(1)}ms` : '—'}</div>
              <div className="uptime-label">Max</div>
            </div>
            <UptimeChips targetId={id} />
          </div>
        );
      })()}

      {/* Time range tabs */}
      <div className="tabs">
        {RANGES.map((r) => (
          <button key={r} className={`tab ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
      </div>

      {/* Latency chart */}
      <div className="chart-card">
        <div className="chart-card-title">Latency (ms)</div>
        {results.isLoading ? <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" style={{ margin: 0 }} /></div> : <LatencyChart data={results.data?.data} probeType={t.probe_type} range={range} />}
      </div>

      {/* Loss chart */}
      <div className="chart-card">
        <div className="chart-card-title">{t.probe_type === 'dns' ? 'DNS Failures' : 'Packet Loss (%)'}</div>
        {results.isLoading ? null : <LossChart data={results.data?.data} probeType={t.probe_type} range={range} />}
      </div>

      <AvailabilityBars targetId={id} />
      <IncidentList targetId={id} />
      <Tools target={t} rows={results.data?.data || []} range={range} />

      {/* Traceroute */}
      <TraceroutePanel targetId={id} />
    </div>
  );
}
