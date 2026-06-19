import { useState } from 'react';
import { useGroups, useMutate } from '../hooks/useApi';
import Toast from '../components/Toast';
import { useToast } from '../hooks/useToast';

const EMPTY = { name: '', description: '', sort_order: 0 };

function GroupModal({ group, onSave, onClose }) {
  const [form, setForm] = useState(group || EMPTY);
  const mut = useMutate(['admin-groups']);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e) {
    e.preventDefault();
    try {
      if (group) {
        await mut.mutateAsync({ url: `/api/admin/groups/${group.id}`, method: 'PUT', body: { ...form, sort_order: Number(form.sort_order) } });
      } else {
        await mut.mutateAsync({ url: '/api/admin/groups', method: 'POST', body: { ...form, sort_order: Number(form.sort_order) } });
      }
      onSave();
    } catch (err) { alert(err.message); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{group ? 'Edit Group' : 'New Group'}</div>
        <form onSubmit={submit}>
          <div className="field"><label>Name</label><input value={form.name} onChange={(e) => set('name', e.target.value)} required /></div>
          <div className="field"><label>Description</label><input value={form.description || ''} onChange={(e) => set('description', e.target.value)} /></div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Groups() {
  const groups = useGroups();
  const { toasts, toast } = useToast();
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const deleteMut = useMutate(['admin-groups']);
  const orderMut = useMutate(['admin-groups']);
  const enableMut = useMutate(['admin-groups']);

  if (groups.isLoading) return <div className="spinner" />;

  const sorted = [...(groups.data || [])].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  async function deleteGroup(g) {
    if (!confirm(`Delete group "${g.name}"? All targets in this group will also be deleted.`)) return;
    try {
      await deleteMut.mutateAsync({ url: `/api/admin/groups/${g.id}`, method: 'DELETE' });
      toast('Group deleted');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function applyOrder(newList) {
    try {
      await Promise.all(
        newList.map((g, i) =>
          orderMut.mutateAsync({ url: `/api/admin/groups/${g.id}/order`, method: 'PUT', body: { sort_order: i } })
        )
      );
    } catch (err) { toast(err.message, 'error'); }
  }

  function move(g, delta) {
    const idx = sorted.findIndex((x) => x.id === g.id);
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= sorted.length) return;
    const next = [...sorted];
    next.splice(idx, 1);
    next.splice(newIdx, 0, g);
    applyOrder(next);
  }

  function handleDrop(toId) {
    if (!dragId || dragId === toId) return;
    const fromIdx = sorted.findIndex((g) => g.id === dragId);
    const toIdx = sorted.findIndex((g) => g.id === toId);
    const next = [...sorted];
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    applyOrder(next);
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Groups</h1>
        <button onClick={() => setAdding(true)}>+ New Group</button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th>Name</th>
              <th>Description</th>
              <th>Targets</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((g, i) => (
              <tr
                key={g.id}
                draggable
                onDragStart={() => setDragId(g.id)}
                onDragOver={(e) => { e.preventDefault(); setDragOverId(g.id); }}
                onDrop={(e) => { e.preventDefault(); handleDrop(g.id); setDragId(null); setDragOverId(null); }}
                onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                style={{
                  opacity: dragId === g.id ? 0.4 : 1,
                  outline: dragOverId === g.id && dragId !== g.id ? '2px solid var(--accent)' : undefined,
                  outlineOffset: '-2px',
                }}
              >
                <td
                  style={{ cursor: 'grab', color: 'var(--text-muted)', textAlign: 'center', fontSize: 16, userSelect: 'none' }}
                  title="Drag to reorder"
                >
                  ⠿
                </td>
                <td>{g.name}</td>
                <td style={{ color: 'var(--text-muted)' }}>{g.description || '—'}</td>
                <td>{g.target_count}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-ghost btn-sm" onClick={() => move(g, -1)} disabled={i === 0} title="Move up">↑</button>
                    <button className="btn-ghost btn-sm" onClick={() => move(g, 1)} disabled={i === sorted.length - 1} title="Move down">↓</button>
                    {g.target_count > 0 && (
                      g.enabled_count === g.target_count
                        ? <button className="btn-ghost btn-sm" onClick={() => enableMut.mutateAsync({ url: `/api/admin/groups/${g.id}/enabled`, method: 'PATCH', body: { enabled: 0 } }).catch((e) => toast(e.message, 'error'))}>Disable all</button>
                        : <button className="btn-ghost btn-sm" onClick={() => enableMut.mutateAsync({ url: `/api/admin/groups/${g.id}/enabled`, method: 'PATCH', body: { enabled: 1 } }).catch((e) => toast(e.message, 'error'))}>Enable all</button>
                    )}
                    <button className="btn-ghost btn-sm" onClick={() => setEditing(g)}>Edit</button>
                    <button className="btn-danger btn-sm" onClick={() => deleteGroup(g)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(adding || editing) && (
        <GroupModal
          group={editing}
          onSave={() => { setAdding(false); setEditing(null); toast('Saved'); }}
          onClose={() => { setAdding(false); setEditing(null); }}
        />
      )}

      <Toast toasts={toasts} />
    </div>
  );
}
