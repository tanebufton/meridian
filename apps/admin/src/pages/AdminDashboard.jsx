import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTargets, useGroups, useMutate } from '../hooks/useApi';
import TargetModal from '../components/TargetModal';
import Toast from '../components/Toast';
import { useToast } from '../hooks/useToast';

const STATUS_COLOR = {
  UP:       'var(--success)',
  DEGRADED: 'var(--warning)',
  DOWN:     'var(--danger)',
  UNKNOWN:  'var(--text-muted)',
};

const STATUS_BG = {
  UP:       'rgba(34,197,94,0.08)',
  DEGRADED: 'rgba(245,158,11,0.08)',
  DOWN:     'rgba(239,68,68,0.08)',
  UNKNOWN:  'rgba(148,163,184,0.08)',
};

export default function AdminDashboard() {
  const targets = useTargets();
  const groups = useGroups();
  const { toasts, toast } = useToast();
  const [editing, setEditing] = useState(null);
  const disableMut = useMutate(['admin-targets']);
  const deleteMut = useMutate(['admin-targets']);

  const all = targets.data || [];
  const enabled = all.filter((t) => t.enabled);
  const counts = { UP: 0, DEGRADED: 0, DOWN: 0, UNKNOWN: 0 };
  for (const t of enabled) counts[t.status] = (counts[t.status] || 0) + 1;

  const problems = enabled
    .filter((t) => t.status === 'DOWN' || t.status === 'DEGRADED')
    .sort((a, b) => (a.status === 'DOWN' ? -1 : 1) - (b.status === 'DOWN' ? -1 : 1) || a.name.localeCompare(b.name));

  async function disableTarget(t) {
    try {
      await disableMut.mutateAsync({ url: `/api/admin/targets/${t.id}/enabled`, method: 'PATCH', body: { enabled: 0 } });
      toast(`${t.name} disabled`);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteTarget(t) {
    if (!confirm(`Delete target "${t.name}"?`)) return;
    try {
      await deleteMut.mutateAsync({ url: `/api/admin/targets/${t.id}`, method: 'DELETE' });
      toast(`${t.name} deleted`);
    } catch (err) { toast(err.message, 'error'); }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
      </div>

      {/* Status summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        {['UP', 'DEGRADED', 'DOWN', 'UNKNOWN'].map((s) => (
          <div key={s} className="card" style={{ background: STATUS_BG[s], borderColor: STATUS_COLOR[s] + '33' }}>
            <div style={{ fontSize: 11, color: STATUS_COLOR[s], textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontWeight: 600 }}>{s}</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: STATUS_COLOR[s] }}>{targets.isLoading ? '—' : counts[s]}</div>
          </div>
        ))}
      </div>

      {/* Problem targets */}
      {problems.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--danger)' }}>
            Problems — {problems.length} target{problems.length !== 1 ? 's' : ''} need attention
          </h2>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Group</th>
                <th>Host</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {problems.map((t) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 500 }}>{t.name}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{t.group_name}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.host}</td>
                  <td><span className={`badge badge-${t.status.toLowerCase()}`}>{t.status}</span></td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(t)}>Edit</button>
                      <button className="btn-ghost btn-sm" onClick={() => disableTarget(t)}>Disable</button>
                      <button className="btn-danger btn-sm" onClick={() => deleteTarget(t)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Quick links */}
      <div className="card">
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Quick Links</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Link to="/targets">→ Manage Targets</Link>
          <Link to="/groups">→ Manage Groups</Link>
          <Link to="/settings">→ Settings & Users</Link>
        </div>
      </div>

      {editing && (
        <TargetModal
          target={editing}
          groups={groups.data || []}
          onSave={() => { setEditing(null); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      )}

      <Toast toasts={toasts} />
    </div>
  );
}
