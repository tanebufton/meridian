import { useRef, useState } from 'react';
import { useMutate, useSettings, apiFetch } from '../../hooks/useApi';
import Toast from '../../components/Toast';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../components/ConfirmDialog';

function ImportModal({ data, onDone, onClose }) {
  const [mode, setMode] = useState('merge');
  const [error, setError] = useState('');
  const ask = useConfirm();
  const mut = useMutate(['admin-groups', 'admin-targets']);
  const groups = data.groups?.length ?? 0;
  const targets = data.groups?.reduce((n, g) => n + (g.targets?.length ?? 0), 0) ?? 0;

  async function run() {
    setError('');
    if (mode === 'replace' && !(await ask({
      title: 'Replace everything?',
      message: 'All existing groups, targets AND their history will be deleted and replaced. A backup of the database is saved first, but restoring it is a manual step.',
      confirmLabel: 'Delete and replace', danger: true,
    }))) return;
    try {
      const res = await mut.mutateAsync({ url: '/api/admin/config/import', method: 'POST', body: { ...data, mode } });
      onDone(res);
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Import configuration</div>
        <p style={{ fontSize: 13, marginBottom: 14 }}>The file contains <strong>{groups}</strong> group{groups !== 1 ? 's' : ''} and <strong>{targets}</strong> target{targets !== 1 ? 's' : ''}.</p>
        {error && <div className="error-msg" role="alert">{error}</div>}
        <label className={`choice${mode === 'merge' ? ' selected' : ''}`}>
          <input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
          <div><strong>Add what's missing</strong> <span className="badge badge-up">Recommended</span>
            <div className="muted help">Creates groups and targets that don't exist yet. Existing ones, and all history, are left alone.</div></div>
        </label>
        <label className={`choice${mode === 'replace' ? ' selected danger' : ''}`}>
          <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          <div><strong>Replace everything</strong>
            <div className="muted help">Deletes all current groups, targets <em>and probe history</em> first.</div></div>
        </label>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className={mode === 'replace' ? 'btn-danger' : ''} disabled={mut.isPending} onClick={run}>{mut.isPending ? 'Importing…' : mode === 'replace' ? 'Replace…' : 'Import'}</button>
        </div>
      </div>
    </div>
  );
}

function TraceSettings({ toast }) {
  const settings = useSettings();
  const mut = useMutate(['admin-settings']);
  const [method, setMethod] = useState(null);
  const [confirmRuns, setConfirmRuns] = useState(null);
  const [ownAsn, setOwnAsn] = useState(null);
  if (!settings.data) return null;
  const m = method ?? settings.data.traceroute_method ?? 'auto';
  const c = confirmRuns ?? settings.data.route_confirm_runs ?? 2;
  const asn = ownAsn ?? (settings.data.own_asn ?? '');
  async function save(e) {
    e.preventDefault();
    try { await mut.mutateAsync({ url: '/api/admin/settings', method: 'PUT', body: { traceroute_method: m, route_confirm_runs: Number(c), own_asn: String(asn).trim() === '' ? null : Number(String(asn).replace(/^AS/i, '')) } }); toast('Traceroute settings saved'); }
    catch (err) { toast(err.message, 'error'); }
  }
  return (
    <form onSubmit={save}>
      <div className="grid-2" style={{ maxWidth: 640 }}>
        <div className="field">
          <label>Probe method</label>
          <select value={m} onChange={(e) => setMethod(e.target.value)}>
            <option value="auto">Automatic (ICMP, then TCP, then UDP)</option>
            <option value="icmp">ICMP only</option>
            <option value="tcp">TCP :443 only</option>
            <option value="udp">UDP only (traceroute default)</option>
          </select>
          <div className="muted help">UDP, the traceroute default, is dropped by many networks and reached only 3 of 10 test destinations; ICMP reached all 10.</div>
        </div>
        <div className="field">
          <label>Confirm a route change after N runs</label>
          <input type="number" min={1} max={5} value={c} onChange={(e) => setConfirmRuns(e.target.value)} />
          <div className="muted help">A changed AS path is only recorded if it's seen on this many consecutive runs (re-checked every ~15 min), so one-off blips are ignored.</div>
        </div>
      </div>
      <div className="field" style={{ maxWidth: 320 }}>
        <label>Your network's AS number <span style={{ fontWeight: 400 }}>— optional</span></label>
        <input value={asn} onChange={(e) => setOwnAsn(e.target.value)} placeholder="e.g. 55850 (leave empty to detect)" inputMode="numeric" />
        <div className="muted help">The Routing page works out which carrier each path leaves through. It detects your AS from the traceroutes; set it here if your own routers don't answer traceroute (or you're behind a provider's NAT), otherwise your provider would be mistaken for you.</div>
      </div>
      <button type="submit" disabled={mut.isPending}>Save</button>
    </form>
  );
}

export default function Data() {
  const { toasts, toast } = useToast();
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null);
  const backfill = useMutate([]);

  async function exportConfig() {
    try {
      const data = await apiFetch('/api/admin/config/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `meridian-config-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function pickFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { setPending(JSON.parse(await file.text())); }
    catch { toast('That file isn\'t valid JSON', 'error'); }
  }

  return (
    <div>
      <div className="card section">
        <h2 className="card-title">Export / import</h2>
        <p className="muted help" style={{ marginBottom: 14 }}>Back up or move your groups and targets as a JSON file. Probe history isn't included.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-ghost" onClick={exportConfig}>Export config</button>
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Import config…</button>
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={pickFile} />
      </div>

      <div className="card section">
        <h2 className="card-title">Traceroute</h2>
        <TraceSettings toast={toast} />
        <p className="muted help" style={{ margin: '18px 0 14px' }}>Run traceroute for every target that has no path data yet (or an empty one). Four at a time; results appear within a few minutes.</p>
        <button className="btn-ghost" disabled={backfill.isPending} onClick={async () => {
          try { const r = await backfill.mutateAsync({ url: '/api/admin/traceroute/backfill', method: 'POST', body: {} }); toast(r.message || 'Started'); }
          catch (err) { toast(err.message, 'error'); }
        }}>{backfill.isPending ? 'Starting…' : 'Run traceroute backfill'}</button>
      </div>

      {pending && <ImportModal data={pending} onClose={() => setPending(null)} onDone={(res) => {
        setPending(null);
        const i = res.imported;
        toast(`Added ${i.groups} group${i.groups !== 1 ? 's' : ''} and ${i.targets} target${i.targets !== 1 ? 's' : ''}${i.skipped ? ` (${i.skipped} already existed)` : ''}`);
      }} />}
      <Toast toasts={toasts} />
    </div>
  );
}
