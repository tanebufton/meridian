import { useState } from 'react';
import { useUsers, useMe, useMutate } from '../../hooks/useApi';
import Toast from '../../components/Toast';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../components/ConfirmDialog';
import { Link } from 'react-router-dom';

function UserModal({ onSave, onClose }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const mut = useMutate(['admin-users']);
  async function submit(e) {
    e.preventDefault();
    try { await mut.mutateAsync({ url: '/api/admin/users', method: 'POST', body: { username, password } }); onSave(); }
    catch (err) { setError(err.message); }
  }
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">New admin user</div>
        <form onSubmit={submit}>
          {error && <div className="error-msg" role="alert">{error}</div>}
          <div className="field"><label>Username</label><input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
          <div className="field"><label>Password (min 10 characters)</label><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} /></div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Creating…' : 'Create user'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ResetModal({ user, onSave, onClose }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const mut = useMutate(['admin-users']);
  async function submit(e) {
    e.preventDefault();
    try { await mut.mutateAsync({ url: `/api/admin/users/${user.id}/password`, method: 'PUT', body: { password } }); onSave(); }
    catch (err) { setError(err.message); }
  }
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Reset password — {user.username}</div>
        <p className="muted help" style={{ marginBottom: 12 }}>They'll be signed out everywhere and need this new password.</p>
        <form onSubmit={submit}>
          {error && <div className="error-msg" role="alert">{error}</div>}
          <div className="field"><label>New password</label><input type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} /></div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Saving…' : 'Reset password'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Users() {
  const users = useUsers();
  const me = useMe();
  const { toasts, toast } = useToast();
  const ask = useConfirm();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState(null);
  const mut = useMutate(['admin-users']);

  async function remove(u) {
    if (!(await ask({ title: `Delete ${u.username}?`, message: 'They will no longer be able to sign in.', confirmLabel: 'Delete user', danger: true }))) return;
    try { await mut.mutateAsync({ url: `/api/admin/users/${u.id}`, method: 'DELETE' }); toast('User deleted'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function reset2fa(u) {
    if (!(await ask({ title: `Turn off 2FA for ${u.username}?`, message: 'Use this if they lost their device and recovery codes. They\'ll be signed out and can set 2FA up again.', confirmLabel: 'Turn off 2FA', danger: true }))) return;
    try { await mut.mutateAsync({ url: `/api/admin/users/${u.id}/2fa`, method: 'DELETE' }); toast('2FA turned off'); }
    catch (err) { toast(err.message, 'error'); }
  }

  if (users.isLoading) return <div className="spinner" />;
  return (
    <div className="card">
      <div className="card-head">
        <h2 className="card-title" style={{ margin: 0 }}>Admin users</h2>
        <button onClick={() => setAdding(true)}>+ Add user</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Username</th><th>2FA</th><th>Created</th><th>Last login</th><th></th></tr></thead>
          <tbody>
            {users.data?.map((u) => {
              const isMe = u.id === me.data?.userId;
              return (
                <tr key={u.id}>
                  <td>{u.username}{isMe && <span className="badge badge-unknown" style={{ marginLeft: 8 }}>you</span>}</td>
                  <td>{u.totp_enabled ? <span className="badge badge-up">On</span> : <span className="muted" style={{ fontSize: 12 }}>Off</span>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{new Date(u.created_at * 1000).toLocaleDateString()}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{u.last_login ? new Date(u.last_login * 1000).toLocaleString() : 'Never'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {isMe ? <Link to="/settings?tab=account" className="btn-ghost btn-sm btn-as-link">My account</Link> : (<>
                        <button className="btn-ghost btn-sm" onClick={() => setResetting(u)}>Reset password</button>
                        {u.totp_enabled ? <button className="btn-ghost btn-sm" onClick={() => reset2fa(u)}>Reset 2FA</button> : null}
                        <button className="btn-danger btn-sm" onClick={() => remove(u)}>Delete</button>
                      </>)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {adding && <UserModal onSave={() => { setAdding(false); toast('User created'); }} onClose={() => setAdding(false)} />}
      {resetting && <ResetModal user={resetting} onSave={() => { setResetting(null); toast('Password reset'); }} onClose={() => setResetting(null)} />}
      <Toast toasts={toasts} />
    </div>
  );
}
