import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Customized,
} from 'recharts';
import { useGroups, useTargetResults } from '../hooks/useApi';

function fmt(val, unit = 'ms', d = 1) {
  if (val === null || val === undefined) return '—';
  return `${Number(val).toFixed(d)}${unit}`;
}

function latencyColor(ms) {
  if (ms == null) return 'var(--text)';
  if (ms < 50) return 'var(--success)';
  if (ms < 150) return 'var(--warning)';
  return 'var(--danger)';
}

function lossColor(pct) {
  if (pct == null) return 'var(--text-muted)';
  if (pct === 0) return 'var(--success)';
  if (pct < 5) return 'var(--warning)';
  return 'var(--danger)';
}

function fmtAgo(ts) {
  if (!ts) return null;
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

// Min→max spread band + max edge line (Smokeping-style), splits at loss gaps.
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
            {/* Max edge line — explicit upper boundary of the jitter band */}
            <polyline points={top} fill="none" stroke="#7b61ff" strokeOpacity={0.45} strokeWidth={0.75} />
          </g>
        );
      })}
    </g>
  );
}

// Packet loss strip — drawn at the chart baseline, inline with the latency data.
// Amber = low loss, orange = medium, red = high. No bar when loss is 0%.
function LossStrip({ xAxisMap, yAxisMap, probeData }) {
  const chartData = probeData;
  const xScale = Object.values(xAxisMap || {})[0]?.scale;
  const yScale = Object.values(yAxisMap || {})[0]?.scale;
  if (!xScale || !yScale) return null;

  const STRIP_H = 4;
  // Sit at the bottom of the chart data area (inline, not in the margin)
  const stripY = (yScale.range()?.[1] ?? 80) - STRIP_H;

  // Bar width from the typical probe interval
  const pts = chartData.filter((d) => isFinite(xScale(d.ts)));
  if (pts.length < 2) return null;
  const barW = Math.max(2, (xScale(pts[pts.length - 1].ts) - xScale(pts[0].ts)) / (pts.length - 1));

  return (
    <g>
      {chartData.map((d, i) => {
        if (d.loss == null || d.loss === 0) return null;
        const cx = xScale(d.ts);
        if (!isFinite(cx)) return null;
        const fill = d.loss > 50 ? '#ef4444' : d.loss > 10 ? '#f97316' : '#f59e0b';
        return (
          <rect key={i} x={cx - barW / 2} y={stripY} width={barW} height={STRIP_H}
                fill={fill} fillOpacity={0.85} rx={1} />
        );
      })}
    </g>
  );
}

