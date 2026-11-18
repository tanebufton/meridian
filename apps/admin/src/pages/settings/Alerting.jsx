import { useEffect, useState } from 'react';
import { useSettings, useNotificationChannels, useGroups, useMutate, apiFetch } from '../../hooks/useApi';
import Toggle from '../../components/Toggle';
import Toast from '../../components/Toast';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../components/ConfirmDialog';

const CHANNELS = {
  pagerduty: { label: 'PagerDuty', ph: 'pagerduty://INTEGRATION_KEY', help: 'Use an Events API v2 integration key. Pages on-call and auto-resolves when the target recovers. Exempt from alert-flood batching.' },
  opsgenie: { label: 'Opsgenie', ph: 'opsgenie://API_KEY   (EU: opsgenie://API_KEY?region=eu)', help: 'Creates an alert per outage and closes it on recovery. Exempt from alert-flood batching.' },
  pushover: { label: 'Pushover', ph: 'pushover://USER_KEY@APP_TOKEN', help: 'Outages arrive as high-priority pushes that bypass quiet hours. Optional: ?device=phone&sound=siren' },
  ntfy: { label: 'ntfy', ph: 'https://ntfy.sh/your-topic', help: 'For a protected topic add ?token=tk_… (access token) or use https://user:pass@host/topic.' },
  slack: { label: 'Slack', ph: 'https://hooks.slack.com/services/T.../B.../...' },
  discord: { label: 'Discord', ph: 'https://discord.com/api/webhooks/ID/TOKEN' },
  teams: { label: 'Microsoft Teams', ph: 'https://…webhook.office.com/… or a Workflows webhook URL' },
  gotify: { label: 'Gotify', ph: 'https://gotify.example.com/message?token=APP_TOKEN' },
  telegram: { label: 'Telegram', ph: 'tgram://BOTTOKEN/CHATID', help: 'Get a bot token from @BotFather and your chat ID from @userinfobot.' },
  webhook: { label: 'Generic webhook', ph: 'https://your-service.example.com/webhook', help: 'Receives JSON with event, incident_id, target, host, group, status, duration_seconds, cause.' },
};
const PAGING = new Set(['pagerduty', 'opsgenie']);

