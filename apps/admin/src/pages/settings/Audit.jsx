import { useAudit } from '../../hooks/useApi';

const LABELS = {
  login: 'Signed in', login_failed: 'Failed sign-in', login_2fa_failed: 'Failed 2FA code', logout: 'Signed out',
  password_changed: 'Changed own password', password_change_failed: 'Wrong current password',
  '2fa_enabled': 'Turned on 2FA', '2fa_disabled': 'Turned off 2FA', '2fa_recovery_codes_regenerated': 'New recovery codes',
  recovery_code_used: 'Used a recovery code', user_created: 'Created user', user_deleted: 'Deleted user',
  user_password_reset: 'Reset a user\'s password', user_2fa_reset: 'Reset a user\'s 2FA',
};
const BAD = new Set(['login_failed', 'login_2fa_failed', 'password_change_failed']);

export default function Audit() {
  const audit = useAudit(200);
  if (audit.isLoading) return <div className="spinner" />;
  return (
    <div className="card">
      <h2 className="card-title">Audit log</h2>
      <p className="muted help" style={{ marginBottom: 12 }}>Who did what, and from where. Request contents (passwords, webhook URLs) are never recorded. Kept for a year.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>
            {audit.data?.map((e) => (
              <tr key={e.id}>
                <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(e.at * 1000).toLocaleString()}</td>
                <td>{e.username || <span className="muted">—</span>}</td>
                <td style={{ color: BAD.has(e.action) ? 'var(--danger)' : undefined }}>{LABELS[e.action] || <code className="mono" style={{ fontSize: 12 }}>{e.action}</code>}</td>
                <td className="mono muted ellipsis" style={{ fontSize: 11, maxWidth: 260 }}>{e.detail || ''}</td>
                <td className="mono muted" style={{ fontSize: 11 }}>{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
