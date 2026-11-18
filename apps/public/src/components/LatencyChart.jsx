import { useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceArea, ReferenceLine, useXAxisScale, usePlotArea,
} from 'recharts';
import { fmtTs } from '../lib';

const ACCENT = '#7b61ff';
const WARM = '#f59e0b';

// Range-aware axis label — HH:MM for a day or less, "Mon 14" / "Jan 15" beyond that
export function fmtTsAxis(ts, range) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (['1h', '6h', '12h', '24h'].includes(range)) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (range === '7d') return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Packet loss as bars along the bottom of the SAME plot, so loss lines up with latency exactly
// (it used to be a separate chart with different margins). Height scales with the loss and the
// colour with its severity. Built on Recharts 3's hooks.
function LossBars({ rows, mini }) {
  const xScale = useXAxisScale();
  const plot = usePlotArea();
  if (!xScale || !plot) return null;
  const pts = rows.filter((d) => Number.isFinite(xScale(d.ts)));
  if (pts.length < 2) return null;
  const maxH = mini ? 6 : Math.min(40, plot.height * 0.22);
  const barW = Math.max(2, (xScale(pts[pts.length - 1].ts) - xScale(pts[0].ts)) / (pts.length - 1) - 0.5);

  return (
    <g pointerEvents="none">
      {rows.map((d) => {
        if (!d.loss) return null;
        const x = xScale(d.ts);
        if (!Number.isFinite(x) || x < plot.x - 1 || x > plot.x + plot.width + 1) return null;
        const h = Math.max(mini ? 2 : 3, (Math.min(d.loss, 100) / 100) * maxH);
        const fill = d.loss >= 50 ? '#ef4444' : d.loss > 10 ? '#f97316' : '#f59e0b';
        return <rect key={d.ts} x={x - barW / 2} y={plot.y + plot.height - h} width={barW} height={h} fill={fill} fillOpacity={0.9} rx={1} />;
      })}
    </g>
  );
}

