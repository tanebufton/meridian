import { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useOpenIncidentCount, apiFetch } from '../hooks/useApi';

const LINKS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/incidents', label: 'Incidents', badge: true },
  { to: '/targets', label: 'Targets' },
  { to: '/groups', label: 'Groups' },
  { to: '/maintenance', label: 'Maintenance' },
  { to: '/settings', label: 'Settings' },
];

export default function Sidebar({ username }) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const open = useOpenIncidentCount();
  const [menuOpen, setMenuOpen] = useState(false);

  async function logout() {
    try { await apiFetch('/api/admin/auth/logout', { method: 'POST', body: {} }); } catch { /* already signed out */ }
    qc.clear();
    navigate('/login');
  }

  // Close the mobile menu after navigating
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) { setLastPath(location.pathname); setMenuOpen(false); }

  return (
    <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
      <div className="sidebar-logo">
        <div>
          Meridian
          <span>Admin Panel</span>
        </div>
        <button className="menu-toggle btn-ghost btn-sm" aria-label="Toggle menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
          {menuOpen ? '✕' : '☰'}
        </button>
      </div>
      <nav className="sidebar-nav">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            {l.label}
            {l.badge && open.data > 0 && <span className="nav-badge" title="Unacknowledged incidents">{open.data}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          Signed in as <strong style={{ color: 'var(--text)' }}>{username}</strong>
        </div>
        <button className="btn-ghost btn-sm" style={{ width: '100%' }} onClick={logout}>Sign out</button>
      </div>
    </aside>
  );
}
