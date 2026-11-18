import { useState } from 'react';
import { useMutate } from '../hooks/useApi';
import Toggle from './Toggle';
import { PROBE_TYPES } from '../lib';

export const LAST_GROUP_KEY = 'meridian_last_group_id';

export function makeEmpty() {
  return {
    name: '',
    group_id: localStorage.getItem(LAST_GROUP_KEY) || '',
    host: '',
    probe_type: 'icmp',
    interval_seconds: 300,
    packet_count: 20,
    enabled: 1,
    notes: '',
  };
}

export default function TargetModal({ target, groups, onSave, onClose }) {
  const [form, setForm] = useState(target || makeEmpty());
  const [error, setError] = useState('');
  const mut = useMutate(['admin-targets']);
  const type = PROBE_TYPES.find((t) => t.value === form.probe_type) || PROBE_TYPES[0];

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
    if (k === 'group_id' && v) localStorage.setItem(LAST_GROUP_KEY, v);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const body = {
      group_id: Number(form.group_id),
      name: form.name,
      host: form.host,
      probe_type: form.probe_type,
      interval_seconds: Number(form.interval_seconds),
      packet_count: Number(form.packet_count),
      enabled: form.enabled ? 1 : 0,
      notes: form.notes || null,
    };
    try {
      if (target) await mut.mutateAsync({ url: `/api/admin/targets/${target.id}`, method: 'PUT', body });
      else await mut.mutateAsync({ url: '/api/admin/targets', method: 'POST', body });
      onSave();
    } catch (err) {
      setError(err.message);
    }
  }

  const usesCount = form.probe_type === 'icmp' || form.probe_type === 'icmp6' || form.probe_type === 'tcp';

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{target ? 'Edit target' : 'New target'}</div>
        <form onSubmit={submit}>
          {error && <div className="error-msg" role="alert">{error}</div>}
          <div className="field"><label>Name</label><input autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={100} /></div>
          <div className="field">
            <label>Group</label>
            <select value={form.group_id} onChange={(e) => set('group_id', e.target.value)} required>
              <option value="">— select group —</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Probe type</label>
            <select value={form.probe_type} onChange={(e) => set('probe_type', e.target.value)}>
              {PROBE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{form.probe_type === 'http' ? 'URL' : form.probe_type === 'tcp' ? 'Host and port' : 'Host / IP'}</label>
            <input className="mono" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder={type.example} required maxLength={255} />
            <div className="muted help">{type.hint}</div>
          </div>
          <div className="grid-2">
            <div className="field"><label>Interval (seconds)</label><input type="number" min={5} max={3600} value={form.interval_seconds} onChange={(e) => set('interval_seconds', e.target.value)} /></div>
            {usesCount && (
              <div className="field">
                <label>{form.probe_type === 'tcp' ? 'Connection attempts' : 'Packets per probe'}</label>
                <input type="number" min={1} max={100} value={form.packet_count} onChange={(e) => set('packet_count', e.target.value)} />
              </div>
            )}
          </div>
          <div className="field">
            <label>Notes</label>
            <textarea value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Optional — shown on the public dashboard" rows={2} style={{ resize: 'vertical' }} maxLength={500} />
          </div>
          <div className="field row">
            <Toggle checked={!!form.enabled} onChange={(v) => set('enabled', v ? 1 : 0)} />
            <span style={{ fontSize: 13 }}>Enabled</span>
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
