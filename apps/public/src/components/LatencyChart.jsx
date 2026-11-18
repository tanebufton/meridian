import { useMemo } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  useXAxisScale, usePlotArea,
} from 'recharts';
import { fmtTs } from '../lib';

const ACCENT = '#7b61ff';

// Range-aware axis label — HH:MM for a day or less, "Mon 14" / "Jan 15" beyond that
export function fmtTsAxis(ts, range) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (['1h', '6h', '12h', '24h'].includes(range)) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (range === '7d') return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Packet-loss ticks along the bottom edge of the plot. Uses Recharts 3's hooks — the
// old <Customized> render-prop that received axis maps no longer exists, which silently
// removed both of the custom layers (spread band + loss strip) after the upgrade.
function LossStrip({ rows }) {
  const xScale = useXAxisScale();
  const plot = usePlotArea();
  if (!xScale || !plot) return null;

  const pts = rows.filter((d) => Number.isFinite(xScale(d.ts)));
  if (pts.length < 2) return null;
  const H = 4;
  const barW = Math.max(2, (xScale(pts[pts.length - 1].ts) - xScale(pts[0].ts)) / (pts.length - 1));

  return (
    <g pointerEvents="none">
      {rows.map((d) => {
        if (!d.loss) return null;
        const x = xScale(d.ts);
        if (!Number.isFinite(x)) return null;
        const fill = d.loss > 50 ? '#ef4444' : d.loss > 10 ? '#f97316' : '#f59e0b';
        return <rect key={d.ts} x={x - barW / 2} y={plot.y + plot.height - H} width={barW} height={H} fill={fill} fillOpacity={0.9} rx={1} />;
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
        <div><span>{isDns ? 'DNS time' : 'Avg'}</span><b>{f(d.avg)}</b></div>
        {!isDns && d.min != null && <div><span>Min / Max</span><b>{f(d.min)} – {f(d.max)}</b></div>}
        {d.loss > 0 && <div style={{ color: 'var(--warning)' }}><span>Loss</span><b>{d.loss.toFixed(0)}%</b></div>}
      </>)}
    </div>
  );
}

/**
 * Smokeping-style latency chart: average line over a min→max band, with loss marked along
 * the bottom. One component for both the 88px group-card sparkline and the full detail
 * chart (they used to be two near-identical copies).
 */
export default function LatencyChart({ data, probeType, range, mini = false, height }) {
  const isDns = probeType === 'dns';

  const rows = useMemo(() => (data || []).map((d) => {
    const lost = !isDns && d.packet_loss != null && d.packet_loss >= 100;
    const failed = isDns && d.dns_success === 0;
    const min = isDns || lost ? null : d.latency_min;
    const max = isDns || lost ? null : d.latency_max;
    return {
      ts: d.timestamp,
      avg: isDns ? (failed ? null : d.dns_time) : lost ? null : d.latency_avg,
      band: min != null && max != null ? [min, max] : null,
      min, max,
      loss: isDns ? (failed ? 100 : 0) : d.packet_loss,
      lost: lost || failed,
    };
  }), [data, isDns]);

  const h = height || (mini ? 88 : 220);

  if (rows.length === 0) {
    return <div className="chart-empty" style={{ height: h }}>{mini ? 'No data yet' : 'No data for this time range'}</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={h}>
      <ComposedChart data={rows} margin={{ top: 4, right: mini ? 2 : 8, bottom: 0, left: 0 }}>
        {!mini && <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />}
        <XAxis
          dataKey="ts" type="number" domain={['dataMin', 'dataMax']} hide={mini}
          tickFormatter={(ts) => fmtTsAxis(ts, range)} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} tickCount={6}
        />
        <YAxis
          width={mini ? 40 : 48} tick={{ fill: 'var(--text-muted)', fontSize: mini ? 8 : 10 }}
          tickCount={mini ? 3 : 5} tickFormatter={(v) => (mini ? `${v}ms` : v)} unit={mini ? undefined : 'ms'}
          domain={[0, 'auto']}
        />
        <Tooltip content={<Tip isDns={isDns} />} isAnimationActive={false} />
        {!isDns && (
          <Area
            dataKey="band" type="monotone" stroke={ACCENT} strokeOpacity={0.4} strokeWidth={0.75}
            fill={ACCENT} fillOpacity={0.18} connectNulls={false} isAnimationActive={false} activeDot={false}
          />
        )}
        <Line type="monotone" dataKey="avg" stroke={ACCENT} dot={false} strokeWidth={mini ? 1.5 : 2} connectNulls={false} isAnimationActive={false} />
        <LossStrip rows={rows} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
