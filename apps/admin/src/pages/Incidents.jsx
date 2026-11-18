import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useIncidents, useMutate } from '../hooks/useApi';
import Toast from '../components/Toast';
import { useToast } from '../hooks/useToast';
import { fmtDuration, fmtDateTime, fmtAgo } from '../lib';

function AckModal({ incident, onSave, onClose }) {
  const [note, setNote] = useState('');
  const mut = useMutate(['admin-incidents']);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    try {
      await mut.mutateAsync({ url: `/api/admin/incidents/${incident.id}/ack`, method: 'POST', body: { note: note || null } });
      onSave();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Acknowledge — {incident.target_name}</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
          Lets everyone know you're on it and stops repeat reminders for this outage. It clears automatically once the target recovers.
        </p>
        <form onSubmit={submit}>
          {error && <div className="error-msg">{error}</div>}
          <div className="field">
            <label>Note <span style={{ fontWeight: 400 }}>(optional, admins only)</span></label>
            <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. ISP ticket #4821 opened" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Saving…' : 'Acknowledge'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Incidents() {
  const incidents = useIncidents('all', 200);
  const { toasts, toast } = useToast();
  const [acking, setAcking] = useState(null);
  const unack = useMutate(['admin-incidents']);

  const all = incidents.data || [];
  const open = all.filter((i) => !i.ended_at);
  const history = all.filter((i) => i.ended_at);

  async function removeAck(i) {
    try {
      await unack.mutateAsync({ url: `/api/admin/incidents/${i.id}/ack`, method: 'DELETE' });
      toast('Acknowledgement removed');
    } catch (err) { toast(err.message, 'error'); }
  }

  if (incidents.isLoading) return <div className="spinner" />;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Incidents</h1>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <h2 className="card-title" style={{ color: open.length ? 'var(--danger)' : 'var(--success)' }}>
          {open.length ? `${open.length} open incident${open.length !== 1 ? 's' : ''}` : 'No open incidents'}
        </h2>
        {open.length === 0 ? (
          <p className="muted">Everything is reachable. An incident opens when a target is confirmed down by several consecutive failed probes (see Settings → Alerting).</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Target</th><th>Group</th><th>Down for</th><th>Cause</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {open.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 500 }}>{i.target_name}<div className="mono muted" style={{ fontSize: 11 }}>{i.target_host}</div></td>
                    <td className="muted">{i.group_name}</td>
                    <td title={`since ${fmtDateTime(i.started_at)}`}>{fmtDuration(Math.floor(Date.now() / 1000) - i.started_at)}</td>
                    <td className="muted" style={{ maxWidth: 220, fontSize: 12 }}>{i.cause || '—'}</td>
                    <td>
                      {i.ack_at ? (
                        <span className="badge badge-ack" title={i.ack_note || ''}>Acknowledged by {i.ack_by}</span>
                      ) : i.maintenance ? (
                        <span className="badge badge-maint">Maintenance</span>
                      ) : (
                        <span className="badge badge-down">Unacknowledged</span>
                      )}
                      {i.ack_note && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>“{i.ack_note}”</div>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {i.ack_at
                          ? <button className="btn-ghost btn-sm" onClick={() => removeAck(i)}>Un-acknowledge</button>
                          : <button className="btn-sm" onClick={() => setAcking(i)}>Acknowledge</button>}
                        <Link to={`/targets`} className="btn-ghost btn-sm btn-as-link">Targets</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">History</h2>
        {history.length === 0 ? (
          <p className="muted">No resolved incidents yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Target</th><th>Group</th><th>Started</th><th>Duration</th><th>Cause</th></tr></thead>
              <tbody>
                {history.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 500 }}>{i.target_name}{i.maintenance ? <span className="badge badge-maint" style={{ marginLeft: 8 }}>maintenance</span> : null}</td>
                    <td className="muted">{i.group_name}</td>
                    <td title={fmtDateTime(i.started_at)}>{fmtAgo(i.started_at)}</td>
                    <td>{fmtDuration(i.ended_at - i.started_at)}</td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 260 }}>{i.cause || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {acking && <AckModal incident={acking} onSave={() => { setAcking(null); toast('Acknowledged'); }} onClose={() => setAcking(null)} />}
      <Toast toasts={toasts} />
    </div>
  );
}
