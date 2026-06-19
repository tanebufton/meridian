'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getDb } = require('../db/db');

const SESSION_DURATION = 24 * 60 * 60; // 24h in seconds

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(userId) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION;
  const db = getDb();
  db.prepare(
    'INSERT INTO admin_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(userId, tokenHash, expiresAt);
  // Update last_login
  db.prepare('UPDATE admin_users SET last_login = unixepoch() WHERE id = ?').run(userId);
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare(
    `SELECT s.id, s.user_id, s.expires_at, u.username
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(tokenHash, now);

  if (!session) return null;

  // Slide the expiry
  const newExpiry = now + SESSION_DURATION;
  db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE id = ?').run(newExpiry, session.id);

  return { userId: session.user_id, username: session.username, sessionId: session.id };
}

function deleteSession(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  const db = getDb();
  db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
}

async function verifyPassword(username, password) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, password_hash FROM admin_users WHERE username = ?').get(username);
  if (!user) return null;
  const match = await bcrypt.compare(password, user.password_hash);
  return match ? user : null;
}

// CSRF: double-submit cookie
function generateCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

function validateCsrf(req) {
  const cookieToken = req.cookies && req.cookies.csrf_token;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken) return false;
  return crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
}

module.exports = {
  createSession,
  validateSession,
  deleteSession,
  verifyPassword,
  generateCsrfToken,
  validateCsrf,
};