function ChannelModal({ channel, groups, onSave, onClose }) {
  const [form, setForm] = useState({
    name: channel?.name || '',
    type: channel?.type || 'webhook',
    url: channel?.url || '',
    enabled: channel != null ? !!channel.enabled : true,
    group_ids: channel?.group_ids || [],
    send_recovery: channel ? !!channel.send_recovery : true,
  });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const mut = useMutate(['admin-notifications']);
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setResult(null); };

  async function submit(e) {
    e.preventDefault();
    try {
      await mut.mutateAsync({
        url: channel ? `/api/admin/notifications/${channel.id}` : '/api/admin/notifications',
        method: channel ? 'PUT' : 'POST', body: { ...form, group_ids: form.group_ids.length ? form.group_ids : null },
      });
      onSave();
    } catch (err) { setResult({ ok: false, msg: err.message }); }
  }

  async function test() {
    if (!form.url) { setResult({ ok: false, msg: 'Enter a URL first' }); return; }
    setTesting(true); setResult(null);
    try {
      // Test what is in the form, not what was last saved
      await apiFetch('/api/admin/notifications/test-channel', { method: 'POST', body: { type: form.type, url: form.url } });
      setResult({ ok: true, msg: 'Test message sent — check the channel' });
    } catch (err) { setResult({ ok: false, msg: err.message }); }
    finally { setTesting(false); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{channel ? 'Edit channel' : 'Add notification channel'}</div>
        <form onSubmit={submit}>
          <div className="field"><label>Name</label><input autoFocus required value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Discord #alerts" /></div>
          <div className="field">
            <label>Type</label>
            <select value={form.type} onChange={(e) => set('type', e.target.value)}>
              {Object.entries(CHANNELS).map(([t, c]) => <option key={t} value={t}>{c.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>URL</label>
            <input required className="mono" value={form.url} onChange={(e) => set('url', e.target.value)} placeholder={CHANNELS[form.type].ph} />
            {CHANNELS[form.type].help && <div className="muted help">{CHANNELS[form.type].help}</div>}
          </div>
          <div className="field">
            <label>Only alert for these groups <span style={{ fontWeight: 400 }}>— leave empty for all</span></label>
            <div className="chips">
              {groups.map((g) => {
                const on = form.group_ids.includes(g.id);
                return <button type="button" key={g.id} className={`chip${on ? ' on' : ''}`} onClick={() => set('group_ids', on ? form.group_ids.filter((x) => x !== g.id) : [...form.group_ids, g.id])}>{g.name}</button>;
              })}
            </div>
            <div className="muted help">e.g. page PagerDuty only for core infrastructure and send everything else to chat.</div>
          </div>
          <div className="field row"><Toggle checked={form.send_recovery} onChange={(v) => set('send_recovery', v)} /><span style={{ fontSize: 13 }}>Also send "recovered" messages</span></div>
          <div className="field row"><Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} /><span style={{ fontSize: 13 }}>Enabled</span></div>
          {result && <div className={result.ok ? 'ok-msg' : 'error-msg'} role="status">{result.msg}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-ghost" disabled={testing} onClick={test}>{testing ? 'Sending…' : 'Send test'}</button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Alerting() {
  const settings = useSettings();
  const channels = useNotificationChannels();
  const groups = useGroups();
  const { toasts, toast } = useToast();
  const ask = useConfirm();
  const [form, setForm] = useState(null);
  const [editing, setEditing] = useState(null); // channel, or {} for new
  const settingsMut = useMutate(['admin-settings']);
  const channelMut = useMutate(['admin-notifications']);

  useEffect(() => { if (settings.data && !form) setForm(settings.data); }, [settings.data, form]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function saveRules(e) {
    e.preventDefault();
    try {
      await settingsMut.mutateAsync({
        url: '/api/admin/settings', method: 'PUT',
        body: {
          alert_after_failures: Number(form.alert_after_failures),
          recover_after_successes: Number(form.recover_after_successes),
          renotify_minutes: Number(form.renotify_minutes),
          public_base_url: form.public_base_url || null,
          notify_route_changes: !!form.notify_route_changes,
        },
      });
      toast('Alert rules saved');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function remove(ch) {
    if (!(await ask({ title: `Delete "${ch.name}"?`, message: 'Alerts will no longer be sent to this channel.', confirmLabel: 'Delete', danger: true }))) return;
    try { await channelMut.mutateAsync({ url: `/api/admin/notifications/${ch.id}`, method: 'DELETE' }); toast('Channel deleted'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function test(ch) {
    try { await apiFetch(`/api/admin/notifications/${ch.id}/test`, { method: 'POST', body: {} }); toast(`Test sent to "${ch.name}"`); }
    catch (err) { toast(`Test failed: ${err.message}`, 'error'); }
  }

  async function toggle(ch) {
    try { await channelMut.mutateAsync({ url: `/api/admin/notifications/${ch.id}/enabled`, method: 'PATCH', body: { enabled: !ch.enabled } }); }
    catch (err) { toast(err.message, 'error'); }
  }

  if (settings.isLoading || !form) return <div className="spinner" />;
  const n = Number(form.alert_after_failures);

  return (
    <div>
      <div className="card section">
        <h2 className="card-title">When to alert</h2>
        <form onSubmit={saveRules}>
          <div className="grid-3">
            <div className="field">
              <label>Alert after N failed probes</label>
              <input type="number" min={1} max={20} value={form.alert_after_failures} onChange={(e) => set('alert_after_failures', e.target.value)} />
              <div className="muted help">{n <= 1 ? 'Alerts on the first failed probe — expect false alarms.' : `A target must fail ${n} probes in a row before it's called down. Filters out one-off blips.`}</div>
            </div>
            <div className="field">
              <label>Recover after N good probes</label>
              <input type="number" min={1} max={20} value={form.recover_after_successes} onChange={(e) => set('recover_after_successes', e.target.value)} />
              <div className="muted help">Higher values stop a flapping target from sending down/up/down/up messages.</div>
            </div>
            <div className="field">
              <label>Remind every (minutes)</label>
              <input type="number" min={0} max={10080} value={form.renotify_minutes} onChange={(e) => set('renotify_minutes', e.target.value)} />
              <div className="muted help">{Number(form.renotify_minutes) > 0 ? 'Repeats until someone acknowledges the incident.' : '0 = never repeat.'}</div>
            </div>
          </div>
          <div className="field row">
            <Toggle checked={!!form.notify_route_changes} onChange={(v) => set('notify_route_changes', v)} />
            <span style={{ fontSize: 13 }}>Tell chat channels when a route changes</span>
          </div>
          <div className="muted help" style={{ marginTop: -8, marginBottom: 14, maxWidth: 560 }}>
            Sends "Route to X changed: was AS… → now AS…" once a change is confirmed. Silent pushes on Pushover; never sent to PagerDuty or Opsgenie. Some targets legitimately switch carrier every few days, so try it on a channel you don't mind being chatty.
          </div>
          <div className="field" style={{ maxWidth: 440 }}>
            <label>Public base URL <span style={{ fontWeight: 400 }}>— optional</span></label>
            <input value={form.public_base_url || ''} onChange={(e) => set('public_base_url', e.target.value || null)} placeholder="https://status.example.com" />
            <div className="muted help">Adds a link to the target's page in every alert and in the Atom feed.</div>
          </div>
          <button type="submit" disabled={settingsMut.isPending}>{settingsMut.isPending ? 'Saving…' : 'Save alert rules'}</button>
        </form>
      </div>

      <div className="card section">
        <div className="card-head">
          <h2 className="card-title" style={{ margin: 0 }}>Notification channels</h2>
          <button onClick={() => setEditing({})}>+ Add channel</button>
        </div>
        <p className="muted help" style={{ marginBottom: 14 }}>
          PagerDuty, Opsgenie, Pushover, ntfy, Slack, Discord, Teams, Gotify, Telegram or any webhook. Failed deliveries are retried. If many targets fail at once, chat channels get one batched summary, while paging channels (PagerDuty, Opsgenie) still page for every outage.
        </p>
        {channels.data?.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Type</th><th>Scope</th><th>Last delivery</th><th>On</th><th></th></tr></thead>
              <tbody>
                {channels.data.map((ch) => (
                  <tr key={ch.id}>
                    <td style={{ fontWeight: 500 }}>{ch.name}</td>
                    <td style={{ fontSize: 12 }}>{CHANNELS[ch.type]?.label || ch.type}{PAGING.has(ch.type) && <span className="badge badge-ack" style={{ marginLeft: 6 }}>pages</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {ch.group_ids?.length ? ch.group_ids.map((id) => groups.data?.find((g) => g.id === id)?.name || `#${id}`).join(', ') : 'All groups'}
                      {!ch.send_recovery && ' · no recoveries'}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {ch.last_error
                        ? <span style={{ color: 'var(--danger)' }} title={ch.last_error}>✕ failed {new Date(ch.last_error_at * 1000).toLocaleString()}<div className="muted" style={{ fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.last_error}</div></span>
                        : ch.last_ok_at ? <span style={{ color: 'var(--success)' }}>✓ {new Date(ch.last_ok_at * 1000).toLocaleString()}</span>
                        : <span className="muted">not used yet</span>}
                    </td>
                    <td><Toggle checked={!!ch.enabled} onChange={() => toggle(ch)} /></td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn-ghost btn-sm" onClick={() => test(ch)}>Test</button>
                        <button className="btn-ghost btn-sm" onClick={() => setEditing(ch)}>Edit</button>
                        <button className="btn-danger btn-sm" onClick={() => remove(ch)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No channels yet — add one to get alerted when something goes down.</p>}
      </div>

      <div className="card section">
        <h2 className="card-title">Prometheus metrics</h2>
        <p className="muted help" style={{ lineHeight: 1.7 }}>
          Meridian can expose every target's status, latency, loss and uptime at <code>/metrics</code> on this admin port, for Prometheus / Grafana / Alertmanager.
          Set <code>METRICS_TOKEN</code> in <code>.env</code> (any long random string) and restart <code>meridian-admin</code> to enable it, then scrape with
          <code> Authorization: Bearer &lt;token&gt;</code>. Without a token the endpoint doesn't exist.
        </p>
      </div>

      {editing && (
        <ChannelModal
          channel={editing.id ? editing : null}
          groups={groups.data || []}
          onSave={() => { setEditing(null); toast('Channel saved'); }}
          onClose={() => setEditing(null)}
        />
      )}
      <Toast toasts={toasts} />
    </div>
  );
}
