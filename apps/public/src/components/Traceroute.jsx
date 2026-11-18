import { useMemo, useState } from 'react';
import { useTraceroute, useTracerouteHistory } from '../hooks/useApi';
import { fmtAgo, fmtTs } from '../lib';

// "GOOGLE - Google LLC, US" -> "Google LLC"; "TELSTRA-GLOBAL Telstra Global, HK" -> "Telstra Global"
function shortName(name) {
  if (!name) return null;
  let n = name.includes(' - ') ? name.split(' - ').slice(1).join(' - ') : name;
  n = n.replace(/,\s*[A-Z]{2}$/, '').trim();
  return n.length > 28 ? `${n.slice(0, 27)}…` : n;
}

function asNames(hops) {
  const m = new Map();
  for (const h of hops || []) if (h.asn != null && h.as_name && !m.has(h.asn)) m.set(h.asn, shortName(h.as_name));
  return m;
}

// The route as the chain of networks it crosses
export function AsPath({ path, names, added = [] }) {
  if (!path?.length) return <span className="muted" style={{ fontSize: 12 }}>No network data</span>;
  return (
    <div className="aspath">
      {path.map((a, i) => (
        <span key={`${a}-${i}`} className="aspath-item">
          {i > 0 && <span className="aspath-arrow">→</span>}
          <span className={`aschip${added.includes(a) ? ' added' : ''}`} title={names?.get(a) || ''}>
            AS{a}{names?.get(a) ? <span className="asname"> {names.get(a)}</span> : null}
          </span>
        </span>
      ))}
    </div>
  );
}

