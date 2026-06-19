#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { getDb, closeDb } = require('../server/db/db');

function run() {
  const db = getDb();

  const insertGroup = db.prepare(
    'INSERT INTO groups (name, description, sort_order) VALUES (?, ?, ?)'
  );
  const insertTarget = db.prepare(
    `INSERT INTO targets (group_id, name, host, probe_type, interval_seconds, packet_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const seed = db.transaction(() => {
    const dnsGroup = insertGroup.run('DNS Providers', 'Public DNS and resolution checks', 0);
    const lanGroup = insertGroup.run(
      'Local Network',
      'Local infrastructure — update gateway IP to match your network',
      1
    );

    insertTarget.run(dnsGroup.lastInsertRowid, 'Google DNS', '8.8.8.8', 'icmp', 60, 10);
    insertTarget.run(dnsGroup.lastInsertRowid, 'Cloudflare DNS', '1.1.1.1', 'icmp', 60, 10);
    insertTarget.run(dnsGroup.lastInsertRowid, 'Google DNS Resolution', 'google.com', 'dns', 60, 10);
    insertTarget.run(lanGroup.lastInsertRowid, 'Default Gateway', '192.168.1.1', 'icmp', 30, 5);
  });

  seed();
  console.log('Seed data inserted.');
  closeDb();
}

run();
