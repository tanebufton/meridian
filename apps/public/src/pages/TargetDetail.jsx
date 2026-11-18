import { useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  useTarget, useTargetResults, useGroups, useTargetEvents, useTargetUptime, useTargetIncidents, useAvailability,
} from '../hooks/useApi';
import LatencyChart from '../components/LatencyChart';
import TraceroutePanel from '../components/Traceroute';
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
  const setRange = (r) => { setZoom(null); setSearchParams({ range: r }, { replace: true }); };
  const groups = useGroups();
  const target = useTarget(id);
  const results = useTargetResults(id, range);
  const events = useTargetEvents(id, range);
  const [zoom, setZoom] = useState(null);
  const [scaleMode, setScaleMode] = useState('linear');

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

      {/* Latency + loss, one chart */}
      <div className="chart-card">
        <div className="chart-card-title chart-title-row">
          <span>Latency{t.probe_type === 'dns' ? ' (DNS resolution time)' : ''}</span>
          <span className="chart-controls">
            {zoom && <button className="chip-btn" onClick={() => setZoom(null)}>Reset zoom</button>}
            {t.probe_type !== 'dns' && (
              <span className="seg" role="group" aria-label="Scale">
                <button className={scaleMode === 'linear' ? 'on' : ''} onClick={() => setScaleMode('linear')} title="Starts at 0 ms — the honest picture">Linear</button>
                <button className={scaleMode === 'fit' ? 'on' : ''} onClick={() => setScaleMode('fit')} title="Zoom the vertical axis to the data so small changes are visible">Fit</button>
                <button className={scaleMode === 'log' ? 'on' : ''} onClick={() => setScaleMode('log')} title="Log scale: small and large values readable together">Log</button>
              </span>
            )}
          </span>
        </div>
        {results.isLoading
          ? <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner" style={{ margin: 0 }} /></div>
          : <LatencyChart data={results.data?.data} probeType={t.probe_type} range={range} events={events.data} scaleMode={scaleMode} zoom={zoom} onZoom={setZoom} />}
        <div className="chart-legend">
          <span><i className="lg line" />Average</span>
          {t.probe_type !== 'dns' && <><span><i className="lg band" />Min–max</span><span><i className="lg dash" />95th percentile</span><span><i className="lg loss" />Packet loss</span></>}
          {events.data?.incidents?.length > 0 && <span><i className="lg out" />Outage</span>}
          {events.data?.maintenance?.length > 0 && <span><i className="lg maint" />Maintenance</span>}
          {events.data?.route_changes?.length > 0 && <span><i className="lg route" />Route change</span>}
          <span className="muted" style={{ marginLeft: 'auto' }}>Drag across the chart to zoom</span>
        </div>
      </div>

      <AvailabilityBars targetId={id} />
      <IncidentList targetId={id} />
      <Tools target={t} rows={results.data?.data || []} range={range} />

      {/* Traceroute */}
      <TraceroutePanel targetId={id} />
    </div>
  );
}
