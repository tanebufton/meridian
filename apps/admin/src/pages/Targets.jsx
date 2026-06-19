import { useState } from 'react';
import { useTargets, useGroups, useMutate, apiFetch } from '../hooks/useApi';
import Toggle from '../components/Toggle';
import Toast from '../components/Toast';
import TargetModal from '../components/TargetModal';
import { useToast } from '../hooks/useToast';

const ALL_STATUSES = ['UP', 'DEGRADED', 'DOWN', 'UNKNOWN'];
const STATUS_CLASS = { UP: 'badge-up', DEGRADED: 'badge-degraded', DOWN: 'badge-down', UNKNOWN: 'badge-unknown' };

function parseBulkLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sepIdx = line.indexOf(' : ');
      if (sepIdx !== -1) {
        return { name: line.slice(0, sepIdx).trim(), host: line.slice(sepIdx + 3).trim() };
      }
      return { name: line, host: line };
    })
    .filter((t) => t.host);
}

function BulkModal({ groups, onSave, onClose }) {
  const lastGroupId = localStorage.getItem(LAST_GROUP_KEY) || '';
  const [groupId, setGroupId] = useState(lastGroupId);
  const [probeType, setProbeType] = useState('icmp');
  const [interval, setInterval] = useState(300);
  const [packetCount, setPacketCount] = useState(10);
  const [text, setText] = useState('');
  const mut = useMutate(['admin-targets']);

  const parsed = parseBulkLines(text);

  function handleGroupChange(v) {
    setGroupId(v);
    if (v) localStorage.setItem(LAST_GROUP_KEY, v);
  }

  async function submit(e) {
    e.preventDefault();
    if (!groupId || parsed.length === 0) return;
    const targets = parsed.map((t) => ({
      group_id: Number(groupId),
      name: t.name,
      host: t.host,
      probe_type: probeType,
      interval_seconds: Number(interval),
      packet_count: Number(packetCount),
      enabled: 1,
    }));
    try {
      await mut.mutateAsync({ url: '/api/admin/targets/bulk', method: 'POST', body: { targets } });
      onSave(parsed.length);
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-title">Bulk Add Targets</div>
        <form onSubmit={submit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Group</label>
              <select value={groupId} onChange={(e) => handleGroupChange(e.target.value)} required>
                <option value="">— select group —</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Probe Type</label>
              <select value={probeType} onChange={(e) => setProbeType(e.target.value)}>
                <option value="icmp">ICMP (ping)</option>
                <option value="dns">DNS resolution</option>
              </select>
            </div>
            <div className="field">
              <label>Interval (seconds)</label>
              <input type="number" min={5} max={3600} value={interval} onChange={(e) => setInterval(e.target.value)} />
            </div>
            {probeType === 'icmp' && (
              <div className="field">
                <label>Packet Count</label>
                <input type="number" min={1} max={100} value={packetCount} onChange={(e) => setPacketCount(e.target.value)} />
              </div>
            )}
          </div>

          <div className="field">
            <label>Hosts — one per line. Optionally prefix with a name: <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>My Router : 192.168.1.1</code></label>
            <textarea
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'8.8.8.8\n1.1.1.1\nMy Router : 192.168.1.1\ngoogle.com'}
              style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
            />
          </div>

          {parsed.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
              {parsed.length} target{parsed.length !== 1 ? 's' : ''} ready to add
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={mut.isPending || parsed.length === 0 || !groupId}>
              {mut.isPending ? 'Adding…' : `Add ${parsed.length || ''} Targets`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Targets() {
  const targets = useTargets();
  const groups = useGroups();
  const { toasts, toast } = useToast();
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  const [filterGroup, setFilterGroup] = useState('');
  const [statusFilter, setStatusFilter] = useState(new Set());
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [runningTrace, setRunningTrace] = useState(new Set());
  const toggleMut = useMutate(['admin-targets']);
  const deleteMut = useMutate(['admin-targets']);

  function clearSelection() { setSelected(new Set()); }

  function toggleStatus(s) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
    clearSelection();
  }

  async function toggleEnabled(t) {
    try {
      await toggleMut.mutateAsync({ url: `/api/admin/targets/${t.id}/enabled`, method: 'PATCH', body: { enabled: t.enabled ? 0 : 1 } });
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteTarget(t) {
    if (!confirm(`Delete target "${t.name}"?`)) return;
    try {
      await deleteMut.mutateAsync({ url: `/api/admin/targets/${t.id}`, method: 'DELETE' });
      toast('Target deleted');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (!confirm(`Delete ${ids.length} target${ids.length !== 1 ? 's' : ''}?`)) return;
    const count = ids.length;
    try {
      await Promise.all(ids.map((id) => deleteMut.mutateAsync({ url: `/api/admin/targets/${id}`, method: 'DELETE' })));
      clearSelection();
      toast(`Deleted ${count} target${count !== 1 ? 's' : ''}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function runTraceroute(t) {
    setRunningTrace((prev) => new Set([...prev, t.id]));
    try {
      await apiFetch(`/api/admin/targets/${t.id}/traceroute/run`, { method: 'POST' });
      toast(`Traceroute complete for ${t.name}`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setRunningTrace((prev) => { const next = new Set(prev); next.delete(t.id); return next; });
    }
  }

  async function setEnabledSelected(enabled) {
    const ids = [...selected];
    try {
      await Promise.all(ids.map((id) => toggleMut.mutateAsync({ url: `/api/admin/targets/${id}/enabled`, method: 'PATCH', body: { enabled } })));
      clearSelection();
      toast(`${enabled ? 'Enabled' : 'Disabled'} ${ids.length} target${ids.length !== 1 ? 's' : ''}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  if (targets.isLoading || groups.isLoading) return <div className="spinner" />;

  const q = search.trim().toLowerCase();
  const displayed = targets.data
    ?.filter((t) => !filterGroup || t.group_id === Number(filterGroup))
    ?.filter((t) => statusFilter.size === 0 || statusFilter.has(t.status))
    ?.filter((t) => !q || t.name.toLowerCase().includes(q) || t.host.toLowerCase().includes(q));

  const displayedIds = new Set(displayed?.map((t) => t.id) || []);
  const allSelected = (displayed?.length ?? 0) > 0 && displayed.every((t) => selected.has(t.id));
  const someSelected = !allSelected && displayed?.some((t) => selected.has(t.id));
  const selectedVisible = [...selected].filter((id) => displayedIds.has(id)).length;

  function toggleAll() {
    if (allSelected) {
      setSelected((prev) => { const next = new Set(prev); displayedIds.forEach((id) => next.delete(id)); return next; });
    } else {
      setSelected((prev) => new Set([...prev, ...displayedIds]));
    }
  }

  function toggleSelect(id) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  const filtersActive = filterGroup || statusFilter.size > 0 || q;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Targets</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {selectedVisible > 0 && (<>
            <button className="btn-ghost" onClick={() => setEnabledSelected(1)}>Enable {selectedVisible}</button>
            <button className="btn-ghost" onClick={() => setEnabledSelected(0)}>Disable {selectedVisible}</button>
            <button className="btn-danger" onClick={deleteSelected}>Delete {selectedVisible}</button>
          </>)}
          <button className="btn-ghost" onClick={() => setBulkAdding(true)}>Bulk Add</button>
          <button onClick={() => setAdding(true)}>+ New Target</button>
        </div>
      </div>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Search name or host…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); clearSelection(); }}
          style={{ width: 200 }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Group:</span>
          <select
            value={filterGroup}
            onChange={(e) => { setFilterGroup(e.target.value); clearSelection(); }}
            style={{ width: 'auto', minWidth: 160 }}
          >
            <option value="">All groups</option>
            {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Status:</span>
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={statusFilter.has(s) ? `badge ${STATUS_CLASS[s]}` : 'btn-ghost btn-sm'}
              style={{ cursor: 'pointer' }}
            >
              {s}
            </button>
          ))}
        </div>

        {filtersActive && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{displayed?.length} target{displayed?.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  onChange={toggleAll}
                />
              </th>
              <th>Name</th>
              <th>Group</th>
              <th>Host</th>
              <th>Type</th>
              <th>Interval</th>
              <th>Status</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {displayed?.map((t) => (
              <tr key={t.id} style={{ background: selected.has(t.id) ? 'rgba(123,97,255,0.06)' : undefined }}>
                <td>
                  <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)} />
                </td>
                <td>{t.name}</td>
                <td style={{ color: 'var(--text-muted)' }}>{t.group_name}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.host}</td>
                <td style={{ textTransform: 'uppercase', fontSize: 11 }}>{t.probe_type}</td>
                <td>{t.interval_seconds}s</td>
                <td><span className={`badge ${STATUS_CLASS[t.status] || 'badge-unknown'}`}>{t.status}</span></td>
                <td><Toggle checked={!!t.enabled} onChange={() => toggleEnabled(t)} /></td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-ghost btn-sm" onClick={() => setEditing(t)}>Edit</button>
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => runTraceroute(t)}
                      disabled={runningTrace.has(t.id)}
                      title="Run traceroute now"
                    >{runningTrace.has(t.id) ? 'Tracing…' : 'Trace'}</button>
                    <button className="btn-danger btn-sm" onClick={() => deleteTarget(t)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(adding || editing) && (
        <TargetModal
          target={editing}
          groups={groups.data || []}
          onSave={() => { setAdding(false); setEditing(null); toast('Saved'); }}
          onClose={() => { setAdding(false); setEditing(null); }}
        />
      )}

      {bulkAdding && (
        <BulkModal
          groups={groups.data || []}
          onSave={(count) => { setBulkAdding(false); toast(`Added ${count} target${count !== 1 ? 's' : ''}`); }}
          onClose={() => setBulkAdding(false)}
        />
      )}

      <Toast toasts={toasts} />
    </div>
  );
}
