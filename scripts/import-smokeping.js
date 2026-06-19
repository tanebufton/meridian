#!/usr/bin/env node
'use strict';

/**
 * Import SmokePing targets into Meridian.
 *
 * Usage:
 *   # From a local file
 *   node scripts/import-smokeping.js /path/to/Targets
 *
 *   # From a remote SSH server (uses your existing SSH key/agent)
 *   node scripts/import-smokeping.js user@host:/etc/smokeping/config.d/Targets
 *
 *   # Dry run — preview without writing anything
 *   node scripts/import-smokeping.js --dry-run user@host:/etc/smokeping/Targets
 *
 * The script handles the standard SmokePing Targets format:
 *   + GroupName        → creates a Group
 *   ++ TargetName      → creates a Target inside that group
 *   host = x.x.x.x    → target host
 *   menu = Label       → display name (falls back to the identifier)
 *   probe = DNS        → probe type (DNS → dns, anything else → icmp)
 *
 * Nested groups (+++) are flattened into their parent group.
 * Targets without a `host` line are skipped.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getDb, closeDb } = require('../server/db/db');

// ── Config reader ──────────────────────────────────────────────────────────

function readSource(source) {
  // SSH form: user@host:/remote/path
  if (source.includes('@') && source.includes(':')) {
    const colonIdx = source.indexOf(':');
    const userHost = source.slice(0, colonIdx);
    const remotePath = source.slice(colonIdx + 1);
    console.log(`Connecting to ${userHost} to read ${remotePath}...`);
    try {
      return execSync(`ssh -o BatchMode=yes "${userHost}" "cat '${remotePath}'"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(`SSH failed: ${err.stderr || err.message}`);
    }
  }

  if (!fs.existsSync(source)) throw new Error(`File not found: ${source}`);
  return fs.readFileSync(source, 'utf8');
}

// ── SmokePing Targets parser ───────────────────────────────────────────────

function mapProbeType(probe) {
  if (!probe) return 'icmp';
  return probe.toLowerCase().startsWith('dns') ? 'dns' : 'icmp';
}

function parseTargets(content) {
  const lines = content.split('\n');

  // Find the *** Targets *** section — handle configs that start with Targets directly
  let startLine = 0;
  const targetsIdx = lines.findIndex((l) => /\*\*\*\s*Targets\s*\*\*\*/i.test(l));
  if (targetsIdx !== -1) startLine = targetsIdx + 1;

  const groups = [];
  let currentGroup = null;
  let currentTarget = null;
  let defaultProbe = 'FPing';

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();

    // Stop at next *** section
    if (i > startLine && /^\*\*\*/.test(line)) break;

    // Skip blanks and comments
    if (!line || line.startsWith('#')) continue;

    // ++ (or deeper) — target
    if (/^\+{2,}/.test(line)) {
      const depth = line.match(/^(\++)/)[1].length;
      const key = line.replace(/^\++\s*/, '').trim();
      if (depth === 2) {
        currentTarget = {
          key,
          menu: key,
          host: null,
          probe: currentGroup ? currentGroup.probe : defaultProbe,
        };
        if (currentGroup) currentGroup.targets.push(currentTarget);
      } else {
        // depth 3+ — flatten into current group, treat as a target
        currentTarget = {
          key,
          menu: key,
          host: null,
          probe: currentGroup ? currentGroup.probe : defaultProbe,
        };
        if (currentGroup) currentGroup.targets.push(currentTarget);
      }
      continue;
    }

    // + — group
    if (/^\+/.test(line)) {
      const key = line.replace(/^\+\s*/, '').trim();
      currentGroup = {
        key,
        menu: key,
        probe: defaultProbe,
        targets: [],
        sortOrder: groups.length,
      };
      groups.push(currentGroup);
      currentTarget = null;
      continue;
    }

    // key = value
    const kv = line.match(/^([\w-]+)\s*=\s*(.+)/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();

    if (currentTarget) {
      if (key === 'host') currentTarget.host = val;
      else if (key === 'menu') currentTarget.menu = val;
      else if (key === 'probe') currentTarget.probe = val;
    } else if (currentGroup) {
      if (key === 'menu') currentGroup.menu = val;
      else if (key === 'probe') currentGroup.probe = val;
    } else {
      if (key === 'probe') defaultProbe = val;
    }
  }

  return groups;
}

