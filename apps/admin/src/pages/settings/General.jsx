import { useEffect, useState } from 'react';
import { useSettings, useMutate } from '../../hooks/useApi';
import Toggle from '../../components/Toggle';
import Toast from '../../components/Toast';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../components/ConfirmDialog';

export default function General() {
  const settings = useSettings();
  const { toasts, toast } = useToast();
  const ask = useConfirm();
  const [form, setForm] = useState(null);
  const settingsMut = useMutate(['admin-settings']);
  const applyMut = useMutate(['admin-targets']);

  useEffect(() => { if (settings.data && !form) setForm(settings.data); }, [settings.data, form]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e, keys, message) {
    e.preventDefault();
    const body = {};
    for (const k of keys) body[k] = typeof form[k] === 'boolean' ? form[k] : (typeof form[k] === 'string' && /^\d+$/.test(form[k]) ? Number(form[k]) : form[k]);
    try {
      await settingsMut.mutateAsync({ url: '/api/admin/settings', method: 'PUT', body });
      toast(message);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function applyInterval() {
    const n = Number(form.default_probe_interval);
    if (!n || n < 5) { toast('Enter an interval of at least 5 seconds', 'error'); return; }
    if (!(await ask({
      title: `Apply ${n}s to every target?`,
      message: 'This overwrites the interval on ALL existing targets, including any you set individually.',
      confirmLabel: 'Apply to all', danger: true,
    }))) return;
    try {
      const res = await applyMut.mutateAsync({ url: '/api/admin/targets/bulk-interval', method: 'POST', body: { interval_seconds: n } });
      toast(`Applied ${n}s to ${res.updated} target${res.updated !== 1 ? 's' : ''}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  if (settings.isLoading || !form) return <div className="spinner" />;

  return (
    <div>
      <div className="card section">
        <h2 className="card-title">Data retention</h2>
        <p className="muted help">Raw results are rolled up into 5-minute and then 1-hour averages. Older data is deleted nightly at 02:00.</p>
        <form onSubmit={(e) => save(e, ['retention_raw_days', 'retention_5min_days', 'retention_1hour_days'], 'Retention saved')}>
          <div className="grid-3">
            <div className="field"><label>Raw results (days)</label><input type="number" min={1} max={365} value={form.retention_raw_days} onChange={(e) => set('retention_raw_days', e.target.value)} /></div>
            <div className="field"><label>5-min aggregates (days)</label><input type="number" min={1} max={730} value={form.retention_5min_days} onChange={(e) => set('retention_5min_days', e.target.value)} /></div>
            <div className="field"><label>1-hour aggregates (days)</label><input type="number" min={1} max={3650} value={form.retention_1hour_days} onChange={(e) => set('retention_1hour_days', e.target.value)} /></div>
          </div>
          <button type="submit" disabled={settingsMut.isPending}>Save retention</button>
        </form>
      </div>

      <div className="card section">
        <h2 className="card-title">Probe defaults</h2>
        <form onSubmit={(e) => save(e, ['default_probe_interval', 'default_packet_count'], 'Defaults saved')}>
          <div className="grid-2">
            <div className="field">
              <label>Default interval (seconds)</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" min={5} max={3600} value={form.default_probe_interval} onChange={(e) => set('default_probe_interval', e.target.value)} />
                <button type="button" className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }} disabled={applyMut.isPending} onClick={applyInterval}>
                  {applyMut.isPending ? 'Applying…' : 'Apply to all'}
                </button>
              </div>
            </div>
            <div className="field"><label>Default packet count</label><input type="number" min={1} max={100} value={form.default_packet_count} onChange={(e) => set('default_packet_count', e.target.value)} /></div>
          </div>
          <button type="submit" disabled={settingsMut.isPending}>Save defaults</button>
        </form>
      </div>

      <div className="card section">
        <h2 className="card-title">Public banner</h2>
        <p className="muted help">A message shown at the top of the public dashboard. For planned work, <strong>Maintenance</strong> windows add their own banner automatically.</p>
        <form onSubmit={(e) => save(e, ['banner_enabled', 'banner_text', 'banner_type'], 'Banner saved')}>
          <div className="field row">
            <Toggle checked={!!form.banner_enabled} onChange={(v) => set('banner_enabled', v)} />
            <span style={{ fontSize: 13 }}>Show banner on public dashboard</span>
          </div>
          <div className="field">
            <label>Message</label>
            <input value={form.banner_text || ''} onChange={(e) => set('banner_text', e.target.value)} placeholder="e.g. We're investigating slow responses from our Sydney peering" maxLength={500} />
          </div>
          <div className="field" style={{ maxWidth: 260 }}>
            <label>Style</label>
            <select value={form.banner_type || 'info'} onChange={(e) => set('banner_type', e.target.value)}>
              <option value="info">Info (purple)</option>
              <option value="warning">Warning (amber)</option>
              <option value="maintenance">Maintenance (grey)</option>
            </select>
          </div>
          <button type="submit" disabled={settingsMut.isPending}>Save banner</button>
        </form>
      </div>
      <Toast toasts={toasts} />
    </div>
  );
}
