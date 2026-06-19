import { useState, useEffect, useRef } from 'react';
import { useSettings, useUsers, useNotificationChannels, useMutate, apiFetch } from '../hooks/useApi';
import Toggle from '../components/Toggle';
import Toast from '../components/Toast';
import { useToast } from '../hooks/useToast';

const CHANNEL_TYPES = ['webhook', 'slack', 'discord', 'ntfy', 'telegram'];

const CHANNEL_PLACEHOLDERS = {
  webhook: 'https://your-service.example.com/webhook',
  slack: 'https://hooks.slack.com/services/T.../B.../...',
  discord: 'https://discord.com/api/webhooks/ID/TOKEN',
  ntfy: 'https://ntfy.sh/your-topic',
  telegram: 'tgram://BOTTOKEN/CHATID',
};

function ChannelModal({ channel, onSave, onClose }) {
  const [form, setForm] = useState({
    name: channel?.name || '',
    type: channel?.type || 'webhook',
    url: channel?.url || '',
    enabled: channel != null ? !!channel.enabled : true,
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const mut = useMutate(['admin-notifications']);

  function setF(k, v) { setForm((f) => ({ ...f, [k]: v })); setTestResult(null); }

  async function submit(e) {
    e.preventDefault();
    try {
      const url = channel
        ? `/api/admin/notifications/${channel.id}`
        : '/api/admin/notifications';
      const method = channel ? 'PUT' : 'POST';
      await mut.mutateAsync({ url, method, body: form });
      onSave();
    } catch (err) { alert(err.message); }
  }

  async function handleTest() {
    if (!form.url) { setTestResult({ ok: false, msg: 'Enter a URL first' }); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const testUrl = channel
        ? `/api/admin/notifications/${channel.id}/test`
        : '/api/admin/notifications/test-channel';
      const body = channel ? {} : { type: form.type, url: form.url };
      await apiFetch(testUrl, { method: 'POST', body });
      setTestResult({ ok: true, msg: 'Test sent successfully' });
    } catch (err) {
      setTestResult({ ok: false, msg: err.message });
    } finally { setTesting(false); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{channel ? 'Edit Channel' : 'Add Notification Channel'}</div>
        <form onSubmit={submit}>
          <div className="field">
            <label>Name</label>
            <input value={form.name} onChange={(e) => setF('name', e.target.value)} required placeholder="e.g. Discord alerts" />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={form.type} onChange={(e) => setF('type', e.target.value)}>
              {CHANNEL_TYPES.map((t) => (
                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>URL</label>
            <input
              value={form.url}
              onChange={(e) => setF('url', e.target.value)}
              required
              placeholder={CHANNEL_PLACEHOLDERS[form.type]}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
            {form.type === 'telegram' && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Get your bot token from @BotFather. Find your chat ID via @userinfobot.
              </div>
            )}
          </div>
          <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle checked={form.enabled} onChange={(v) => setF('enabled', v)} />
            <span style={{ fontSize: 13 }}>Enabled</span>
          </div>
          {testResult && (
            <div style={{ fontSize: 12, color: testResult.ok ? 'var(--success)' : 'var(--danger)', marginBottom: 8 }}>
              {testResult.msg}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-ghost" disabled={testing} onClick={handleTest}>
              {testing ? 'Sending…' : 'Test'}
            </button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

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
  const notifications = useNotificationChannels();
  const { toasts, toast } = useToast();
  const [form, setForm] = useState(null);
  const [addingUser, setAddingUser] = useState(false);
  const [changingPwFor, setChangingPwFor] = useState(null);
  const [editingChannel, setEditingChannel] = useState(null);
  const [addingChannel, setAddingChannel] = useState(false);
  const settingsMut = useMutate(['admin-settings']);
  const deleteMut = useMutate(['admin-users']);
  const applyMut = useMutate(['admin-targets']);
  const backfillMut = useMutate([]);
  const channelMut = useMutate(['admin-notifications']);
  const importMut = useMutate(['admin-groups', 'admin-targets']);
  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);

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

  async function deleteChannel(ch) {
    if (!confirm(`Delete channel "${ch.name}"?`)) return;
    try {
      await channelMut.mutateAsync({ url: `/api/admin/notifications/${ch.id}`, method: 'DELETE' });
      toast('Channel deleted');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function testChannel(ch) {
    try {
      await apiFetch(`/api/admin/notifications/${ch.id}/test`, { method: 'POST', body: {} });
      toast(`Test sent to "${ch.name}"`);
    } catch (err) { toast(`Test failed: ${err.message}`, 'error'); }
  }

  async function toggleChannel(ch) {
    try {
      await channelMut.mutateAsync({
        url: `/api/admin/notifications/${ch.id}/enabled`,
        method: 'PATCH',
        body: { enabled: !ch.enabled },
      });
    } catch (err) { toast(err.message, 'error'); }
  }

  async function saveNotifSettings(e) {
    e.preventDefault();
    try {
      await settingsMut.mutateAsync({
        url: '/api/admin/settings',
        method: 'PUT',
        body: { public_base_url: form.public_base_url || null },
      });
      toast('Notification settings saved');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleExport() {
    try {
      const data = await apiFetch('/api/admin/config/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `meridian-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      toast('Could not parse file — must be valid JSON', 'error');
      return;
    }

    const groupCount = parsed?.groups?.length ?? 0;
    const targetCount = parsed?.groups?.reduce((sum, g) => sum + (g.targets?.length ?? 0), 0) ?? 0;

    if (!confirm(
      `WARNING: This will permanently delete all existing groups and targets and replace them with:\n\n` +
      `  • ${groupCount} group${groupCount !== 1 ? 's' : ''}\n` +
      `  • ${targetCount} target${targetCount !== 1 ? 's' : ''}\n\n` +
      `This cannot be undone. Continue?`
    )) return;

    setImporting(true);
    try {
      const res = await importMut.mutateAsync({ url: '/api/admin/config/import', method: 'POST', body: parsed });
      toast(`Imported ${res.imported.groups} groups and ${res.imported.targets} targets`);
    } catch (err) { toast(err.message, 'error'); }
    finally { setImporting(false); }
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

      {/* Notification Channels */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>Notification Channels</h2>
          <button onClick={() => setAddingChannel(true)}>+ Add Channel</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          Send alerts when a target goes DOWN or recovers. Supports Slack, Discord, ntfy, Telegram, and generic webhooks.
        </p>
        <form onSubmit={saveNotifSettings} style={{ marginBottom: 20 }}>
          <div className="field" style={{ maxWidth: 420 }}>
            <label>Public base URL <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>— optional</span></label>
            <input
              value={form?.public_base_url || ''}
              onChange={(e) => setF('public_base_url', e.target.value || null)}
              placeholder="https://status.example.com"
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              When set, notifications include a direct link to the affected target's detail page.
            </div>
          </div>
          <button type="submit" className="btn-ghost" disabled={settingsMut.isPending}>
            {settingsMut.isPending ? 'Saving…' : 'Save'}
          </button>
        </form>
        {notifications.data?.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>URL</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {notifications.data.map((ch) => (
                <tr key={ch.id}>
                  <td style={{ fontWeight: 500 }}>{ch.name}</td>
                  <td style={{ fontSize: 12 }}>{ch.type}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ch.url}
                  </td>
                  <td>
                    <Toggle checked={!!ch.enabled} onChange={() => toggleChannel(ch)} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-ghost btn-sm" onClick={() => testChannel(ch)}>Test</button>
                      <button className="btn-ghost btn-sm" onClick={() => setEditingChannel(ch)}>Edit</button>
                      <button className="btn-danger btn-sm" onClick={() => deleteChannel(ch)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No channels configured yet.</p>
        )}
      </div>

      {/* Import / Export */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Import / Export</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          Export all groups and targets to a JSON file for backup or migration.
          Importing a file will <strong>permanently replace</strong> all existing groups and targets.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-ghost" onClick={handleExport}>Export Config</button>
          <button
            className="btn-ghost"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
          >
            {importing ? 'Importing…' : 'Import Config'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
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
      {addingChannel && (
        <ChannelModal
          onSave={() => { setAddingChannel(false); toast('Channel added'); }}
          onClose={() => setAddingChannel(false)}
        />
      )}
      {editingChannel && (
        <ChannelModal
          channel={editingChannel}
          onSave={() => { setEditingChannel(null); toast('Channel updated'); }}
          onClose={() => setEditingChannel(null)}
        />
      )}

      <Toast toasts={toasts} />
    </div>
  );
}
