import { useMemo, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useGroups, useGroupResults } from '../hooks/useApi';
import LatencyChart from '../components/LatencyChart';
import StatusBadge from '../components/StatusBadge';
import { fmtMs, fmtPct, fmtAgo, latencyColor, lossColor, effectiveStatus } from '../lib';

// Only mount a chart once its card scrolls near the viewport — a 140-target group no longer
// builds 140 SVG charts up front.
function Lazy({ height, children }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '300px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return <div ref={ref} style={{ minHeight: height }}>{seen ? children : null}</div>;
}

function TargetCard({ target, series, loading }) {
  const age = fmtAgo(target.last_checked);
  const status = effectiveStatus(target);

  return (
    <Link to={`/target/${target.id}`} className={`target-card status-${status.toLowerCase()}`}>
      <div className="target-card-top">
        <span className="target-card-name">{target.name}</span>
        {status !== 'UP' && <StatusBadge status={status} />}
      </div>
      <div className="target-card-host">
        {target.host} · {target.probe_type.toUpperCase()}
        {target.probe_type === 'dns' && target.resolved_ip && <span style={{ marginLeft: 6, color: 'var(--text-dim)' }}>→ {target.resolved_ip}</span>}
      </div>
      {target.in_maintenance && (
        <div className="target-card-note maint">Scheduled maintenance{target.maintenance_ends_at ? ` · until ${new Date(target.maintenance_ends_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
      )}
      {!target.in_maintenance && target.incident_started_at && (
        <div className="target-card-note down">Down {fmtAgo(target.incident_started_at).replace(' ago', '')}{target.incident_acknowledged ? ' · being looked at' : ''}</div>
      )}
      {target.notes && <div className="target-card-note">{target.notes}</div>}

      <Lazy height={88}>
        {loading
          ? <div className="chart-empty" style={{ height: 88 }}><div className="mini-spinner" /></div>
          : <LatencyChart data={series} probeType={target.probe_type} range="12h" mini />}
      </Lazy>

      <div className="target-card-stats">
        {target.latency_min != null && <div className="target-card-stat"><span className="target-card-stat-val" style={{ color: 'var(--success)' }}>{fmtMs(target.latency_min)}</span><span>min</span></div>}
        <div className="target-card-stat"><span className="target-card-stat-val" style={{ color: latencyColor(target.latency_avg) }}>{fmtMs(target.latency_avg)}</span><span>avg</span></div>
        {target.latency_max != null && <div className="target-card-stat"><span className="target-card-stat-val" style={{ color: 'var(--warning)' }}>{fmtMs(target.latency_max)}</span><span>max</span></div>}
        <div className="target-card-stat"><span className="target-card-stat-val" style={{ color: lossColor(target.packet_loss) }}>{fmtPct(target.packet_loss)}</span><span>loss</span></div>
        {age && <div className="target-card-stat" style={{ marginLeft: 'auto' }}><span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{age}</span></div>}
      </div>
    </Link>
  );
}

function ListView({ targets }) {
  return (
    <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
      <table className="list-table">
        <thead>
          <tr><th>Status</th><th>Target</th><th>Host</th><th>Avg</th><th>Min</th><th>Max</th><th>Loss</th><th>Uptime 24h</th><th>Checked</th></tr>
        </thead>
        <tbody>
          {targets.map((t) => (
            <tr key={t.id}>
              <td><StatusBadge status={effectiveStatus(t)} /></td>
              <td><Link to={`/target/${t.id}`} style={{ fontWeight: 500 }}>{t.name}</Link></td>
              <td className="mono muted">{t.host}</td>
              <td style={{ color: latencyColor(t.latency_avg) }}>{fmtMs(t.latency_avg)}</td>
              <td className="muted">{fmtMs(t.latency_min)}</td>
              <td className="muted">{fmtMs(t.latency_max)}</td>
              <td style={{ color: lossColor(t.packet_loss) }}>{fmtPct(t.packet_loss)}</td>
              <td>{t.uptime_24h == null ? '—' : `${t.uptime_24h.toFixed(t.uptime_24h >= 99.95 ? 2 : 1)}%`}</td>
              <td className="muted">{fmtAgo(t.last_checked) || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'status', label: 'Problems first' },
  { value: 'latency', label: 'Latency' },
  { value: 'loss', label: 'Loss' },
];
const STATUS_RANK = { DOWN: 0, DEGRADED: 1, MAINTENANCE: 2, UNKNOWN: 3, UP: 4 };
const nullsLast = (a, b, dir) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : dir * (a - b));

function sortTargets(targets, sort) {
  return [...targets].sort((a, b) => {
    if (sort === 'latency') return nullsLast(a.latency_avg, b.latency_avg, 1);
    if (sort === 'loss') return nullsLast(a.packet_loss, b.packet_loss, -1);
    if (sort === 'status') return STATUS_RANK[effectiveStatus(a)] - STATUS_RANK[effectiveStatus(b)] || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
}

export default function GroupView() {
  const { id } = useParams();
  const groups = useGroups();
  const series = useGroupResults(id, '12h'); // ONE request for every card's chart
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') || 'name';
  const filter = params.get('show') || 'all';
  const q = params.get('q') || '';
  const view = params.get('view') === 'list' ? 'list' : 'cards';
  const searchRef = useRef(null);

  const update = (k, v, def) => setParams((p) => { const n = new URLSearchParams(p); if (!v || v === def) n.delete(k); else n.set(k, v); return n; }, { replace: true });

  const group = groups.data?.find((g) => g.id === parseInt(id, 10));

  const shown = useMemo(() => {
    if (!group) return [];
    const needle = q.trim().toLowerCase();
    return sortTargets(group.targets, sort).filter((t) => {
      const s = effectiveStatus(t);
      if (filter === 'problems' && s !== 'DOWN' && s !== 'DEGRADED') return false;
      if (needle && !t.name.toLowerCase().includes(needle) && !t.host.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [group, sort, filter, q]);

  // "/" focuses the search box
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (groups.isLoading) return <div className="spinner" />;
  if (!group) return <div className="error-state">Group not found.</div>;

  const problems = group.targets.filter((t) => ['DOWN', 'DEGRADED'].includes(effectiveStatus(t))).length;

  return (
    <div>
      <div className="group-toolbar">
        <div className="group-header">
          <div className="group-title">{group.name}</div>
          {group.description && <div className="group-desc">{group.description}</div>}
          <div className="group-sub">Last 12 hours · {group.targets.length} targets{problems > 0 ? ` · ${problems} with problems` : ''}</div>
        </div>
        <div className="toolbar-controls">
          <input ref={searchRef} className="toolbar-search" type="search" placeholder="Filter…  ( / )" value={q} onChange={(e) => update('q', e.target.value, '')} />
          <div className="seg" role="group" aria-label="Show">
            <button className={filter === 'all' ? 'on' : ''} onClick={() => update('show', 'all', 'all')}>All</button>
            <button className={filter === 'problems' ? 'on' : ''} onClick={() => update('show', 'problems', 'all')}>Problems{problems ? ` (${problems})` : ''}</button>
          </div>
          <div className="seg" role="group" aria-label="View">
            <button className={view === 'cards' ? 'on' : ''} onClick={() => update('view', 'cards', 'cards')}>Cards</button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => update('view', 'list', 'cards')}>List</button>
          </div>
          <select className="toolbar-select" value={sort} onChange={(e) => update('sort', e.target.value, 'name')} aria-label="Sort by">
            {SORTS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
          </select>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="empty-note">{group.targets.length === 0 ? 'No targets in this group.' : filter === 'problems' && !q ? 'No problems — everything in this group is healthy.' : 'No targets match.'}</div>
      ) : view === 'list' ? (
        <ListView targets={shown} />
      ) : (
        <div className="target-grid">
          {shown.map((t) => <TargetCard key={t.id} target={t} series={series.data?.targets?.[t.id]} loading={series.isLoading} />)}
        </div>
      )}
    </div>
  );
}
