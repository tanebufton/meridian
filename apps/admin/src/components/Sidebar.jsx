import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

const LINKS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/targets', label: 'Targets' },
  { to: '/groups', label: 'Groups' },
  { to: '/settings', label: 'Settings' },
];

export default function Sidebar({ username }) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function logout() {
    await fetch('/api/admin/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': getCsrf() },
      credentials: 'same-origin',
    });
    qc.clear();
    navigate('/login');
  }

  function getCsrf() {
    const m = document.cookie.match(/csrf_token=([^;]+)/);
    return m ? m[1] : '';
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        Meridian
        <span>Admin Panel</span>
      </div>
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          {l.label}
        </NavLink>
      ))}
      <div className="sidebar-bottom">
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          Signed in as <strong style={{ color: 'var(--text)' }}>{username}</strong>
        </div>
        <button className="btn-ghost btn-sm" style={{ width: '100%' }} onClick={logout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
