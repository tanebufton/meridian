import { Link } from 'react-router-dom';
import { useSummary, useGroups } from '../hooks/useApi';

function groupStats(targets) {
  let up = 0, degraded = 0, down = 0, latencies = [], newestTs = null;
  for (const t of targets) {
    if (t.status === 'UP') up++;
    else if (t.status === 'DEGRADED') degraded++;
    else if (t.status === 'DOWN') down++;
    if (t.latency_avg != null) latencies.push(t.latency_avg);
    if (t.last_checked != null && (newestTs === null || t.last_checked > newestTs)) newestTs = t.last_checked;
  }
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  return { up, degraded, down, avgLatency, newestTs };
}

function fmtAgo(ts) {
  if (!ts) return null;
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function GroupCard({ group }) {
  const { up, degraded, down, avgLatency, newestTs } = groupStats(group.targets);

  return (
    <Link to={`/group/${group.id}`} className="group-card">
      <div className="group-card-header">
        <span className="group-card-name">{group.name}</span>
        <span className="group-card-count">{group.targets.length} targets</span>
      </div>
      {group.description && <div className="group-card-desc">{group.description}</div>}
      <div className="group-card-stats">
        {up > 0 && <span className="group-card-stat gc-up">{up} up</span>}
        {degraded > 0 && <span className="group-card-stat gc-degraded">{degraded} degraded</span>}
        {down > 0 && <span className="group-card-stat gc-down">{down} unreachable</span>}
        <span className="group-card-right">
          {avgLatency != null && <span className="group-card-latency">{avgLatency.toFixed(1)}ms avg</span>}
          {newestTs && <span className="group-card-age">{fmtAgo(newestTs)}</span>}
        </span>
      </div>
    </Link>
  );
}

const BANNER_STYLES = {
  info:        { bg: 'rgba(123,97,255,0.08)', border: 'rgba(123,97,255,0.3)', color: 'var(--accent)' },
  warning:     { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)', color: 'var(--warning)' },
  maintenance: { bg: 'rgba(125,133,144,0.08)', border: 'rgba(125,133,144,0.3)', color: 'var(--text-muted)' },
};

export default function Overview() {
  const summary = useSummary();
  const groups = useGroups();

  if (summary.isLoading || groups.isLoading) return <div className="spinner" />;
  if (summary.isError) return <div className="error-state">Failed to load data.</div>;

  const { total, online, degraded, offline, banner } = summary.data;
  const bs = banner ? (BANNER_STYLES[banner.type] || BANNER_STYLES.info) : null;

  return (
    <div>
      {banner && (
        <div style={{
          padding: '10px 14px',
          borderRadius: 8,
          marginBottom: 20,
          fontSize: 13,
          border: `1px solid ${bs.border}`,
          background: bs.bg,
          color: bs.color,
        }}>
          {banner.text}
        </div>
      )}

      <div className="overview-stats">
        <div className="stat-pill">
          <span className="stat-pill-label">Total</span>
          <span className="stat-pill-value">{total}</span>
        </div>
        <div className="stat-pill">
          <span className="stat-pill-label">Online</span>
          <span className="stat-pill-value online">{online}</span>
        </div>
        {degraded > 0 && (
          <div className="stat-pill">
            <span className="stat-pill-label">Degraded</span>
            <span className="stat-pill-value degraded">{degraded}</span>
          </div>
        )}
        {offline > 0 && (
          <div className="stat-pill">
            <span className="stat-pill-label">Offline</span>
            <span className="stat-pill-value offline">{offline}</span>
          </div>
        )}
      </div>

      <div className="group-card-grid">
        {groups.data?.filter((g) => g.targets.length > 0).map((group) => (
          <GroupCard key={group.id} group={group} />
        ))}
      </div>
    </div>
  );
}