const avg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export function HopTable({ hops }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th style={{ width: 32 }}>#</th>
            <th>Address</th>
            <th>Hostname</th>
            <th>Network</th>
            <th>Avg RTT</th>
            <th>Loss</th>
          </tr>
        </thead>
        <tbody>
          {hops.map((h, i) => {
            const probes = h.rtts || [];
            const lost = probes.length ? probes.filter((r) => r == null).length / probes.length : 0;
            const a = avg(probes);
            return (
              <tr key={i}>
                <td style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{h.hop}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  {h.hidden ? <span style={{ color: 'var(--text-muted)' }}>private</span>
                    : h.ip ? <>{h.ip}{h.ecmp && <span className="ecmp" title={`Load balanced — replies came from ${h.ips.join(', ')}`}>×{h.ips.length} paths</span>}</>
                    : <span style={{ color: 'var(--text-muted)' }}>*</span>}
                </td>
                <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.rdns || (h.hidden ? '' : '—')}</td>
                <td style={{ fontSize: 11 }}>
                  {h.asn != null ? <><span className="aschip small">AS{h.asn}</span> <span className="muted">{shortName(h.as_name) || ''}{h.cc ? ` · ${h.cc}` : ''}</span></> : <span className="muted">—</span>}
                </td>
                <td style={{ fontSize: 11, fontFamily: 'monospace' }}>{a != null ? `${a.toFixed(1)}ms` : <span style={{ color: 'var(--text-dim)' }}>*</span>}</td>
                <td style={{ fontSize: 11, fontFamily: 'monospace', color: lost >= 1 ? 'var(--text-dim)' : lost > 0 ? 'var(--warning)' : 'var(--text-muted)' }}>
                  {h.hidden ? '' : lost >= 1 ? '100%' : lost > 0 ? `${Math.round(lost * 100)}%` : '0%'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function History({ targetId, currentRanAt }) {
  const hist = useTracerouteHistory(targetId);
  const [open, setOpen] = useState(null);
  const entries = (hist.data?.history || []);
  if (hist.isLoading || entries.length === 0) return null;
  if (entries.length === 1) {
    return <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>No route change recorded since {fmtTs(entries[0].ran_at)} — this is the route it has used throughout.</div>;
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="tr-sub">Route changes · {entries.length - 1} recorded · current route in place since {fmtTs(entries[0].ran_at)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map((e, i) => {
          const older = entries[i + 1];
          const isBaseline = i === entries.length - 1;
          const added = older ? e.as_path.filter((a) => !older.as_path.includes(a)) : [];
          const removed = older ? older.as_path.filter((a) => !e.as_path.includes(a)) : [];
          const names = asNames(e.hops);
          const olderNames = older ? asNames(older.hops) : new Map();
          const isOpen = open === e.id;
          return (
            <div key={e.id} className="tr-entry">
              <div className="tr-entry-head" onClick={() => setOpen(isOpen ? null : e.id)}>
                <span className="muted" style={{ fontSize: 11 }}>{isOpen ? '▾' : '▸'} {fmtTs(e.ran_at)}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {isBaseline ? 'first recorded path'
                    : added.length || removed.length
                      ? [added.length ? `+${added.map((a) => `AS${a}`).join(', ')}` : '', removed.length ? `−${removed.map((a) => `AS${a}`).join(', ')}` : ''].filter(Boolean).join('  ')
                      : 'reordered'}
                </span>
              </div>
              <div style={{ padding: '4px 10px 8px' }}>
                <AsPath path={e.as_path} names={new Map([...olderNames, ...names])} added={added} />
                {removed.length > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>No longer used: {removed.map((a) => `AS${a}${olderNames.get(a) ? ` ${olderNames.get(a)}` : ''}`).join(', ')}</div>}
              </div>
              {isOpen && <div style={{ padding: '4px 10px 10px', borderTop: '1px solid var(--border)' }}><HopTable hops={e.hops} /></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const METHOD = { icmp: 'ICMP', tcp: 'TCP :443', udp: 'UDP' };

export default function TraceroutePanel({ targetId }) {
  const tr = useTraceroute(targetId);
  const [open, setOpen] = useState(false);
  const ranAt = tr.data?.ran_at;
  const hops = tr.data?.hops;
  const names = useMemo(() => asNames(hops), [hops]);
  const ecmpHops = hops?.filter((h) => h.ecmp).length || 0;

  return (
    <div className="chart-card" style={{ marginTop: 14 }}>
      <div className="tr-head" onClick={() => setOpen((o) => !o)}>
        <span className="tr-sub" style={{ margin: 0 }}>{open ? '▾' : '▸'} Traceroute</span>
        {ranAt && <span className="muted" style={{ fontSize: 11 }}>{tr.data.method ? `${METHOD[tr.data.method] || tr.data.method} · ` : ''}updated {fmtAgo(ranAt)}</span>}
      </div>

      {tr.data?.as_path?.length > 0 && <div style={{ marginTop: 10 }}><AsPath path={tr.data.as_path} names={names} /></div>}

      {open && (
        <div style={{ marginTop: 12 }}>
          {!hops || hops.length === 0 ? (
            <div className="muted" style={{ fontSize: 12, padding: '4px 0' }}>
              {tr.isLoading ? 'Loading…' : ranAt ? 'Traceroute returned no hops — the host may block probes, or will retry shortly.' : 'No traceroute data yet — the probe worker runs this automatically.'}
            </div>
          ) : (<>
            {/* Only warn for traces the current engine recorded as incomplete. Older traces have no completeness
                information at all and used to be shown as "incomplete" by default, which was simply wrong. */}
            {tr.data.method && tr.data.complete === false && <div className="tr-note">The destination itself didn't answer, so this path may stop short of it. That is common — many hosts filter traceroute — and doesn't mean the target is down.</div>}
            {!tr.data.method && <div className="tr-note info">This trace was recorded by the previous traceroute engine and will refresh shortly.</div>}
            {ecmpHops > 0 && <div className="tr-note info">{ecmpHops} hop{ecmpHops > 1 ? 's are' : ' is'} load-balanced across equal-cost paths. Differences between these routers are normal and are not counted as route changes.</div>}
            <HopTable hops={hops} />
          </>)}
          <History targetId={targetId} currentRanAt={ranAt} />
        </div>
      )}
    </div>
  );
}
