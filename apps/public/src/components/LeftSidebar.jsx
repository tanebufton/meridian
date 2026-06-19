import { useMemo, useState, useEffect } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useGroups } from '../hooks/useApi';

function StatusDot({ status }) {
  const cls = { UP: 'dot-up', DEGRADED: 'dot-degraded', DOWN: 'dot-down', UNKNOWN: 'dot-unknown' };
  return <span className={`status-dot ${cls[status] || 'dot-unknown'}`} />;
}

function worstGroupStatus(targets) {
  if (targets.some((t) => t.status === 'DOWN')) return 'DOWN';
  if (targets.some((t) => t.status === 'DEGRADED')) return 'DEGRADED';
  if (targets.some((t) => t.status === 'UP')) return 'UP';
  return 'UNKNOWN';
}

function useLastUpdated(dataUpdatedAt) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!dataUpdatedAt) return null;
  const secs = Math.floor((Date.now() - dataUpdatedAt) / 1000);
  if (secs < 10) return 'Just updated';
  if (secs < 60) return `Updated ${secs}s ago`;
  return `Updated ${Math.floor(secs / 60)}m ago`;
}

export default function LeftSidebar() {
  const groups = useGroups();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const lastUpdated = useLastUpdated(groups.dataUpdatedAt);

  const activeGroupId = useMemo(() => {
    if (location.pathname.startsWith('/group/')) {
      return parseInt(location.pathname.split('/')[2], 10);
    }
    if (location.pathname.startsWith('/target/') && groups.data) {
      const tid = parseInt(location.pathname.split('/')[2], 10);
      const group = groups.data.find((g) => g.targets.some((t) => t.id === tid));
      return group?.id ?? null;
    }
    return null;
  }, [location.pathname, groups.data]);

  const query = search.trim().toLowerCase();

  // When searching: flat list of matching targets across all groups
  const searchResults = useMemo(() => {
    if (!query || !groups.data) return null;
    const hits = [];
    for (const g of groups.data) {
      for (const t of g.targets) {
        if (t.name.toLowerCase().includes(query) || t.host.toLowerCase().includes(query)) {
          hits.push({ ...t, groupName: g.name });
        }
      }
    }
    return hits;
  }, [query, groups.data]);

  return (
    <aside className="left-sidebar">
      <div className="sidebar-header">
        <Link to="/" className="sidebar-logo">Meridian</Link>
        <div className="sidebar-tagline">Network Monitor</div>
      </div>

      {/* Search box */}
      <div className="sidebar-search-wrap">
        <input
          className="sidebar-search"
          type="search"
          placeholder="Search targets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
        />
      </div>

      {groups.isLoading && (
        <div style={{ padding: '14px', fontSize: 11, color: 'var(--text-muted)' }}>Loading…</div>
      )}

      {/* Search results mode */}
      {searchResults && (
        <div className="sidebar-targets">
          {searchResults.length === 0 ? (
            <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-dim)' }}>No matches</div>
          ) : (
            searchResults.map((t) => (
              <NavLink
                key={t.id}
                to={`/target/${t.id}`}
                className={({ isActive }) => `sidebar-target-link ${isActive ? 'active' : ''}`}
                onClick={() => setSearch('')}
              >
                <StatusDot status={t.status} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0, marginLeft: 4 }}>{t.groupName}</span>
              </NavLink>
            ))
          )}
        </div>
      )}

      {/* Normal group/target navigation — skip groups with no enabled targets */}
      {!searchResults && groups.data?.filter((g) => g.targets.length > 0).map((group) => {
        const isGroupActive = location.pathname === `/group/${group.id}`;
        const isOpen = group.id === activeGroupId;
        const ws = worstGroupStatus(group.targets);

        return (
          <div key={group.id} className="sidebar-section">
            <div className={`sidebar-group-row ${isGroupActive ? 'active' : ''}`}>
              <StatusDot status={ws} />
              <NavLink
                to={`/group/${group.id}`}
                className={({ isActive }) => `sidebar-group-link ${isActive ? 'active-route' : ''}`}
              >
                {group.name}
              </NavLink>
              <span className="sidebar-group-count">{group.targets.length}</span>
              <span className={`sidebar-chevron ${isOpen ? 'open' : ''}`}>▶</span>
            </div>

            {isOpen && (
              <div className="sidebar-targets">
                {group.targets.map((t) => (
                  <NavLink
                    key={t.id}
                    to={`/target/${t.id}`}
                    className={({ isActive }) => `sidebar-target-link ${isActive ? 'active' : ''}`}
                  >
                    <StatusDot status={t.status} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.name}
                    </span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Auto-refresh indicator */}
      {lastUpdated && (
        <div className="sidebar-updated">{lastUpdated}</div>
      )}
    </aside>
  );
}
