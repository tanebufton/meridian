import { useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  ComposedChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Customized,
} from 'recharts';
import { useTarget, useTargetResults, useGroups, useTraceroute, useTracerouteHistory } from '../hooks/useApi';

const RANGES = ['1h', '6h', '12h', '24h', '7d', '30d', '3mo'];

function fmt(val, unit = 'ms') {
  if (val === null || val === undefined) return '—';
  return `${Number(val).toFixed(1)}${unit}`;
}
function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString();
}

// Range-aware axis label — short ranges show HH:MM, multi-day show "Jan 15" or "Mon 14:00"
function fmtTsAxis(ts, range) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (range === '1h' || range === '6h' || range === '12h' || range === '24h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (range === '7d') {
    return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
  }
  // 30d, 3mo
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Renders the min→max spread band as a polygon — Smokeping style.
// Splits into segments at loss gaps so the band breaks cleanly.
function SpreadBand({ xAxisMap, yAxisMap, probeData }) {
  const chartData = probeData;
  const xScale = Object.values(xAxisMap || {})[0]?.scale;
  const yScale = Object.values(yAxisMap || {})[0]?.scale;
  if (!xScale || !yScale) return null;

  const segments = [];
  let cur = [];
  for (const d of chartData) {
    if (d.max != null && d.min != null) {
      cur.push(d);
    } else if (cur.length > 0) {
      segments.push([...cur]);
      cur = [];
    }
  }
  if (cur.length > 0) segments.push(cur);

  return (
    <g>
      {segments.map((seg, i) => {
        const top = seg.map((d) => `${xScale(d.ts).toFixed(1)},${yScale(d.max).toFixed(1)}`).join(' ');
        const btm = [...seg].reverse().map((d) => `${xScale(d.ts).toFixed(1)},${yScale(d.min).toFixed(1)}`).join(' ');
        return (
          <g key={i}>
            <polygon points={`${top} ${btm}`} fill="#7b61ff" fillOpacity={0.18} stroke="none" />
            <polyline points={top} fill="none" stroke="#7b61ff" strokeOpacity={0.4} strokeWidth={0.75} />
          </g>
        );
      })}
    </g>
  );
}

function LatencyChart({ data, probeType, range }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
        No data for this time range
      </div>
    );
  }

  const isDns = probeType === 'dns';

  // chartData: only fields Recharts reads for series/domain.
  const chartData = data.map((d) => {
    const totalLoss = d.packet_loss >= 100;
    return {
      ts: d.timestamp,
      avg: isDns ? d.dns_time : (totalLoss ? null : d.latency_avg),
      min: isDns || totalLoss ? null : d.latency_min,
      max: isDns || totalLoss ? null : d.latency_max,
    };
  });

  // probeData: for the spread band polygon (min→max).
  const probeData = data.map((d) => {
    const totalLoss = d.packet_loss >= 100;
    return {
      ts: d.timestamp,
      min: isDns || totalLoss ? null : d.latency_min,
      max: isDns || totalLoss ? null : d.latency_max,
    };
  });

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']}
               tickFormatter={(ts) => fmtTsAxis(ts, range)}
               tick={{ fill: 'var(--text-muted)', fontSize: 10 }} tickCount={6} />
        <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} unit="ms" width={48} />
        <Tooltip
          contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
          labelFormatter={(v) => fmtTs(v)}
          formatter={(val, name) => [val !== null ? `${Number(val).toFixed(1)}ms` : '—', name]}
        />
        {/* Hidden series so Recharts includes min/max in the Y-axis domain */}
        {!isDns && <Line dataKey="min" stroke="none" dot={false} legendType="none" tooltipType="none" connectNulls={false} />}
        {!isDns && <Line dataKey="max" stroke="none" dot={false} legendType="none" tooltipType="none" connectNulls={false} />}
        {/* 1 — Spread band (min→max polygon), behind the avg line */}
        {!isDns && <Customized component={(props) => <SpreadBand {...props} probeData={probeData} />} />}
        {/* 2 — Avg/median trend line */}
        <Line type="monotone" dataKey="avg" stroke="#7b61ff" dot={false} strokeWidth={2}
              name={isDns ? 'DNS time' : 'Avg'} connectNulls={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
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
          <div className="detail-title">{t.name}</div>
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

      {/* Traceroute */}
      <TraceroutePanel targetId={id} />
    </div>
  );
}
