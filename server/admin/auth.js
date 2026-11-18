'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getDb } = require('../db/db');

const SESSION_DURATION = 24 * 60 * 60; // 24h in seconds
const SLIDE_AFTER = 5 * 60;            // only extend a session's expiry every 5 min, not on every request

// Compared against when a username does not exist, so "unknown user" and "wrong
// password" take the same time and cannot be told apart by timing.
const DUMMY_HASH = bcrypt.hashSync('meridian-dummy-password', 12);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(userId) {
  const token = generateToken();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION;
  const db = getDb();
  db.prepare(
    'INSERT INTO admin_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(userId, hashToken(token), expiresAt);
  db.prepare('UPDATE admin_users SET last_login = unixepoch() WHERE id = ?').run(userId);
  // Opportunistic cleanup so expired sessions never accumulate
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < unixepoch()').run();
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare(
    `SELECT s.id, s.user_id, s.expires_at, u.username
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(hashToken(token), now);

  if (!session) return null;

  // Slide the expiry — but not on every request, which turned each page view into a write
  if (session.expires_at - now < SESSION_DURATION - SLIDE_AFTER) {
    db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE id = ?').run(now + SESSION_DURATION, session.id);
  }

  return { userId: session.user_id, username: session.username, sessionId: session.id };
}

function deleteSession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Sign a user out everywhere except (optionally) the session identified by keepToken. */
function revokeSessions(userId, keepToken = null) {
  const db = getDb();
  if (keepToken) {
    return db.prepare('DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?').run(userId, hashToken(keepToken)).changes;
  }
  return db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(userId).changes;
}

async function verifyPassword(username, password) {
  const db = getDb();
  const user = db.prepare(
    'SELECT id, username, password_hash, totp_enabled FROM admin_users WHERE username = ?'
  ).get(username);
  const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  return user && match ? user : null;
}

// CSRF: double-submit cookie
function generateCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

function validateCsrf(req) {
  const cookieToken = req.cookies && req.cookies.csrf_token;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken) return false;
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(String(headerToken));
  // timingSafeEqual throws on a length mismatch, which used to turn a malformed header into a 500
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  createSession,
  validateSession,
  deleteSession,
  revokeSessions,
  verifyPassword,
  generateCsrfToken,
  validateCsrf,
  SESSION_DURATION,
};
