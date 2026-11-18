import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useMe, useTwoFactor, apiFetch } from '../../hooks/useApi';
import Toast from '../../components/Toast';
import { useToast } from '../../hooks/useToast';

function PasswordCard({ toast }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (next !== again) { setError('The new passwords don\'t match'); return; }
    setBusy(true);
    try {
      const res = await apiFetch('/api/admin/auth/change-password', { method: 'POST', body: { current_password: cur, new_password: next } });
      setCur(''); setNext(''); setAgain('');
      toast(res.other_sessions_revoked ? `Password changed — ${res.other_sessions_revoked} other session${res.other_sessions_revoked > 1 ? 's were' : ' was'} signed out` : 'Password changed');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="card section">
      <h2 className="card-title">Change password</h2>
      <form onSubmit={submit} style={{ maxWidth: 380 }}>
        {error && <div className="error-msg" role="alert">{error}</div>}
        <div className="field"><label htmlFor="cp">Current password</label><input id="cp" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></div>
        <div className="field">
          <label htmlFor="np">New password</label>
          <input id="np" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
          <div className="muted help">At least 10 characters. A few random words is stronger than clever symbols.</div>
        </div>
        <div className="field"><label htmlFor="np2">Confirm new password</label><input id="np2" type="password" autoComplete="new-password" minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} required /></div>
        <button type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button>
        <div className="muted help" style={{ marginTop: 10 }}>Changing your password signs you out everywhere else.</div>
      </form>
    </div>
  );
}

function RecoveryCodes({ codes, onDone }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard unavailable */ }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([`Meridian recovery codes\n(each works once)\n\n${text}\n`], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'meridian-recovery-codes.txt' });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="warn-msg">
        <strong>Save these recovery codes now.</strong> If you lose your phone, each code lets you sign in once. They won't be shown again.
      </div>
      <div className="recovery-grid">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div style={{ display: 'flex', gap: 8, margin: '14px 0' }}>
        <button className="btn-ghost btn-sm" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
        <button className="btn-ghost btn-sm" onClick={download}>Download .txt</button>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I've stored these somewhere safe
      </label>
      <button style={{ marginTop: 14 }} disabled={!saved} onClick={onDone}>Done</button>
    </div>
  );
}

// Asks for password + a current code before a sensitive 2FA change
function Reauth({ label, danger, onSubmit, onCancel, busy, error }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ password, code }); }} style={{ maxWidth: 380, marginTop: 14 }}>
      {error && <div className="error-msg" role="alert">{error}</div>}
      <div className="field"><label>Password</label><input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
      <div className="field"><label>Authenticator code or recovery code</label><input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" className="mono" required /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className={danger ? 'btn-danger' : ''} disabled={busy}>{busy ? 'Working…' : label}</button>
      </div>
    </form>
  );
}

function TwoFactorCard({ toast }) {
  const status = useTwoFactor();
  const qc = useQueryClient();
  const [step, setStep] = useState('idle'); // idle | password | scan | codes | disable | regen
  const [pw, setPw] = useState('');
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-2fa'] }); qc.invalidateQueries({ queryKey: ['me'] }); qc.invalidateQueries({ queryKey: ['admin-users'] }); };
  const reset = () => { setStep('idle'); setPw(''); setCode(''); setError(''); setSetup(null); };

  async function run(fn) {
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const begin = (e) => { e.preventDefault(); run(async () => { setSetup(await apiFetch('/api/admin/auth/2fa/setup', { method: 'POST', body: { password: pw } })); setStep('scan'); }); };
  const enable = (e) => { e.preventDefault(); run(async () => { const r = await apiFetch('/api/admin/auth/2fa/enable', { method: 'POST', body: { code } }); setCodes(r.recovery_codes); setStep('codes'); refresh(); }); };
  const disable = (v) => run(async () => { await apiFetch('/api/admin/auth/2fa/disable', { method: 'POST', body: v }); reset(); refresh(); toast('Two-factor authentication turned off'); });
  const regen = (v) => run(async () => { const r = await apiFetch('/api/admin/auth/2fa/recovery-codes', { method: 'POST', body: v }); setCodes(r.recovery_codes); setStep('codes'); refresh(); });

  if (status.isLoading) return <div className="card section"><div className="spinner" /></div>;
  const enabled = status.data?.enabled;

  return (
    <div className="card section">
      <div className="card-head">
        <h2 className="card-title" style={{ margin: 0 }}>Two-factor authentication</h2>
        <span className={`badge ${enabled ? 'badge-up' : 'badge-unknown'}`}>{enabled ? 'On' : 'Off'}</span>
      </div>
      <p className="muted help" style={{ margin: '6px 0 14px' }}>
        Adds a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden…) to every sign-in, so a stolen password alone isn't enough.
      </p>

      {step === 'codes' && codes ? (
        <RecoveryCodes codes={codes} onDone={() => { reset(); setCodes(null); toast('Two-factor authentication is on'); }} />
      ) : step === 'password' ? (
        <form onSubmit={begin} style={{ maxWidth: 380 }}>
          {error && <div className="error-msg" role="alert">{error}</div>}
          <div className="field"><label>Confirm your password to continue</label><input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required /></div>
          <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn-ghost" onClick={reset}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Working…' : 'Continue'}</button></div>
        </form>
      ) : step === 'scan' && setup ? (
        <form onSubmit={enable}>
          <ol className="steps">
            <li>Scan this QR code with your authenticator app.
              <div className="qr"><img alt="Two-factor QR code" width={200} height={200} src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr_svg)}`} /></div>
              <details style={{ marginTop: 8 }}><summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>Can't scan? Enter the key manually</summary><code className="mono secret">{setup.secret}</code></details>
            </li>
            <li>Enter the 6-digit code it shows to confirm it's working.
              <div className="field" style={{ maxWidth: 200, marginTop: 8 }}>
                <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={7} autoFocus required className="mono" style={{ fontSize: 18, letterSpacing: '0.15em', textAlign: 'center' }} />
              </div>
            </li>
          </ol>
          {error && <div className="error-msg" role="alert">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn-ghost" onClick={reset}>Cancel</button><button type="submit" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Turn on'}</button></div>
        </form>
      ) : step === 'disable' ? (
        <Reauth label="Turn off 2FA" danger busy={busy} error={error} onSubmit={disable} onCancel={reset} />
      ) : step === 'regen' ? (
        <Reauth label="Generate new codes" busy={busy} error={error} onSubmit={regen} onCancel={reset} />
      ) : enabled ? (
        <div>
          <p style={{ fontSize: 13 }}>
            Recovery codes left: <strong style={{ color: status.data.recovery_codes_remaining <= 2 ? 'var(--warning)' : 'inherit' }}>{status.data.recovery_codes_remaining}</strong>
            {status.data.recovery_codes_remaining <= 2 && <span className="muted"> — generate a fresh set soon</span>}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn-ghost" onClick={() => { setError(''); setStep('regen'); }}>New recovery codes</button>
            <button className="btn-ghost" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => { setError(''); setStep('disable'); }}>Turn off…</button>
          </div>
        </div>
      ) : (
        <button onClick={() => { setError(''); setStep('password'); }}>Set up two-factor authentication</button>
      )}
    </div>
  );
}

export default function Account() {
  const me = useMe();
  const { toasts, toast } = useToast();
  return (
    <div>
      <p className="muted" style={{ marginBottom: 16 }}>Signed in as <strong style={{ color: 'var(--text)' }}>{me.data?.username}</strong></p>
      <PasswordCard toast={toast} />
      <TwoFactorCard toast={toast} />
      <Toast toasts={toasts} />
    </div>
  );
}
