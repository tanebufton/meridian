import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

function getCsrf() {
  const m = document.cookie.match(/csrf_token=([^;]+)/);
  return m ? m[1] : '';
}

async function post(url, body) {
  // The CSRF cookie is issued on any request; make sure we have one before posting
  const csrf = getCsrf() || (await fetch('/health').then(() => getCsrf()));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState(null); // set after the password step when 2FA is on
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [lockout, setLockout] = useState(null); // seconds remaining
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Lockout countdown (this used to be a useState call, so it never actually ticked)
  useEffect(() => {
    if (lockout === null) return undefined;
    if (lockout <= 0) { setLockout(null); setError(''); return undefined; }
    const t = setTimeout(() => setLockout((l) => l - 1), 1000);
    return () => clearTimeout(t);
  }, [lockout]);

  function done() {
    qc.invalidateQueries({ queryKey: ['me'] });
    navigate('/');
  }

  async function handle(url, body, onOk) {
    if (loading || lockout) return;
    setLoading(true);
    setError('');
    try {
      const { res, data } = await post(url, body);
      if (res.status === 429) {
        setLockout(data.retryAfter || 60);
        setError('Too many failed attempts.');
        return;
      }
      if (!res.ok) { setError(data.error || 'Sign in failed'); return; }
      onOk(data);
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  const submitPassword = (e) => {
    e.preventDefault();
    handle('/api/admin/auth/login', { username, password }, (data) => {
      if (data.requires_2fa) { setChallenge(data.challenge); setPassword(''); } else done();
    });
  };

  const submitCode = (e) => {
    e.preventDefault();
    handle('/api/admin/auth/login/2fa', { challenge, code }, (data) => {
      if (data.recovery_codes_remaining != null) {
        sessionStorage.setItem('meridian_recovery_left', String(data.recovery_codes_remaining));
      }
      done();
    }).then(() => setCode(''));
  };

  // A rejected code can mean the challenge timed out — offer a way back
  const restart = () => { setChallenge(null); setCode(''); setError(''); setUseRecovery(false); };

  return (
    <div className="login-wrap">
      <div className="login-box" style={{ padding: 16 }}>
        <div className="login-title">Meridian</div>
        <div className="login-sub">
          {challenge ? 'Two-step verification' : 'Admin Panel — sign in to continue'}
        </div>

        {error && (
          <div className="error-msg" role="alert">
            {error}{lockout ? ` Try again in ${lockout}s.` : ''}
          </div>
        )}

        {!challenge ? (
          <form onSubmit={submitPassword}>
            <div className="field">
              <label htmlFor="u">Username</label>
              <input id="u" type="text" autoComplete="username" autoFocus value={username}
                onChange={(e) => setUsername(e.target.value)} disabled={loading || !!lockout} required />
            </div>
            <div className="field">
              <label htmlFor="p">Password</label>
              <input id="p" type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} disabled={loading || !!lockout} required />
            </div>
            <button type="submit" style={{ width: '100%' }} disabled={loading || !!lockout}>
              {loading ? 'Signing in…' : lockout ? `Wait ${lockout}s` : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <div className="field">
              <label htmlFor="c">{useRecovery ? 'Recovery code' : 'Code from your authenticator app'}</label>
              <input
                id="c"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                autoComplete="one-time-code"
                inputMode={useRecovery ? 'text' : 'numeric'}
                placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
                maxLength={useRecovery ? 11 : 7}
                style={{ fontFamily: 'monospace', fontSize: 18, letterSpacing: '0.15em', textAlign: 'center' }}
                disabled={loading || !!lockout}
                required
              />
            </div>
            <button type="submit" style={{ width: '100%' }} disabled={loading || !!lockout || !code.trim()}>
              {loading ? 'Verifying…' : lockout ? `Wait ${lockout}s` : 'Verify'}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: 12 }}>
              <button type="button" className="btn-link" onClick={() => { setUseRecovery((v) => !v); setCode(''); setError(''); }}>
                {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
              </button>
              <button type="button" className="btn-link" onClick={restart}>Start over</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
