#!/usr/bin/env node
'use strict';

const readline = require('readline');
const bcrypt = require('bcrypt');
require('dotenv').config();
const { getDb, closeDb } = require('../server/db/db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

async function run() {
  const username = await question('Admin username: ');
  const password = await question('Admin password: ');
  rl.close();

  if (!username.trim() || !password.trim()) {
    console.error('Username and password are required.');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const db = getDb();

  try {
    db.prepare(
      'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)'
    ).run(username.trim(), hash);
    console.log(`Admin user "${username.trim()}" created.`);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      console.error(`User "${username.trim()}" already exists.`);
      process.exit(1);
    }
    throw err;
  } finally {
    closeDb();
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
