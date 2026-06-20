import { useState } from 'react';
import { useMutate } from '../hooks/useApi';
import Toggle from './Toggle';

const LAST_GROUP_KEY = 'meridian_last_group_id';

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
  const mut = useMutate(['admin-targets']);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
    if (k === 'group_id' && v) localStorage.setItem(LAST_GROUP_KEY, v);
  }

  async function submit(e) {
    e.preventDefault();
    const body = {
      ...form,
      group_id: Number(form.group_id),
      interval_seconds: Number(form.interval_seconds),
      packet_count: Number(form.packet_count),
      enabled: form.enabled ? 1 : 0,
    };
    try {
      if (target) {
        await mut.mutateAsync({ url: `/api/admin/targets/${target.id}`, method: 'PUT', body });
      } else {
        await mut.mutateAsync({ url: '/api/admin/targets', method: 'POST', body });
      }
      onSave();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{target ? 'Edit Target' : 'New Target'}</div>
        <form onSubmit={submit}>
          <div className="field"><label>Name</label><input value={form.name} onChange={(e) => set('name', e.target.value)} required /></div>
          <div className="field">
            <label>Group</label>
            <select value={form.group_id} onChange={(e) => set('group_id', e.target.value)} required>
              <option value="">— select group —</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Host / IP</label><input value={form.host} onChange={(e) => set('host', e.target.value)} required /></div>
          <div className="field">
            <label>Probe Type</label>
            <select value={form.probe_type} onChange={(e) => set('probe_type', e.target.value)}>
              <option value="icmp">ICMP (ping)</option>
              <option value="icmp6">ICMPv6 (ping6)</option>
              <option value="dns">DNS resolution</option>
            </select>
          </div>
          <div className="field"><label>Interval (seconds)</label><input type="number" min={5} max={3600} value={form.interval_seconds} onChange={(e) => set('interval_seconds', e.target.value)} /></div>
          {(form.probe_type === 'icmp' || form.probe_type === 'icmp6') && (
            <div className="field"><label>Packet Count</label><input type="number" min={1} max={100} value={form.packet_count} onChange={(e) => set('packet_count', e.target.value)} /></div>
          )}
          <div className="field">
            <label>Notes</label>
            <textarea
              value={form.notes || ''}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Optional notes shown on the public dashboard…"
              rows={2}
              style={{ resize: 'vertical', fontSize: 13 }}
              maxLength={500}
            />
          </div>
          <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