function MiniChart({ targetId, probeType }) {
  const results = useTargetResults(targetId, '12h');

  if (results.isLoading) {
    return (
      <div style={{ height: 88, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 12, height: 12, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  const data = results.data?.data || [];
  if (data.length === 0) {
    return <div style={{ height: 88, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--text-muted)' }}>No data yet</div>;
  }

  const isDns = probeType === 'dns';

  // chartData: only the fields Recharts reads for series/domain — no extra fields
  // that could corrupt the Y-axis scale.
  const chartData = data.map((d) => {
    const lost = !isDns && d.packet_loss >= 100;
    return {
      ts: d.timestamp,
      avg: isDns ? d.dns_time : (lost ? null : d.latency_avg),
      min: lost ? null : d.latency_min,
      max: lost ? null : d.latency_max,
    };
  });

  // probeData: for the spread band polygon and loss strip.
  const probeData = data.map((d) => {
    const lost = !isDns && d.packet_loss >= 100;
    return {
      ts: d.timestamp,
      min: lost ? null : d.latency_min,
      max: lost ? null : d.latency_max,
      loss: d.packet_loss,
    };
  });

  return (
    <ResponsiveContainer width="100%" height={88}>
      <ComposedChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: 0 }}>
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} hide />
        <YAxis width={40} tick={{ fill: 'var(--text-muted)', fontSize: 8 }} tickFormatter={(v) => `${v}ms`} tickCount={3} />
        {/* Hidden series so Recharts includes min/max in the Y-axis domain */}
        {!isDns && <Line dataKey="min" stroke="none" dot={false} legendType="none" tooltipType="none" connectNulls={false} />}
        {!isDns && <Line dataKey="max" stroke="none" dot={false} legendType="none" tooltipType="none" connectNulls={false} />}
        {/* 1 — Spread band, drawn first so it sits behind */}
        {!isDns && <Customized component={(props) => <SpreadBand {...props} probeData={probeData} />} />}
        {/* 2 — Avg trend line */}
        <Line type="monotone" dataKey="avg" stroke="#7b61ff" dot={false} strokeWidth={1.5} connectNulls={false} />
        <Tooltip
          contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
          formatter={(v) => [v !== null ? `${Number(v).toFixed(1)}ms` : '—', isDns ? 'DNS time' : 'Avg']}
          labelFormatter={() => ''}
        />
        {/* 3 — Packet loss strip */}
        <Customized component={(props) => <LossStrip {...props} probeData={probeData} />} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function TargetCard({ target }) {
  const age = fmtAgo(target.last_checked);

  return (
    <Link to={`/target/${target.id}`} className="target-card">
      <div style={{ marginBottom: 2 }}>
        <span className="target-card-name">{target.name}</span>
      </div>
      <div className="target-card-host">
        {target.host} · {target.probe_type.toUpperCase()}
        {target.probe_type === 'dns' && target.resolved_ip && (
          <span style={{ marginLeft: 6, color: 'var(--text-dim)' }}>→ {target.resolved_ip}</span>
        )}
      </div>
      {target.notes && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {target.notes}
        </div>
      )}

      <MiniChart targetId={target.id} probeType={target.probe_type} />

      <div className="target-card-stats">
        {target.latency_min != null && (
          <div className="target-card-stat">
            <span className="target-card-stat-val" style={{ color: 'var(--success)' }}>{fmt(target.latency_min)}</span>
            <span>min</span>
          </div>
        )}
        <div className="target-card-stat">
          <span className="target-card-stat-val" style={{ color: latencyColor(target.latency_avg) }}>{fmt(target.latency_avg)}</span>
          <span>avg</span>
        </div>
        {target.latency_max != null && (
          <div className="target-card-stat">
            <span className="target-card-stat-val" style={{ color: 'var(--warning)' }}>{fmt(target.latency_max)}</span>
            <span>max</span>
          </div>
        )}
        <div className="target-card-stat">
          <span className="target-card-stat-val" style={{ color: lossColor(target.packet_loss) }}>{fmt(target.packet_loss, '%', 1)}</span>
          <span>loss</span>
        </div>
        {age && (
          <div className="target-card-stat" style={{ marginLeft: 'auto' }}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{age}</span>
          </div>
        )}
      </div>
    </Link>
  );
}

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'latency', label: 'Latency' },
  { value: 'loss', label: 'Loss' },
];

function sortTargets(targets, sort) {
  return [...targets].sort((a, b) => {
    if (sort === 'latency') {
      if (a.latency_avg == null && b.latency_avg == null) return 0;
      if (a.latency_avg == null) return 1;
      if (b.latency_avg == null) return -1;
      return a.latency_avg - b.latency_avg;
    }
    if (sort === 'loss') {
      if (a.packet_loss == null && b.packet_loss == null) return 0;
      if (a.packet_loss == null) return 1;
      if (b.packet_loss == null) return -1;
      return b.packet_loss - a.packet_loss;
    }
    return a.name.localeCompare(b.name);
  });
}

export default function GroupView() {
  const { id } = useParams();
  const groups = useGroups();
  const [sort, setSort] = useState('name');

  if (groups.isLoading) return <div className="spinner" />;

  const group = groups.data?.find((g) => g.id === parseInt(id, 10));
  if (!group) return <div className="error-state">Group not found.</div>;

  const sorted = sortTargets(group.targets, sort);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div className="group-header" style={{ marginBottom: 0 }}>
          <div className="group-title">{group.name}</div>
          {group.description && <div className="group-desc">{group.description}</div>}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            Last 12 hours · {group.targets.length} targets · click for detail
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sort:</span>
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setSort(o.value)}
              style={{
                background: sort === o.value ? 'var(--accent)' : 'transparent',
                color: sort === o.value ? '#fff' : 'var(--text-muted)',
                border: `1px solid ${sort === o.value ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6,
                padding: '3px 10px',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {group.targets.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No targets in this group.</div>
      ) : (
        <div className="target-grid">
          {sorted.map((t) => <TargetCard key={t.id} target={t} />)}
        </div>
      )}
    </div>
  );
}
