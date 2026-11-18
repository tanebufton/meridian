'use strict';

const { getDb } = require('../../db/db');
const { PUBLIC_TARGET_SQL } = require('../../shared/visibility');
const { loadSettings } = require('../../shared/settings');

const short = (n) => (n || '').replace(/^.* - /, '').replace(/,\s*[A-Z]{2}$/, '').trim() || null;

/**
 * GET /api/v1/routing — how traffic leaves the network, derived from the latest traceroute of every
 * public target. The first AS after our own is the carrier (or direct peer) the traffic is handed to.
 * Answers "which carriers do we actually use, how concentrated are we, and which regions depend on
 * which carrier" — the questions you need answered before a carrier outage or a contract renewal.
 */
module.exports = async function routingRoutes(app) {
  app.get('/api/v1/routing', async () => {
    const db = getDb();
    const rows = db.prepare(
      `SELECT t.id, t.name, g.name AS grp, c.as_path_json, c.complete,
              (SELECT AVG(a.latency_avg) FROM probe_aggregates a
               WHERE a.target_id = t.id AND a.resolution = '1hour' AND a.period_start >= unixepoch() - 86400) AS lat
       FROM traceroute_cache c
       JOIN targets t ON t.id = c.target_id
       JOIN groups g ON g.id = t.group_id
       WHERE t.enabled = 1 AND c.method IS NOT NULL AND ${PUBLIC_TARGET_SQL}`
    ).all();

    const info = new Map(db.prepare('SELECT asn, name, cc FROM asn_info').all().map((r) => [r.asn, r]));
    const nameOf = (a) => short(info.get(a)?.name);

    const paths = rows.map((r) => {
      let path = [];
      try { path = JSON.parse(r.as_path_json || 'null')?.path ?? []; } catch { /* legacy */ }
      return { ...r, path };
    }).filter((r) => r.path.length > 0);

    // Our own AS: the configured one (Settings → Data), otherwise whatever almost every path starts
    // with. Detection is right when your own routers answer traceroute; if they don't (or you sit
    // behind a provider's CGNAT) the first AS seen is your provider, so it can be set explicitly.
    const configured = loadSettings().own_asn || null;
    const first = new Map();
    for (const r of paths) first.set(r.path[0], (first.get(r.path[0]) || 0) + 1);
    const own = configured ?? [...first.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const carriers = new Map();
    const regions = new Map();
    let domestic = 0;
    let unattributed = 0;
    for (const r of paths) {
      const i = r.path.indexOf(own);
      // Our AS isn't on this path. If it was configured, our own routers are simply invisible and the
      // first network seen IS the carrier. If it was detected we can't tell, so don't guess.
      if (i === -1 && !configured) { unattributed++; continue; }
      const next = r.path[i + 1];
      if (next == null) { domestic++; continue; } // the path never leaves our own network
      const dest = r.path[r.path.length - 1];
      const c = carriers.get(next) || { asn: next, targets: 0, direct: 0, lat: [], groups: new Map() };
      c.targets++;
      if (next === dest) c.direct++;   // handed straight to the destination's network: peering
      if (r.lat != null) c.lat.push(r.lat);
      c.groups.set(r.grp, (c.groups.get(r.grp) || 0) + 1);
      carriers.set(next, c);

      const g = regions.get(r.grp) || { group: r.grp, targets: 0, carriers: new Map() };
      g.targets++;
      g.carriers.set(next, (g.carriers.get(next) || 0) + 1);
      regions.set(r.grp, g);
    }

    const external = paths.length - domestic;
    const list = [...carriers.values()].map((c) => ({
      asn: c.asn, name: nameOf(c.asn), cc: info.get(c.asn)?.cc ?? null,
      targets: c.targets, direct_targets: c.direct,
      share: external ? c.targets / external : 0,
      avg_latency_ms: c.lat.length ? c.lat.reduce((a, b) => a + b, 0) / c.lat.length : null,
      groups: [...c.groups.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    })).sort((a, b) => b.targets - a.targets);

    return {
      generated_at: Math.floor(Date.now() / 1000),
      own_asn: own,
      own_asn_source: configured ? 'configured' : 'detected',
      unattributed,
      own_name: own != null ? nameOf(own) : null,
      traced: paths.length,
      domestic,
      carriers: list,
      regions: [...regions.values()].map((g) => ({
        group: g.group, targets: g.targets,
        carriers: [...g.carriers.entries()].map(([asn, count]) => ({ asn, name: nameOf(asn), count })).sort((a, b) => b.count - a.count),
      })),
    };
  });
};
