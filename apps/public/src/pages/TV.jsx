import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSummary, useGroups, useIncidents, useGroupResults, useTargetResults, useTargetEvents } from '../hooks/useApi';
import LatencyChart from '../components/LatencyChart';
import StatusBadge from '../components/StatusBadge';
import { fmtMs, fmtPct, fmtDuration, fmtAgo, effectiveStatus, worstStatus, latencyColor, lossColor } from '../lib';

/*
 * Wall-board mode:  /tv
 *   ?views=overview,groups,problems,latency,incidents      which scenes, in order (default)
 *   ?views=overview,allgroups                              every group, one scene each
 *   ?views=group:3,target:12                               specific group / target scenes
 *   ?interval=20                                           seconds per scene
 *   ?theme=dark|light   ?zoom=1.25                         display tweaks
 * Keys: ← → change scene · space pause · f fullscreen · ? help
 */

const DEFAULT_VIEWS = 'overview,groups,problems,latency,incidents';
const STALE_AFTER = 180; // seconds without a fresh probe before the board warns

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

// ── Scenes ──────────────────────────────────────────────────────────────────

function Overview({ summary, groups }) {
  const s = summary;
  const allGood = s.offline === 0 && s.degraded === 0;
  const state = s.offline > 0 ? 'bad' : s.degraded > 0 ? 'warn' : 'good';
  const spark = s.sparkline || [];
  // Robust scaling: a bucket with only a few targets reporting can be wildly off, and one needle
  // spike would flatten the whole line. Scale to the 3rd–97th percentile and clamp the rest.
  const spark_ = useMemo(() => {
    const vals = spark.map((p) => p.latency_avg).filter((v) => v != null);
    if (vals.length < 3) return null;
    const sorted = [...vals].sort((x, y) => x - y);
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))];
    // Always show at least ±35% around the median: scaling tightly to the data turns ordinary
    // jitter into dramatic spikes, and a wall display must not cry wolf.
    const med = q(0.5);
    let lo = Math.min(q(0.03), med * 0.65), hi = Math.max(q(0.97), med * 1.35);
    if (hi - lo < 2) { lo -= 1; hi += 1; }
    const y = (v) => 40 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 38 - 1;
    const pts = spark.map((p, i) => `${(i / (spark.length - 1)) * 100},${y(p.latency_avg ?? lo)}`).join(' ');
    return { pts, lo, hi };
  }, [spark]);
  const windows = s.maintenance_windows || [];
  return (
    <div className="tv-overview">
      {s.banner && <div className="tv-banner">{s.banner.text}</div>}
      {windows.map((w) => <div key={w.name + w.ends_at} className="tv-banner maint">Scheduled maintenance: {w.name}{w.scope_name ? ` (${w.scope_name})` : ''} until {new Date(w.ends_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>)}
      <div className={`tv-hero ${state}`}>
        <span className="tv-hero-dot" />
        {allGood ? 'All systems operational' : s.offline > 0 ? `${s.offline} target${s.offline !== 1 ? 's' : ''} unreachable` : `${s.degraded} degraded`}
      </div>
      <div className="tv-stats">
        <Stat label="Targets" value={s.total} />
        <Stat label="Online" value={s.online} cls="good" />
        <Stat label="Degraded" value={s.degraded} cls={s.degraded ? 'warn' : ''} />
        <Stat label="Offline" value={s.offline} cls={s.offline ? 'bad' : ''} />
        {s.maintenance > 0 && <Stat label="Maintenance" value={s.maintenance} cls="maint" />}
      </div>
      {spark_ && (
        <div className="tv-spark">
          <div className="tv-spark-label">Average latency across all targets, last 24 hours <span>axis {Math.max(0, spark_.lo).toFixed(0)}–{spark_.hi.toFixed(0)} ms</span></div>
          <svg viewBox="0 0 100 40" preserveAspectRatio="none">
            <polygon points={`0,40 ${spark_.pts} 100,40`} fill="var(--accent)" fillOpacity="0.15" />
            <polyline points={spark_.pts} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}
      <div className="tv-foot-note">{groups.length} groups monitored</div>
    </div>
  );
}
const Stat = ({ label, value, cls = '' }) => <div className={`tv-stat ${cls}`}><div className="tv-stat-value">{value}</div><div className="tv-stat-label">{label}</div></div>;

function Groups({ groups }) {
  // Size the grid to the screen so every group is visible however many there are: pick the column
  // count that best matches the screen's aspect ratio, and shrink the text as rows increase.
  const n = groups.length;
  const aspect = typeof window !== 'undefined' ? window.innerWidth / Math.max(window.innerHeight - 160, 400) : 1.8;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * aspect / 1.15))));
  const rows = Math.ceil(n / cols);
  const scale = Math.max(0.45, Math.min(1, 4.2 / rows));
  return (
    <div className="tv-tiles fit" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, fontSize: `${scale}em` }}>
      {groups.map((g) => {
        const st = worstStatus(g.targets).toLowerCase();
        const lat = g.targets.map((t) => t.latency_avg).filter((v) => v != null);
        const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
        const up = g.targets.filter((t) => effectiveStatus(t) === 'UP').length;
        return (
          <div key={g.id} className={`tv-tile ${st}`}>
            <div className="tv-tile-name">{g.name}</div>
            <div className="tv-tile-big">{up}<span>/{g.targets.length}</span></div>
            <div className="tv-tile-sub">{avg != null ? `${avg.toFixed(0)} ms avg` : '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

function Problems({ groups }) {
  const rows = groups.flatMap((g) => g.targets.map((t) => ({ ...t, group: g.name })))
    .filter((t) => ['DOWN', 'DEGRADED'].includes(effectiveStatus(t)))
    .sort((a, b) => (effectiveStatus(a) === 'DOWN' ? 0 : 1) - (effectiveStatus(b) === 'DOWN' ? 0 : 1) || a.name.localeCompare(b.name));
  if (rows.length === 0) return <div className="tv-empty good">No problems<small>Every target is healthy</small></div>;
  return (
    <div className="tv-list">
      {rows.slice(0, 12).map((t) => (
        <div key={t.id} className={`tv-row ${effectiveStatus(t).toLowerCase()}`}>
          <StatusBadge status={effectiveStatus(t)} />
          <span className="tv-row-name">{t.name}<small>{t.group}</small></span>
          <span className="tv-row-meta">
            {t.incident_started_at ? `down ${fmtDuration(Math.floor(Date.now() / 1000) - t.incident_started_at)}` : `${fmtPct(t.packet_loss, 0)} loss`}
            {t.incident_acknowledged ? ' · being looked at' : ''}
          </span>
        </div>
      ))}
      {rows.length > 12 && <div className="tv-foot-note">+{rows.length - 12} more</div>}
    </div>
  );
}

function Bars({ title, rows, fmt, color, empty = 'Nothing to show' }) {
  const max = Math.max(...rows.map((r) => r.v), 1);
  return (
    <div className="tv-board">
      <div className="tv-board-title">{title}</div>
      {rows.map((r) => (
        <div key={r.id} className="tv-bar">
          <span className="tv-bar-name">{r.name}</span>
          <span className="tv-bar-track"><i style={{ width: `${Math.max(2, (r.v / max) * 100)}%`, background: color(r.v) }} /></span>
          <span className="tv-bar-val">{fmt(r.v)}</span>
        </div>
      ))}
      {rows.length === 0 && <div className="tv-ok-note">✓ {empty}</div>}
    </div>
  );
}

function Latency({ groups }) {
  const all = groups.flatMap((g) => g.targets).filter((t) => !t.in_maintenance);
  // "Slower than usual": each target against its own 7-day norm. Ranking by raw latency only ever
  // shows which countries are far away, which is never news.
  const slower = all
    .filter((t) => t.latency_avg != null && t.latency_7d != null && t.latency_avg - t.latency_7d >= 5 && t.latency_avg / t.latency_7d >= 1.2)
    .sort((a, b) => b.latency_avg / b.latency_7d - a.latency_avg / a.latency_7d).slice(0, 8)
    .map((t) => ({ id: t.id, name: t.name, v: t.latency_avg - t.latency_7d, ratio: t.latency_avg / t.latency_7d }));
  const lossy = all.filter((t) => t.packet_loss > 0).sort((a, b) => b.packet_loss - a.packet_loss).slice(0, 8).map((t) => ({ id: t.id, name: t.name, v: t.packet_loss }));
  return (
    <div className="tv-two">
      <Bars title="Slower than usual" rows={slower} fmt={(v) => `+${v.toFixed(0)} ms`} color={() => 'var(--warning)'} empty="Everything is within its normal range" />
      <Bars title="Packet loss" rows={lossy} fmt={(v) => `${v.toFixed(1)}%`} color={lossColor} empty="No packet loss anywhere" />
    </div>
  );
}

function Incidents() {
  const q = useIncidents(7);
  const list = (q.data?.incidents || []).slice(0, 10);
  if (q.isLoading) return null;
  if (list.length === 0) return <div className="tv-empty good">No incidents<small>in the last 7 days</small></div>;
  return (
    <div className="tv-list">
      {list.map((i) => (
        <div key={i.id} className={`tv-row ${i.ongoing ? 'down' : 'up'}`}>
          <span className={`incident-dot ${i.ongoing ? 'down' : 'ok'}`} />
          <span className="tv-row-name">{i.target_name}<small>{i.group_name}</small></span>
          <span className="tv-row-meta">{i.ongoing ? `ongoing · ${fmtDuration(i.duration_seconds)}` : `${fmtDuration(i.duration_seconds)} · ${fmtAgo(i.ended_at)}`}</span>
        </div>
      ))}
    </div>
  );
}

function GroupScene({ group }) {
  const series = useGroupResults(group.id, '12h');
  const targets = [...group.targets].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12);
  return (
    <div className="tv-cards">
      {targets.map((t) => (
        <div key={t.id} className={`tv-card ${effectiveStatus(t).toLowerCase()}`}>
          <div className="tv-card-head"><b>{t.name}</b><span style={{ color: latencyColor(t.latency_avg) }}>{fmtMs(t.latency_avg, 0)}</span></div>
          <LatencyChart data={series.data?.targets?.[t.id]} probeType={t.probe_type} range="12h" mini height={110} />
        </div>
      ))}
    </div>
  );
}

function TargetScene({ target }) {
  const res = useTargetResults(target.id, '24h');
  const events = useTargetEvents(target.id, '24h');
  return (
    <div className="tv-target">
      <div className="tv-target-stats">
        <Stat label="Average" value={fmtMs(target.latency_avg, 1)} />
        <Stat label="Min" value={fmtMs(target.latency_min, 1)} />
        <Stat label="Max" value={fmtMs(target.latency_max, 1)} />
        <Stat label="Loss" value={fmtPct(target.packet_loss, 1)} cls={target.packet_loss > 0 ? 'warn' : ''} />
        <Stat label="Uptime 24h" value={target.uptime_24h == null ? '—' : `${target.uptime_24h.toFixed(2)}%`} />
      </div>
      <div className="tv-target-chart"><LatencyChart data={res.data?.data} probeType={target.probe_type} range="24h" events={events.data} scaleMode="fit" height={Math.max(260, Math.round(window.innerHeight * 0.5))} /></div>
    </div>
  );
}

// ── Playlist ────────────────────────────────────────────────────────────────

function buildScenes(spec, groups) {
  const out = [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const targets = new Map(groups.flatMap((g) => g.targets.map((t) => [t.id, { ...t, groupName: g.name }])));
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [kind, arg] = raw.split(':');
    if (['overview', 'groups', 'problems', 'latency', 'incidents'].includes(kind)) out.push({ kind, title: { overview: 'Overview', groups: 'Groups', problems: 'Problems', latency: 'Performance', incidents: 'Incidents' }[kind] });
    else if (kind === 'allgroups') for (const g of groups) out.push({ kind: 'group', group: g, title: g.name });
    else if (kind === 'group' && byId.get(+arg)) out.push({ kind: 'group', group: byId.get(+arg), title: byId.get(+arg).name });
    else if (kind === 'target' && targets.get(+arg)) out.push({ kind: 'target', target: targets.get(+arg), title: `${targets.get(+arg).name} · ${targets.get(+arg).groupName}` });
  }
  return out;
}

export default function TV() {
  const [params] = useSearchParams();
  const interval = Math.min(Math.max(parseInt(params.get('interval'), 10) || 20, 5), 600);
  const spec = params.get('views') || DEFAULT_VIEWS;
  const zoom = Math.min(Math.max(parseFloat(params.get('zoom')) || 1, 0.5), 2.5);

  const qc = useQueryClient();
  const summary = useSummary();
  const groupsQ = useGroups();
  const groups = useMemo(() => groupsQ.data?.filter((g) => g.targets.length > 0) || [], [groupsQ.data]);
  const now = useNow();

  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [help, setHelp] = useState(false);
  const [chrome, setChrome] = useState(true);
  const started = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Theme from the URL for this session only (a wall display shouldn't inherit someone's toggle)
  useEffect(() => {
    const t = params.get('theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  }, [params]);

  // Auto-refresh faster than the normal pages, and pick up new deployments by reloading every 6 h
  useEffect(() => {
    const t = setInterval(() => qc.invalidateQueries(), 30_000);
    const r = setTimeout(() => window.location.reload(), 6 * 3600_000);
    return () => { clearInterval(t); clearTimeout(r); };
  }, [qc]);

  // Keep the screen awake where the browser allows it
  useEffect(() => {
    let lock;
    (async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { /* not available */ } })();
    return () => { lock?.release?.().catch(() => {}); };
  }, []);

  const hasProblems = groups.some((g) => g.targets.some((t) => ['DOWN', 'DEGRADED'].includes(effectiveStatus(t))));
  const incidentsQ = useIncidents(7);
  const scenes = useMemo(() => buildScenes(spec, groups).filter((s) => (s.kind === 'problems' ? hasProblems : s.kind === 'incidents' ? (incidentsQ.data?.incidents?.length ?? 0) > 0 : true)), [spec, groups, hasProblems, incidentsQ.data]);
  const scene = scenes.length ? scenes[idx % scenes.length] : null;

  const go = (d) => { setIdx((i) => (i + d + scenes.length) % Math.max(scenes.length, 1)); started.current = Date.now(); setElapsed(0); };

  // Advance on a timer
  useEffect(() => {
    if (paused || scenes.length < 2) return undefined;
    const t = setInterval(() => {
      const e = (Date.now() - started.current) / 1000;
      setElapsed(e);
      if (e >= interval) { setIdx((i) => (i + 1) % scenes.length); started.current = Date.now(); setElapsed(0); }
    }, 250);
    return () => clearInterval(t);
  }, [paused, interval, scenes.length]);

  // Keyboard + idle cursor
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p); }
      else if (e.key === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
      else if (e.key === '?') setHelp((h) => !h);
      else if (e.key === 'Escape') setHelp(false);
    };
    let idle;
    const wake = () => { setChrome(true); clearTimeout(idle); idle = setTimeout(() => setChrome(false), 4000); };
    window.addEventListener('keydown', onKey); window.addEventListener('mousemove', wake); wake();
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousemove', wake); clearTimeout(idle); };
  });

  const newest = groups.flatMap((g) => g.targets).reduce((m, t) => Math.max(m, t.last_checked || 0), 0);
  const staleFor = newest ? Math.floor(now / 1000) - newest : null;
  const stale = staleFor != null && staleFor > STALE_AFTER;
  const failed = groupsQ.isError || summary.isError;

  return (
    <div className={`tv${chrome ? '' : ' idle'}`} style={{ '--tv-zoom': zoom }}>
      {(stale || failed) && (
        <div className="tv-stale" role="alert">
          {failed ? 'Cannot reach the Meridian server — showing the last data received' : `Data may be out of date — the last probe was ${fmtDuration(staleFor)} ago`}
        </div>
      )}
      <header className="tv-top">
        <span className="tv-logo">Meridian</span>
        <span className="tv-title">{scene?.title}</span>
        <span className="tv-clock">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </header>

      <main className="tv-main">
        {(summary.isLoading || groupsQ.isLoading) && <div className="spinner" />}
        {scene?.kind === 'overview' && summary.data && <Overview summary={summary.data} groups={groups} />}
        {scene?.kind === 'groups' && <Groups groups={groups} />}
        {scene?.kind === 'problems' && <Problems groups={groups} />}
        {scene?.kind === 'latency' && <Latency groups={groups} />}
        {scene?.kind === 'incidents' && <Incidents />}
        {scene?.kind === 'group' && <GroupScene group={scene.group} />}
        {scene?.kind === 'target' && <TargetScene target={scene.target} />}
        {!scene && !summary.isLoading && !groupsQ.isLoading && <div className="tv-empty">Nothing to show<small>Check the views= list in the URL</small></div>}
      </main>

      <footer className="tv-bottom">
        <div className="tv-dots">{scenes.map((s, i) => <i key={i} className={i === idx % scenes.length ? 'on' : ''} />)}</div>
        <div className="tv-progress"><i style={{ width: paused ? '100%' : `${Math.min(100, (elapsed / interval) * 100)}%`, opacity: paused ? 0.3 : 1 }} /></div>
        <span className="tv-hint">{paused ? 'Paused' : ''} <Link to="/" className="tv-exit">Exit</Link> · press ? for keys</span>
      </footer>

      {help && (
        <div className="tv-help" onClick={() => setHelp(false)}>
          <div className="tv-help-box">
            <h2>Wall-board mode</h2>
            <p><kbd>←</kbd> <kbd>→</kbd> change scene &nbsp; <kbd>Space</kbd> pause &nbsp; <kbd>F</kbd> fullscreen &nbsp; <kbd>?</kbd> this help</p>
            <p>Customise with the address:</p>
            <code>/tv?views=overview,groups,group:3,target:12&amp;interval=30&amp;theme=dark&amp;zoom=1.25</code>
            <p className="muted">Scenes: overview · groups · problems · latency · incidents · allgroups · group:ID · target:ID. Problems and incidents are skipped when there is nothing to show.</p>
          </div>
        </div>
      )}
    </div>
  );
}
