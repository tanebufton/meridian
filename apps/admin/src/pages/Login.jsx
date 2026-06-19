import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

function getCsrf() {
  const m = document.cookie.match(/csrf_token=([^;]+)/);
  return m ? m[1] : '';
}

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [lockout, setLockout] = useState(null); // seconds remaining
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Countdown effect
  useState(() => {
    if (lockout === null) return;
    if (lockout <= 0) { setLockout(null); return; }
    const t = setTimeout(() => setLockout((l) => l - 1), 1000);
    return () => clearTimeout(t);
  }, [lockout]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (loading || lockout) return;
    setLoading(true);
    setError('');

    try {
      // Fetch CSRF cookie first if not present
      const csrf = getCsrf() || (await fetch('/health').then(() => getCsrf()));

      const res = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ username, password }),
        credentials: 'same-origin',
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        setLockout(data.retryAfter || 60);
        setError(`Too many attempts. Please wait ${data.retryAfter || 60}s.`);
        return;
      }
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-title">Meridian</div>
        <div className="login-sub">Admin Panel — sign in to continue</div>

        {error && <div className="error-msg">{error}{lockout ? ` (${lockout}s)` : ''}</div>}

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Username</label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading || !!lockout}
              required
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading || !!lockout}
              required
            />
          </div>
          <button type="submit" style={{ width: '100%' }} disabled={loading || !!lockout}>
            {loading ? 'Signing in…' : lockout ? `Wait ${lockout}s` : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
