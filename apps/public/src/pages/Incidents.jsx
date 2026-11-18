import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useIncidents } from '../hooks/useApi';
import { fmtDuration, fmtTs } from '../lib';

const WINDOWS = [{ d: 7, label: '7 days' }, { d: 30, label: '30 days' }, { d: 90, label: '90 days' }];

export default function Incidents() {
  const [days, setDays] = useState(30);
  const q = useIncidents(days);

  if (q.isLoading) return <div className="spinner" />;
  if (q.isError) return <div className="error-state">Failed to load incidents.</div>;
  const list = q.data.incidents;
  const ongoing = list.filter((i) => i.ongoing);
  const resolved = list.filter((i) => !i.ongoing);
  const total = resolved.reduce((n, i) => n + i.duration_seconds, 0);

  return (
    <div>
      <div className="group-toolbar">
        <div className="group-header">
          <div className="group-title">Incidents</div>
          <div className="group-sub">
            {list.length === 0 ? 'No incidents' : `${list.length} incident${list.length !== 1 ? 's' : ''}`} in the last {days} days
            {resolved.length > 0 && ` · ${fmtDuration(total)} total downtime`}
          </div>
        </div>
        <div className="toolbar-controls">
          <div className="seg" role="group" aria-label="Period">
            {WINDOWS.map((w) => <button key={w.d} className={days === w.d ? 'on' : ''} onClick={() => setDays(w.d)}>{w.label}</button>)}
          </div>
          <a className="toolbar-link" href="/feed.atom">Atom feed</a>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="empty-note">Nothing to report — no outages in this period.</div>
      ) : (
        <section className="panel">
          {[...ongoing, ...resolved].map((i) => (
            <Link key={i.id} to={`/target/${i.target_id}`} className="incident-row">
              <span className={`incident-dot ${i.ongoing ? 'down' : 'ok'}`} />
              <span className="incident-name">
                {i.target_name}<span className="muted"> · {i.group_name}</span>
                {i.during_maintenance && <span className="badge badge-maint" style={{ marginLeft: 8 }}>maintenance</span>}
              </span>
              <span className="muted">
                {i.ongoing ? `Ongoing · ${fmtDuration(i.duration_seconds)}` : `${fmtDuration(i.duration_seconds)}`} · {fmtTs(i.started_at)}
              </span>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