function Tip({ active, payload, isDns }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const f = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}ms`);
  return (
    <div className="chart-tip">
      <div className="chart-tip-time">{fmtTs(d.ts)}</div>
      {d.lost ? (
        <div style={{ color: 'var(--danger)' }}>{isDns ? 'Lookup failed' : '100% packet loss'}</div>
      ) : (<>
        <div><span>{isDns ? 'DNS time' : 'Average'}</span><b>{f(d.avg)}</b></div>
        {d.p50 != null && <div><span>Median</span><b>{f(d.p50)}</b></div>}
        {d.p95 != null && <div><span>95th percentile</span><b>{f(d.p95)}</b></div>}
        {!isDns && d.min != null && <div><span>Min / Max</span><b>{f(d.min)} – {f(d.max)}</b></div>}
        {d.loss > 0 && <div style={{ color: 'var(--warning)' }}><span>Loss</span><b>{d.loss.toFixed(0)}%</b></div>}
      </>)}
    </div>
  );
}

/**
 * Smokeping-style latency chart: average line over a min→max band, 95th percentile, loss bars,
 * and (on the detail page) outages, maintenance windows and route changes drawn on the timeline.
 * One component serves both the 88px group-card sparkline and the full chart.
 */
export default function LatencyChart({
  data, probeType, range, mini = false, height, events, scaleMode = 'linear', zoom, onZoom,
}) {
  const isDns = probeType === 'dns';
  const [drag, setDrag] = useState(null); // { a, b } while selecting a zoom range

  const rows = useMemo(() => (data || []).map((d) => {
    const lost = !isDns && d.packet_loss != null && d.packet_loss >= 100;
    const failed = isDns && d.dns_success === 0;
    const min = isDns || lost ? null : d.latency_min;
    const max = isDns || lost ? null : d.latency_max;
    return {
      ts: d.timestamp,
      avg: isDns ? (failed ? null : d.dns_time) : lost ? null : d.latency_avg,
      p50: isDns || lost ? null : d.latency_p50,
      p95: isDns || lost ? null : d.latency_p95,
      band: min != null && max != null ? [min, max] : null,
      min, max,
      loss: isDns ? (failed ? 100 : 0) : d.packet_loss,
      lost: lost || failed,
    };
  }), [data, isDns]);

  const h = height || (mini ? 88 : 260);
  if (rows.length === 0) {
    return <div className="chart-empty" style={{ height: h }}>{mini ? 'No data yet' : 'No data for this time range'}</div>;
  }

  const hasP95 = !mini && !isDns && rows.some((r) => r.p95 != null);
  const xDomain = zoom ? zoom : ['dataMin', 'dataMax'];
  const lo = rows[0].ts, hi = rows[rows.length - 1].ts;
  const clampX = (v) => Math.min(Math.max(v, lo), hi);

  const dragHandlers = !mini && onZoom ? {
    onMouseDown: (e) => { if (e && e.activeLabel != null) setDrag({ a: e.activeLabel, b: e.activeLabel }); },
    onMouseMove: (e) => { if (drag && e && e.activeLabel != null) setDrag({ a: drag.a, b: e.activeLabel }); },
    onMouseUp: () => {
      if (drag && Math.abs(drag.b - drag.a) > (hi - lo) * 0.01) onZoom([Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)]);
      setDrag(null);
    },
  } : {};

  return (
    <ResponsiveContainer width="100%" height={h}>
      <ComposedChart data={rows} margin={{ top: 6, right: mini ? 2 : 8, bottom: 0, left: 0 }} {...dragHandlers}>
        {!mini && <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />}
        <XAxis
          dataKey="ts" type="number" domain={xDomain} allowDataOverflow hide={mini}
          tickFormatter={(ts) => fmtTsAxis(ts, zoom ? '24h' : range)} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} tickCount={6} minTickGap={36}
        />
        <YAxis
          width={mini ? 40 : 52} tick={{ fill: 'var(--text-muted)', fontSize: mini ? 8 : 10 }}
          tickCount={mini ? 3 : 5} tickFormatter={(v) => (mini ? `${v}ms` : `${v}`)} unit={mini ? undefined : 'ms'}
          scale={scaleMode === 'log' ? 'log' : 'linear'}
          // linear: honest zero baseline · fit: zoom the Y axis to the data so small changes are visible · log: wide-ranging data
          domain={scaleMode === 'log' ? [0.1, 'auto'] : scaleMode === 'fit' ? [(min) => Math.max(0, Math.floor(min * 0.9)), (max) => Math.ceil(max * 1.05)] : [0, 'auto']}
          allowDataOverflow={scaleMode !== 'linear'}
        />
        <Tooltip content={<Tip isDns={isDns} />} isAnimationActive={false} />

        {/* Timeline context — drawn first so the data sits on top */}
        {!mini && events?.maintenance?.map((m, i) => (
          <ReferenceArea key={`m${i}`} x1={clampX(m.start)} x2={clampX(m.end)} fill="#8b5cf6" fillOpacity={0.12} stroke="none" ifOverflow="hidden" />
        ))}
        {!mini && events?.incidents?.map((i, k) => (
          <ReferenceArea key={`i${k}`} x1={clampX(i.start)} x2={clampX(i.end)} fill="#ef4444" fillOpacity={0.14} stroke="none" ifOverflow="hidden" />
        ))}

        {!isDns && (
          <Area dataKey="band" type="monotone" stroke={ACCENT} strokeOpacity={0.4} strokeWidth={0.75}
            fill={ACCENT} fillOpacity={0.18} connectNulls={false} isAnimationActive={false} activeDot={false} />
        )}
        {hasP95 && (
          <Line type="monotone" dataKey="p95" stroke={WARM} strokeWidth={1} strokeDasharray="4 3" dot={false} connectNulls={false} isAnimationActive={false} activeDot={false} />
        )}
        <Line type="monotone" dataKey="avg" stroke={ACCENT} dot={false} strokeWidth={mini ? 1.5 : 2} connectNulls={false} isAnimationActive={false} />

        {!mini && events?.route_changes?.map((r, i) => (
          r.at >= lo && r.at <= hi
            ? <ReferenceLine key={`r${i}`} x={r.at} stroke="#38bdf8" strokeDasharray="3 3" strokeWidth={1.25}
                label={{ value: 'route', position: 'insideTopLeft', fill: '#38bdf8', fontSize: 10 }} />
            : null
        ))}

        <LossBars rows={rows} mini={mini} />
        {drag && <ReferenceArea x1={drag.a} x2={drag.b} fill={ACCENT} fillOpacity={0.15} stroke={ACCENT} strokeOpacity={0.5} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
