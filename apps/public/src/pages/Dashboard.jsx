import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { useSummary, useGroups } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';

function fmt(val, unit = 'ms', decimals = 1) {
  if (val === null || val === undefined) return '—';
  return `${Number(val).toFixed(decimals)}${unit}`;
}

function fmtPct(val) {
  if (val === null || val === undefined) return '—';
  return `${Number(val).toFixed(1)}%`;
}

function SparklineChart({ data }) {
  if (!data || data.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>No data yet</div>;
  return (
    <ResponsiveContainer width="100%" height={60}>
      <LineChart data={data}>
        <XAxis dataKey="timestamp" hide />
        <Tooltip
          contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}
          formatter={(v) => [`${Number(v).toFixed(1)}ms`, 'Avg']}
          labelFormatter={() => ''}
        />
        <Line
          type="monotone"
          dataKey="latency_avg"
          stroke="var(--accent)"
          dot={false}
          strokeWidth={1.5}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function GroupSection({ group }) {
  const [open, setOpen] = useState(true);

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="group-header" onClick={() => setOpen((o) => !o)}>
        <span className="group-title">{group.name}</span>
        {group.description && (
          <span className="group-count">{group.description}</span>
        )}
        <span className="group-count">{group.targets.length} targets</span>
        <span className={`chevron ${open ? 'open' : ''}`}>›</span>
      </div>
      {open && (
        <div className="group-body">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Host</th>
                <th>Status</th>
                <th>Avg Latency</th>
                <th>Packet Loss</th>
                <th>Uptime 24h</th>
              </tr>
            </thead>
            <tbody>
              {group.targets.length === 0 && (
                <tr><td colSpan={6} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No targets in this group</td></tr>
              )}
              {group.targets.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/target/${t.id}`}>{t.name}</Link>
                  </td>
                  <td style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{t.host}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td>{fmt(t.latency_avg)}</td>
                  <td>{fmtPct(t.packet_loss)}</td>
                  <td>{fmtPct(t.uptime_24h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const summary = useSummary();
  const groups = useGroups();

  if (summary.isLoading || groups.isLoading) return <div className="spinner" />;
  if (summary.isError || groups.isError) return <div style={{ color: 'var(--danger)' }}>Failed to load data.</div>;

  const { total, online, degraded, offline, sparkline } = summary.data;

  return (
    <div>
      <div className="summary-row">
        <div className="stat-card">
          <div className="stat-label">Total Targets</div>
          <div className="stat-value">{total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Online</div>
          <div className="stat-value stat-online">{online}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Degraded</div>
          <div className="stat-value stat-degraded">{degraded}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Offline</div>
          <div className="stat-value stat-offline">{offline}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="chart-title">Global Avg Latency — Last 24h</div>
        <SparklineChart data={sparkline} />
      </div>

      {groups.data.map((g) => (
        <GroupSection key={g.id} group={g} />
      ))}
    </div>
  );
}
