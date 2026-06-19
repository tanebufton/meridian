import { useState, useEffect } from 'react';
import { useSettings, useUsers, useMutate } from '../hooks/useApi';
import Toggle from '../components/Toggle';
import Toast from '../components/Toast';
import { useToast } from '../hooks/useToast';

function UserModal({ onSave, onClose }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mut = useMutate(['admin-users']);

  async function submit(e) {
    e.preventDefault();
    try {
      await mut.mutateAsync({ url: '/api/admin/users', method: 'POST', body: { username, password } });
      onSave();
    } catch (err) { alert(err.message); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">New Admin User</div>
        <form onSubmit={submit}>
          <div className="field"><label>Username</label><input value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
          <div className="field"><label>Password (min 8 chars)</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Creating…' : 'Create User'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PasswordModal({ user, onSave, onClose }) {
  const [password, setPassword] = useState('');
  const mut = useMutate(['admin-users']);

  async function submit(e) {
    e.preventDefault();
    try {
      await mut.mutateAsync({ url: `/api/admin/users/${user.id}/password`, method: 'PUT', body: { password } });
      onSave();
    } catch (err) { alert(err.message); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Change Password — {user.username}</div>
        <form onSubmit={submit}>
          <div className="field"><label>New Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Saving…' : 'Change Password'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Settings() {
  const settings = useSettings();
  const users = useUsers();
  const { toasts, toast } = useToast();
  const [form, setForm] = useState(null);
  const [addingUser, setAddingUser] = useState(false);
  const [changingPwFor, setChangingPwFor] = useState(null);
  const settingsMut = useMutate(['admin-settings']);
  const deleteMut = useMutate(['admin-users']);
  const applyMut = useMutate(['admin-targets']);
  const backfillMut = useMutate([]);

  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data]);

  function setF(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function saveSettings(e) {
    e.preventDefault();
    try {
      await settingsMut.mutateAsync({
        url: '/api/admin/settings',
        method: 'PUT',
        body: {
          retention_raw_days: Number(form.retention_raw_days),
          retention_5min_days: Number(form.retention_5min_days),
          retention_1hour_days: Number(form.retention_1hour_days),
          default_probe_interval: Number(form.default_probe_interval),
          default_packet_count: Number(form.default_packet_count),
        },
      });
      toast('Settings saved');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function saveBanner(e) {
    e.preventDefault();
    try {
      await settingsMut.mutateAsync({
        url: '/api/admin/settings',
        method: 'PUT',
        body: {
          banner_enabled: !!form.banner_enabled,
          banner_text: form.banner_text || '',
          banner_type: form.banner_type || 'info',
        },
      });
      toast('Banner saved');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteUser(u) {
    if (!confirm(`Delete user "${u.username}"?`)) return;
    try {
      await deleteMut.mutateAsync({ url: `/api/admin/users/${u.id}`, method: 'DELETE' });
      toast('User deleted');
    } catch (err) { toast(err.message, 'error'); }
  }

  if (settings.isLoading || users.isLoading || !form) return <div className="spinner" />;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      {/* Settings form */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Data Retention</h2>
        <form onSubmit={saveSettings}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <div className="field"><label>Raw results (days)</label><input type="number" min={1} value={form.retention_raw_days} onChange={(e) => setF('retention_raw_days', e.target.value)} /></div>
            <div className="field"><label>5-min aggregates (days)</label><input type="number" min={1} value={form.retention_5min_days} onChange={(e) => setF('retention_5min_days', e.target.value)} /></div>
            <div className="field"><label>1-hour aggregates (days)</label><input type="number" min={1} value={form.retention_1hour_days} onChange={(e) => setF('retention_1hour_days', e.target.value)} /></div>
          </div>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: '16px 0' }}>Probe Defaults</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="field">
              <label>Default interval (seconds)</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="number" min={5} value={form.default_probe_interval} onChange={(e) => setF('default_probe_interval', e.target.value)} />
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  disabled={applyMut.isPending}
                  onClick={async () => {
                    const n = Number(form.default_probe_interval);
                    if (!n || n < 5) { toast('Invalid interval', 'error'); return; }
                    if (!confirm(`Apply ${n}s interval to ALL targets? This will override per-target settings.`)) return;
                    try {
                      const res = await applyMut.mutateAsync({ url: '/api/admin/targets/bulk-interval', method: 'POST', body: { interval_seconds: n } });
                      toast(`Applied ${n}s to ${res.updated} target${res.updated !== 1 ? 's' : ''}`);
                    } catch (err) { toast(err.message, 'error'); }
                  }}
                >
                  {applyMut.isPending ? 'Applying…' : 'Apply to all'}
                </button>
              </div>
            </div>
            <div className="field"><label>Default packet count</label><input type="number" min={1} value={form.default_packet_count} onChange={(e) => setF('default_packet_count', e.target.value)} /></div>
          </div>
          <button type="submit" disabled={settingsMut.isPending}>{settingsMut.isPending ? 'Saving…' : 'Save Settings'}</button>
        </form>
      </div>

      {/* Public Banner */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Public Banner</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          Displays a message at the top of the public monitoring dashboard.
        </p>
        <form onSubmit={saveBanner}>
          <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle checked={!!form.banner_enabled} onChange={(v) => setF('banner_enabled', v)} />
            <span style={{ fontSize: 13 }}>Show banner on public dashboard</span>
          </div>
          <div className="field">
            <label>Message</label>
            <input
              value={form.banner_text || ''}
              onChange={(e) => setF('banner_text', e.target.value)}
              placeholder="e.g. Scheduled maintenance tonight 10pm–2am UTC"
              maxLength={500}
            />
          </div>
          <div className="field">
            <label>Style</label>
            <select value={form.banner_type || 'info'} onChange={(e) => setF('banner_type', e.target.value)}>
              <option value="info">Info (purple)</option>
              <option value="warning">Warning (amber)</option>
              <option value="maintenance">Maintenance (grey)</option>
            </select>
          </div>
          <button type="submit" disabled={settingsMut.isPending}>{settingsMut.isPending ? 'Saving…' : 'Save Banner'}</button>
        </form>
      </div>

      {/* Maintenance */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Maintenance</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Run traceroute for all targets that are missing data or returned empty results.
          Processes {4} targets concurrently — results appear within a few minutes.
        </p>
        <button
          className="btn-ghost"
          disabled={backfillMut.isPending}
          onClick={async () => {
            try {
              const res = await backfillMut.mutateAsync({ url: '/api/admin/traceroute/backfill', method: 'POST', body: {} });
              toast(res.message || 'Backfill started');
            } catch (err) { toast(err.message, 'error'); }
          }}
        >
          {backfillMut.isPending ? 'Starting…' : 'Run Traceroute Backfill'}
        </button>
      </div>

      {/* Users */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Admin Users</h2>
          <button onClick={() => setAddingUser(true)}>+ Add User</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Created</th>
              <th>Last Login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(u.created_at * 1000).toLocaleDateString()}</td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{u.last_login ? new Date(u.last_login * 1000).toLocaleString() : 'Never'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-ghost btn-sm" onClick={() => setChangingPwFor(u)}>Change Password</button>
                    <button className="btn-danger btn-sm" onClick={() => deleteUser(u)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addingUser && (
        <UserModal
          onSave={() => { setAddingUser(false); toast('User created'); }}
          onClose={() => setAddingUser(false)}
        />
      )}
      {changingPwFor && (
        <PasswordModal
          user={changingPwFor}
          onSave={() => { setChangingPwFor(null); toast('Password changed'); }}
          onClose={() => setChangingPwFor(null)}
        />
      )}

      <Toast toasts={toasts} />
    </div>
  );
}
