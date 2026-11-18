import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTargets, useGroups, useIncidents, useMaintenance, useMutate } from '../hooks/useApi';
import TargetModal from '../components/TargetModal';
import Toast from '../components/Toast';
import { useToast } from '../hooks/useToast';
import { fmtDuration, fmtDateTime } from '../lib';

const TILES = [
  { key: 'UP', label: 'Up', color: 'var(--success)', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)' },
  { key: 'DEGRADED', label: 'Degraded', color: 'var(--warning)', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)' },
  { key: 'DOWN', label: 'Down', color: 'var(--danger)', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)' },
  { key: 'MAINT', label: 'Maintenance', color: 'var(--maint)', bg: 'rgba(139,92,246,0.1)', border: 'rgba(139,92,246,0.3)' },
  { key: 'UNKNOWN', label: 'Unknown', color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.2)' },
];

export default function AdminDashboard() {
  const targets = useTargets();
  const groups = useGroups();
  const incidents = useIncidents('open', 100);
  const maintenance = useMaintenance();
  const { toasts, toast } = useToast();
  const [editing, setEditing] = useState(null);
  const ackMut = useMutate(['admin-incidents']);

  const enabled = (targets.data || []).filter((t) => t.enabled);
  const counts = { UP: 0, DEGRADED: 0, DOWN: 0, MAINT: 0, UNKNOWN: 0 };
  for (const t of enabled) counts[t.in_maintenance ? 'MAINT' : (t.status in counts ? t.status : 'UNKNOWN')]++;

  const open = incidents.data || [];
  const activeMaint = (maintenance.data || []).filter((w) => w.active);
  // Down/degraded targets that don't (yet) have an incident, e.g. still inside the confirmation window
  const incidentTargets = new Set(open.map((i) => i.target_id));
  const degraded = enabled.filter((t) => t.status === 'DEGRADED' && !t.in_maintenance);
  const pending = enabled.filter((t) => t.status === 'DOWN' && !t.in_maintenance && !incidentTargets.has(t.id));

  async function quickAck(i) {
    try { await ackMut.mutateAsync({ url: `/api/admin/incidents/${i.id}/ack`, method: 'POST', body: {} }); toast(`Acknowledged ${i.target_name}`); }
    catch (err) { toast(err.message, 'error'); }
  }

  return (
    <div>
      <div className="page-header"><h1 className="page-title">Dashboard</h1></div>

      {activeMaint.length > 0 && (
        <div className="notice maint">
          <strong>Maintenance in progress:</strong>{' '}
          {activeMaint.map((w) => `${w.name} (${w.scope_name}, until ${fmtDateTime(w.occurrence_end)})`).join(' · ')}
          {' '}<Link to="/maintenance">Manage</Link>
        </div>
      )}

      <div className="tiles">
        {TILES.map((t) => (
          <div key={t.key} className="card tile" style={{ background: t.bg, borderColor: t.border }}>
            <div className="tile-label" style={{ color: t.color }}>{t.label}</div>
            <div className="tile-value" style={{ color: t.color }}>{targets.isLoading ? '—' : counts[t.key]}</div>
          </div>
        ))}
      </div>

      <div className="card section">
        <h2 className="card-title" style={{ color: open.length ? 'var(--danger)' : 'var(--success)' }}>
          {open.length ? `${open.length} open incident${open.length !== 1 ? 's' : ''}` : 'All clear — no open incidents'}
        </h2>
        {open.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Target</th><th>Group</th><th>Down for</th><th></th></tr></thead>
              <tbody>
                {open.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 500 }}>{i.target_name}<div className="mono muted" style={{ fontSize: 11 }}>{i.target_host}</div></td>
                    <td className="muted">{i.group_name}</td>
                    <td>{fmtDuration(Math.floor(Date.now() / 1000) - i.started_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {i.ack_at ? <span className="badge badge-ack">Acknowledged by {i.ack_by}</span>
                        : i.maintenance ? <span className="badge badge-maint">Maintenance</span>
                        : <button className="btn-sm" disabled={ackMut.isPending} onClick={() => quickAck(i)}>Acknowledge</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(pending.length > 0 || degraded.length > 0) && (
          <p className="muted help" style={{ marginTop: 12 }}>
            {pending.length > 0 && <>Failing but not yet confirmed: {pending.map((t) => t.name).join(', ')}. </>}
            {degraded.length > 0 && <>Degraded (partial packet loss): {degraded.map((t) => t.name).join(', ')}. </>}
          </p>
        )}
        <p style={{ marginTop: 12, fontSize: 13 }}><Link to="/incidents">All incidents →</Link></p>
      </div>

      <div className="card">
        <h2 className="card-title">Quick links</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
          <Link to="/targets">→ Manage targets</Link>
          <Link to="/maintenance">→ Schedule maintenance</Link>
          <Link to="/settings?tab=alerting">→ Alerting &amp; notification channels</Link>
          <Link to="/settings?tab=account">→ Password &amp; two-factor authentication</Link>
        </div>
      </div>

      {editing && (
        <TargetModal target={editing} groups={groups.data || []} onSave={() => { setEditing(null); toast('Saved'); }} onClose={() => setEditing(null)} />
      )}
      <Toast toasts={toasts} />
    </div>
  );
}
