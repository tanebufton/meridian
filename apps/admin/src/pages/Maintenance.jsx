import { useState } from 'react';
import { useMaintenance, useGroups, useTargets, useMutate } from '../hooks/useApi';
import Toast from '../components/Toast';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../components/ConfirmDialog';
import { fmtDateTime, fmtDuration, toLocalInput, fromLocalInput } from '../lib';

const REPEAT = { none: 'One-off', daily: 'Repeats daily', weekly: 'Repeats weekly' };

function WindowModal({ initial, groups, targets, onSave, onClose }) {
  const now = Math.floor(Date.now() / 1000);
  const [form, setForm] = useState(initial || {
    name: '', scope: 'all', scope_id: '', repeat: 'none',
    starts_at: toLocalInput(now + 3600), ends_at: toLocalInput(now + 7200),
  });
  const [error, setError] = useState('');
  const mut = useMutate(['admin-maintenance']);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    const body = {
      name: form.name,
      scope: form.scope,
      scope_id: form.scope === 'all' ? null : Number(form.scope_id),
      repeat: form.repeat,
      starts_at: fromLocalInput(form.starts_at),
      ends_at: fromLocalInput(form.ends_at),
    };
    try {
      if (initial?.id) await mut.mutateAsync({ url: `/api/admin/maintenance/${initial.id}`, method: 'PUT', body });
      else await mut.mutateAsync({ url: '/api/admin/maintenance', method: 'POST', body });
      onSave();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{initial?.id ? 'Edit maintenance window' : 'Schedule maintenance'}</div>
        <form onSubmit={submit}>
          {error && <div className="error-msg">{error}</div>}
          <div className="field"><label>Name</label><input autoFocus required value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Core switch firmware upgrade" maxLength={100} /></div>
          <div className="field">
            <label>Applies to</label>
            <select value={form.scope} onChange={(e) => { set('scope', e.target.value); set('scope_id', ''); }}>
              <option value="all">Everything</option>
              <option value="group">One group</option>
              <option value="target">One target</option>
            </select>
          </div>
          {form.scope === 'group' && (
            <div className="field"><label>Group</label>
              <select required value={form.scope_id} onChange={(e) => set('scope_id', e.target.value)}>
                <option value="">— select —</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          )}
          {form.scope === 'target' && (
            <div className="field"><label>Target</label>
              <select required value={form.scope_id} onChange={(e) => set('scope_id', e.target.value)}>
                <option value="">— select —</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.group_name})</option>)}
              </select>
            </div>
          )}
          <div className="grid-2">
            <div className="field"><label>Starts</label><input type="datetime-local" required value={form.starts_at} onChange={(e) => set('starts_at', e.target.value)} /></div>
            <div className="field"><label>Ends</label><input type="datetime-local" required value={form.ends_at} onChange={(e) => set('ends_at', e.target.value)} /></div>
          </div>
          <div className="field">
            <label>Repeat</label>
            <select value={form.repeat} onChange={(e) => set('repeat', e.target.value)}>
              <option value="none">Just once</option>
              <option value="daily">Every day at this time</option>
              <option value="weekly">Every week at this time</option>
            </select>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Maintenance() {
  const windows = useMaintenance();
  const groups = useGroups();
  const targets = useTargets();
  const { toasts, toast } = useToast();
  const ask = useConfirm();
  const [editing, setEditing] = useState(null); // window object, or {} for new
  const mut = useMutate(['admin-maintenance']);

  async function quick(minutes) {
    const now = Math.floor(Date.now() / 1000);
    try {
      await mut.mutateAsync({
        url: '/api/admin/maintenance', method: 'POST',
        body: { name: `Quick pause (${minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`})`, scope: 'all', starts_at: now, ends_at: now + minutes * 60, repeat: 'none' },
      });
      toast(`Alerts paused for ${minutes >= 60 ? `${minutes / 60} hour${minutes > 60 ? 's' : ''}` : `${minutes} minutes`}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function remove(w) {
    const verb = w.active ? 'End' : 'Delete';
    if (!(await ask({
      title: `${verb} "${w.name}"?`,
      message: w.active
        ? 'Alerts for the affected targets will resume immediately. Anything still down will notify you.'
        : 'This schedule will be removed.',
      confirmLabel: verb, danger: true,
    }))) return;
    try {
      await mut.mutateAsync({ url: `/api/admin/maintenance/${w.id}`, method: 'DELETE' });
      toast(w.active ? 'Maintenance ended' : 'Deleted');
    } catch (err) { toast(err.message, 'error'); }
  }

  if (windows.isLoading) return <div className="spinner" />;
  const list = windows.data || [];
  const active = list.filter((w) => w.active);
  const upcoming = list.filter((w) => !w.active && !w.finished).sort((a, b) => a.occurrence_start - b.occurrence_start);
  const past = list.filter((w) => w.finished);

  const row = (w) => (
    <tr key={w.id}>
      <td style={{ fontWeight: 500 }}>{w.name}</td>
      <td className="muted">{w.scope_name}</td>
      <td>
        {w.active
          ? <>until {fmtDateTime(w.occurrence_end)}<div className="muted" style={{ fontSize: 11 }}>{fmtDuration(w.occurrence_end - Math.floor(Date.now() / 1000))} left</div></>
          : <>{fmtDateTime(w.occurrence_start)}<div className="muted" style={{ fontSize: 11 }}>{fmtDuration(w.occurrence_end - w.occurrence_start)} long</div></>}
      </td>
      <td className="muted" style={{ fontSize: 12 }}>{REPEAT[w.repeat]}</td>
      <td>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          {!w.finished && <button className="btn-ghost btn-sm" onClick={() => setEditing({
            ...w, scope_id: w.scope_id ?? '', starts_at: toLocalInput(w.starts_at), ends_at: toLocalInput(w.ends_at),
          })}>Edit</button>}
          <button className="btn-danger btn-sm" onClick={() => remove(w)}>{w.active ? 'End now' : 'Delete'}</button>
        </div>
      </td>
    </tr>
  );

  const table = (rows) => (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Applies to</th><th>When</th><th>Repeat</th><th></th></tr></thead>
        <tbody>{rows.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Maintenance</h1>
        <button onClick={() => setEditing({})}>+ Schedule maintenance</button>
      </div>

      <p className="muted" style={{ marginBottom: 20, maxWidth: 720 }}>
        During a maintenance window alerts are held back and affected targets show as <em>Maintenance</em> on the public dashboard.
        If a target is still down when the window ends you'll be notified then. Probing and charts carry on as normal.
      </p>

      <div className="card" style={{ marginBottom: 24 }}>
        <h2 className="card-title">Pause all alerts now</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[[15, '15 minutes'], [60, '1 hour'], [240, '4 hours'], [720, '12 hours']].map(([m, label]) => (
            <button key={m} className="btn-ghost" disabled={mut.isPending} onClick={() => quick(m)}>{label}</button>
          ))}
        </div>
      </div>

      {active.length > 0 && (
        <div className="card" style={{ marginBottom: 24, borderColor: 'rgba(111,66,193,0.5)' }}>
          <h2 className="card-title" style={{ color: 'var(--maint)' }}>Active now</h2>
          {table(active)}
        </div>
      )}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 className="card-title">Upcoming</h2>
        {upcoming.length ? table(upcoming) : <p className="muted">Nothing scheduled.</p>}
      </div>
      {past.length > 0 && (
        <div className="card">
          <h2 className="card-title">Finished <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(cleared automatically after a week)</span></h2>
          {table(past)}
        </div>
      )}

      {editing && (
        <WindowModal
          initial={editing.id ? editing : null}
          groups={groups.data || []}
          targets={targets.data || []}
          onSave={() => { setEditing(null); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      )}
      <Toast toasts={toasts} />
    </div>
  );
}
