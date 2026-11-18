import { Link } from 'react-router-dom';
import { useRouting } from '../hooks/useApi';

// A stable colour per carrier so the same network is the same colour everywhere on the page
const PALETTE = ['#7b61ff', '#22c55e', '#f59e0b', '#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#2dd4bf', '#c084fc', '#facc15', '#60a5fa', '#f87171'];
const colour = (asn) => PALETTE[Math.abs(asn) % PALETTE.length];

function kind(c) {
  if (c.direct_targets === c.targets) return { label: 'Direct peer', cls: 'direct' };
  if (c.direct_targets === 0) return { label: 'Transit', cls: 'transit' };
  return { label: 'Mixed', cls: 'mixed' };
}

export default function Routing() {
  const q = useRouting();
  if (q.isLoading) return <div className="spinner" />;
  if (q.isError) return <div className="error-state">Failed to load routing data.</div>;
  const r = q.data;
  if (!r.carriers.length) return <div className="empty-note">No traceroutes have been recorded yet — routing data appears once the probe worker has traced your targets.</div>;

  const external = r.traced - r.domestic;
  const top = r.carriers[0];
  const direct = r.carriers.reduce((n, c) => n + c.direct_targets, 0);
  const topShare = Math.round(top.share * 100);
  const regionsDependingOnTop = r.regions.filter((g) => g.carriers[0]?.asn === top.asn && g.carriers[0].count / g.targets >= 0.8).length;

  return (
    <div>
      <div className="group-toolbar">
        <div className="group-header">
          <div className="group-title">Routing</div>
          <div className="group-sub">
            How traffic leaves {r.own_name || 'your network'}{r.own_asn ? ` (AS${r.own_asn})` : ''} — from the latest traceroute to {r.traced} public targets. The first network after yours is the carrier, or peer, the traffic is handed to.
          </div>
        </div>
      </div>

      <div className="overview-stats">
        <div className="stat-pill"><span className="stat-pill-label">Traced</span><span className="stat-pill-value">{r.traced}</span></div>
        <div className="stat-pill"><span className="stat-pill-label">Next-hop networks</span><span className="stat-pill-value">{r.carriers.length}</span></div>
        <div className="stat-pill"><span className="stat-pill-label">Largest share</span><span className="stat-pill-value" style={{ color: topShare >= 40 ? 'var(--warning)' : 'inherit' }}>{topShare}%</span></div>
        <div className="stat-pill"><span className="stat-pill-label">Direct peering</span><span className="stat-pill-value online">{external ? Math.round((direct / external) * 100) : 0}%</span></div>
        <div className="stat-pill"><span className="stat-pill-label">Stay in-network</span><span className="stat-pill-value">{r.domestic}</span></div>
      </div>

      {topShare >= 35 && (
        <div className="banner" style={{ border: '1px solid rgba(245,158,11,0.35)', background: 'rgba(245,158,11,0.08)', color: 'var(--warning)' }}>
          <strong>{topShare}% of paths leave via {top.name || `AS${top.asn}`}.</strong> {regionsDependingOnTop > 0 && `${regionsDependingOnTop} region${regionsDependingOnTop > 1 ? 's' : ''} depend on it almost entirely. `}
          An outage or congestion there would affect that share of destinations at once.
        </div>
      )}

      <section className="panel">
        <h2 className="panel-title">Carriers and peers</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="list-table route-table">
            <thead><tr><th>Network</th><th>Type</th><th style={{ minWidth: 180 }}>Share of paths</th><th>Targets</th><th>Avg latency</th><th>Used for</th></tr></thead>
            <tbody>
              {r.carriers.map((c) => {
                const k = kind(c);
                return (
                  <tr key={c.asn}>
                    <td style={{ whiteSpace: 'nowrap' }}><span className="aschip" style={{ borderColor: colour(c.asn), color: colour(c.asn) }}>AS{c.asn}</span> {c.name || ''}{c.cc ? <span className="muted"> · {c.cc}</span> : null}</td>
                    <td><span className={`route-kind ${k.cls}`}>{k.label}</span></td>
                    <td>
                      <div className="share-bar"><i style={{ width: `${Math.max(2, c.share * 100)}%`, background: colour(c.asn) }} /><span>{(c.share * 100).toFixed(0)}%</span></div>
                    </td>
                    <td>{c.targets}</td>
                    <td className="muted">{c.avg_latency_ms != null ? `${c.avg_latency_ms.toFixed(0)} ms` : '—'}</td>
                    <td className="used-for muted" title={c.groups.map((g) => `${g.name} (${g.count})`).join(', ')}>{c.groups.slice(0, 3).map((g) => `${g.name} (${g.count})`).join(', ')}{c.groups.length > 3 ? ` +${c.groups.length - 3}` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-title">By region</h2>
        {r.unattributed > 0 && <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{r.unattributed} path{r.unattributed > 1 ? 's' : ''} didn't pass through {r.own_name || `AS${r.own_asn}`} and {r.unattributed > 1 ? 'are' : 'is'} left out. If your own routers don't answer traceroute, set your AS number in the admin (Settings → Data).</div>}
        {r.regions.map((g) => (
          <div key={g.group} className="region-row">
            <div className="region-name">{g.group}<small>{g.targets} target{g.targets !== 1 ? 's' : ''}</small></div>
            <div className="region-bar">
              {g.carriers.map((c) => <i key={c.asn} title={`${c.name || `AS${c.asn}`}: ${c.count}`} style={{ flex: c.count, background: colour(c.asn) }} />)}
            </div>
            <div className="region-legend" title={g.carriers.map((c) => `${c.name || `AS${c.asn}`} ${c.count}`).join(', ')}>
              {g.carriers.slice(0, 2).map((c) => <span key={c.asn}><b style={{ background: colour(c.asn) }} />{c.name || `AS${c.asn}`} {c.count}</span>)}
              {g.carriers.length > 2 && <span className="muted">+{g.carriers.length - 2} more</span>}
            </div>
          </div>
        ))}
        <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>Each bar shows how a region's targets are split across carriers. A single colour means the whole region rides one network. See a target's page for its full path.</div>
      </section>
      <p className="muted" style={{ fontSize: 12 }}><Link to="/">← Overview</Link></p>
    </div>
  );
}