// ── Database import ────────────────────────────────────────────────────────

function importGroups(groups, dryRun) {
  const db = dryRun ? null : getDb();

  let groupCount = 0;
  let targetCount = 0;
  let skippedTargets = 0;

  // Build the full import plan (used for both dry run preview and actual write)
  const plan = [];
  for (const group of groups) {
    const valid = group.targets.filter((t) => t.host);
    const invalid = group.targets.length - valid.length;
    if (valid.length === 0) {
      console.log(`  [skip] Group "${group.menu}" — no targets with hosts`);
      continue;
    }
    plan.push({ group, valid, invalid });
    groupCount++;
    targetCount += valid.length;
    skippedTargets += invalid;
  }

  // Print preview
  for (const { group, valid, invalid } of plan) {
    console.log(`\nGroup: ${group.menu}`);
    for (const t of valid) {
      const probeType = mapProbeType(t.probe);
      console.log(`  ${probeType === 'dns' ? '[DNS ]' : '[ICMP]'} ${t.menu.padEnd(30)} ${t.host}`);
    }
    if (invalid > 0) {
      console.log(`  (${invalid} target${invalid > 1 ? 's' : ''} skipped — no host defined)`);
    }
  }

  if (dryRun) return { groupCount, targetCount, skippedTargets };

  // Write to DB in a single transaction
  const insertGroup = db.prepare('INSERT INTO groups (name, sort_order) VALUES (?, ?)');
  const insertTarget = db.prepare(
    `INSERT INTO targets (group_id, name, host, probe_type, interval_seconds, packet_count)
     VALUES (?, ?, ?, ?, 60, 10)`
  );

  db.transaction(() => {
    for (const { group, valid } of plan) {
      const groupId = insertGroup.run(group.menu, group.sortOrder).lastInsertRowid;
      for (const t of valid) {
        insertTarget.run(groupId, t.menu, t.host, mapProbeType(t.probe));
      }
    }
  })();

  return { groupCount, targetCount, skippedTargets };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
SmokePing → Meridian importer

Usage:
  node scripts/import-smokeping.js [--dry-run] <source>

Source can be:
  /path/to/Targets                    local file
  user@host:/etc/smokeping/Targets    SSH (uses your SSH key/agent)

Options:
  --dry-run    Preview what would be imported without writing to the database

Examples:
  node scripts/import-smokeping.js --dry-run admin@10.0.0.5:/etc/smokeping/config.d/Targets
  node scripts/import-smokeping.js admin@10.0.0.5:/etc/smokeping/config.d/Targets
  node scripts/import-smokeping.js /tmp/smokeping-targets.conf
`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const source = args.find((a) => !a.startsWith('--'));

  if (!source) {
    console.error('Error: no source specified. Run with --help for usage.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('=== DRY RUN — nothing will be written to the database ===\n');
  }

  let content;
  try {
    content = readSource(source);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const groups = parseTargets(content);
  const totalTargets = groups.reduce((n, g) => n + g.targets.length, 0);

  if (groups.length === 0) {
    console.error('No groups found in config.');
    console.error("Expected SmokePing Targets format with lines like '+ GroupName' and '++ TargetName'.");
    process.exit(1);
  }

  console.log(`Parsed: ${groups.length} groups, ${totalTargets} targets\n`);

  const { groupCount, targetCount, skippedTargets } = importGroups(groups, dryRun);

  console.log(`\n${dryRun ? 'Would import' : 'Imported'}: ${groupCount} group${groupCount !== 1 ? 's' : ''}, ${targetCount} target${targetCount !== 1 ? 's' : ''}`);
  if (skippedTargets > 0) {
    console.log(`Skipped: ${skippedTargets} targets (no host defined)`);
  }

  if (!dryRun && targetCount > 0) {
    console.log('\nNext steps:');
    console.log('  1. Restart the probe worker: node server/probe/index.js');
    console.log('  2. The probe worker will stagger probes across targets automatically.');
  }

  if (!dryRun) closeDb();
}

main();
