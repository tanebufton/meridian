#!/usr/bin/env node
'use strict';

/**
 * Re-evaluate the stored route-change history with the AS-path rules, dropping the entries that
 * were only load-balancing / silent-router noise, and annotating the survivors with AS numbers.
 *
 *   node scripts/compact-traceroute-history.js --dry-run   # report only
 *   node scripts/compact-traceroute-history.js             # apply (snapshots the database first)
 *
 * Needs the database to be migrated (npm run migrate) and outbound DNS for the ASN lookups.
 */

const fs = require('fs');
require('dotenv').config({ quiet: true });
const { getDb, closeDb, dbPath } = require('../server/db/db');
const { lookupAsns } = require('../server/probe/asn');
const { asPath, routeChanged } = require('../server/probe/route');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  const db = getDb();
  const rows = db.prepare('SELECT id, target_id, result_json, ran_at FROM traceroute_history ORDER BY target_id, ran_at, id').all();
  console.log(`${rows.length} history rows across ${new Set(rows.map((r) => r.target_id)).size} targets`);

  const snaps = rows.map((r) => ({ ...r, hops: JSON.parse(r.result_json) }));
  const ips = new Set();
  for (const s of snaps) for (const h of s.hops) {
    if (h.hidden) continue;
    for (const ip of (h.ips && h.ips.length ? h.ips : h.ip ? [h.ip] : [])) ips.add(ip);
  }
  console.log(`Resolving origin AS for ${ips.size} distinct hop addresses (cached by /24)...`);
  const list = [...ips];
  const asns = new Map();
  for (let i = 0; i < list.length; i += 400) {
    const m = await lookupAsns(db, list.slice(i, i + 400));
    for (const [k, v] of m) asns.set(k, v);
    process.stdout.write(`  ${Math.min(i + 400, list.length)}/${list.length}\r`);
  }
  console.log(`\nResolved ${asns.size}/${ips.size} addresses`);

  const keep = new Set();
  const annotated = new Map();
  let last = null, lastTarget = null;
  for (const s of snaps) {
    const hops = s.hops.map((h) => {
      const a = h.ip ? asns.get(h.ip) : null;
      return { ...h, ips: h.ips || (h.ip ? [h.ip] : []), asn: a ? a.asn : null, as_name: a ? a.name : null, cc: a ? a.cc : null };
    });
    const cur = { path: asPath(hops), complete: false, hops };
    if (s.target_id !== lastTarget) { last = null; lastTarget = s.target_id; }
    if (!last || routeChanged(last, cur)) { keep.add(s.id); annotated.set(s.id, cur); last = cur; }
  }

  const drop = rows.filter((r) => !keep.has(r.id));
  const perTarget = {};
  for (const r of rows) if (keep.has(r.id)) perTarget[r.target_id] = (perTarget[r.target_id] || 0) + 1;
  const counts = Object.values(perTarget).sort((a, b) => b - a);
  console.log(`Keep ${keep.size}, drop ${drop.length} (${((100 * drop.length) / rows.length).toFixed(0)}% of history was noise)`);
  console.log(`Per target after: worst ${counts[0] ?? 0}, median ${counts[Math.floor(counts.length / 2)] ?? 0}`);

  if (dryRun) { console.log('Dry run — nothing changed.'); closeDb(); return; }

  const backup = `${dbPath}.pre-compact-${Date.now()}`;
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  fs.chmodSync(backup, 0o600);
  console.log(`Backup written: ${backup}`);

  const del = db.prepare('DELETE FROM traceroute_history WHERE id = ?');
  const upd = db.prepare('UPDATE traceroute_history SET result_json = ?, as_path_json = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of drop) del.run(r.id);
    for (const [id, cur] of annotated) upd.run(JSON.stringify(cur.hops), JSON.stringify({ path: cur.path, complete: false, method: null }), id);
  })();
  console.log('Done.');
  closeDb();
})().catch((e) => { console.error(e); process.exit(1); });
