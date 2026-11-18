import { Link } from 'react-router-dom';
import { useSummary, useGroups, useIncidents } from '../hooks/useApi';
import { fmtAgo, fmtDuration, fmtTs, worstStatus } from '../lib';

function groupStats(targets) {
  const c = { up: 0, degraded: 0, down: 0, maint: 0 };
  const lat = [];
  let newest = null;
  for (const t of targets) {
    if (t.in_maintenance) c.maint++;
    else if (t.status === 'UP') c.up++;
    else if (t.status === 'DEGRADED') c.degraded++;
    else if (t.status === 'DOWN') c.down++;
    if (t.latency_avg != null) lat.push(t.latency_avg);
    if (t.last_checked != null && (newest === null || t.last_checked > newest)) newest = t.last_checked;
  }
  return { ...c, avg: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null, newest };
}

function GroupCard({ group }) {
  const s = groupStats(group.targets);
  const worst = worstStatus(group.targets).toLowerCase();
  return (
    <Link to={`/group/${group.id}`} className={`group-card status-${worst}`}>
      <div className="group-card-header">
        <span className="group-card-name">{group.name}</span>
        <span className="group-card-count">{group.targets.length} targets</span>
      </div>
      {group.description && <div className="group-card-desc">{group.description}</div>}
      <div className="group-card-stats">
        {s.up > 0 && <span className="group-card-stat gc-up">{s.up} up</span>}
        {s.degraded > 0 && <span className="group-card-stat gc-degraded">{s.degraded} degraded</span>}
        {s.down > 0 && <span className="group-card-stat gc-down">{s.down} down</span>}
        {s.maint > 0 && <span className="group-card-stat gc-maint">{s.maint} maintenance</span>}
        <span className="group-card-right">
          {s.avg != null && <span className="group-card-latency">{s.avg.toFixed(1)}ms avg</span>}
          {s.newest && <span className="group-card-age">{fmtAgo(s.newest)}</span>}
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

function Banner({ style, children }) {
  return <div className="banner" style={{ border: `1px solid ${style.border}`, background: style.bg, color: style.color }}>{children}</div>;
}

export default function Overview() {
  const summary = useSummary();
  const groups = useGroups();
  const incidents = useIncidents(14);

  if (summary.isLoading || groups.isLoading) return <div className="spinner" />;
  if (summary.isError) return <div className="error-state">Failed to load data.</div>;

  const { total, online, degraded, offline, maintenance, banner, maintenance_windows: windows = [] } = summary.data;
  const list = incidents.data?.incidents || [];
  const ongoing = list.filter((i) => i.ongoing && !i.during_maintenance);
  const recent = list.filter((i) => !i.ongoing).slice(0, 5);
  const allGood = offline === 0 && degraded === 0 && ongoing.length === 0;

  return (
    <div>
      {banner && <Banner style={BANNER_STYLES[banner.type] || BANNER_STYLES.info}>{banner.text}</Banner>}
      {windows.map((w) => (
        <Banner key={`${w.name}-${w.ends_at}`} style={BANNER_STYLES.maintenance}>
          <strong>Scheduled maintenance:</strong> {w.name}{w.scope_name ? ` (${w.scope_name})` : ''} · until {new Date(w.ends_at * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
        </Banner>
      ))}

      <div className={`overall ${allGood ? 'good' : offline > 0 ? 'bad' : 'warn'}`} role="status">
        <span className="overall-dot" />
        {allGood ? 'All systems operational'
          : offline > 0 ? `${offline} target${offline !== 1 ? 's' : ''} unreachable`
          : degraded > 0 ? `${degraded} target${degraded !== 1 ? 's' : ''} degraded` : 'Investigating an issue'}
      </div>

      <div className="overview-stats">
        <div className="stat-pill"><span className="stat-pill-label">Total</span><span className="stat-pill-value">{total}</span></div>
        <div className="stat-pill"><span className="stat-pill-label">Online</span><span className="stat-pill-value online">{online}</span></div>
        {degraded > 0 && <div className="stat-pill"><span className="stat-pill-label">Degraded</span><span className="stat-pill-value degraded">{degraded}</span></div>}
        {offline > 0 && <div className="stat-pill"><span className="stat-pill-label">Offline</span><span className="stat-pill-value offline">{offline}</span></div>}
        {maintenance > 0 && <div className="stat-pill"><span className="stat-pill-label">Maintenance</span><span className="stat-pill-value maint">{maintenance}</span></div>}
      </div>

      {ongoing.length > 0 && (
        <section className="panel">
          <h2 className="panel-title" style={{ color: 'var(--danger)' }}>Ongoing incidents</h2>
          {ongoing.map((i) => (
            <Link key={i.id} to={`/target/${i.target_id}`} className="incident-row">
              <span className="incident-dot down" />
              <span className="incident-name">{i.target_name}<span className="muted"> · {i.group_name}</span></span>
              <span className="muted">{i.acknowledged ? 'Being looked at · ' : ''}down for {fmtDuration(i.duration_seconds)}</span>
            </Link>
          ))}
        </section>
      )}

      <div className="group-card-grid">
        {groups.data?.filter((g) => g.targets.length > 0).map((group) => <GroupCard key={group.id} group={group} />)}
      </div>

      {recent.length > 0 && (
        <section className="panel" style={{ marginTop: 24 }}>
          <div className="panel-head">
            <h2 className="panel-title">Recent incidents</h2>
            <Link to="/incidents" className="muted" style={{ fontSize: 12 }}>View all →</Link>
          </div>
          {recent.map((i) => (
            <Link key={i.id} to={`/target/${i.target_id}`} className="incident-row">
              <span className="incident-dot ok" />
              <span className="incident-name">{i.target_name}<span className="muted"> · {i.group_name}</span></span>
              <span className="muted" title={fmtTs(i.started_at)}>{fmtDuration(i.duration_seconds)} · {fmtAgo(i.ended_at)}</span>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
