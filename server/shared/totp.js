'use strict';

// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s) implemented on node:crypto — no dependency,
// compatible with Google Authenticator, Authy, 1Password, Bitwarden, etc.

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP);

function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Check a code against the secret, allowing one step of clock drift either side.
 * Returns the matched time step (so the caller can refuse to accept it twice), or null.
 * `lastStep` is the most recent step already used: codes at or before it are rejected,
 * which stops a shoulder-surfed or intercepted code being replayed within its window.
 */
function verify(secretB32, code, { now = Date.now(), lastStep = null, window = 1 } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const current = stepAt(now);
  let matched = null;
  for (let w = -window; w <= window; w++) {
    const step = current + w;
    if (safeEqual(hotp(secretB32, step), c) && matched === null) matched = step; // no early exit: constant work
  }
  if (matched === null) return null;
  if (lastStep != null && matched <= lastStep) return null;
  return matched;
}

function otpauthUri({ secret, account, issuer = 'Meridian' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// ── Secret storage ──────────────────────────────────────────────────────────
// TOTP secrets must be recoverable (unlike passwords), so they are encrypted with
// AES-256-GCM under a key derived from SESSION_SECRET. A stolen database alone is then
// not enough to mint codes.
function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.startsWith('changeme')) {
    throw new Error('SESSION_SECRET must be set to a random value in .env to use two-factor authentication');
  }
  return crypto.scryptSync(secret, 'meridian-totp-v1', 32);
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ── Recovery codes ──────────────────────────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function generateRecoveryCodes(n = 10) {
  const plain = Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(8)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { plain, hashed: plain.map(sha) };
}

/** If `input` is an unused recovery code, return the remaining hashes (code consumed). */
function consumeRecoveryCode(hashedList, input) {
  const norm = String(input || '').trim().toLowerCase();
  if (!/^[a-z2-7]{5}-?[a-z2-7]{5}$/.test(norm)) return null;
  const h = sha(norm.includes('-') ? norm : `${norm.slice(0, 5)}-${norm.slice(5)}`);
  const idx = hashedList.indexOf(h);
  if (idx === -1) return null;
  return hashedList.filter((_, i) => i !== idx);
}

// ── Short-lived signed login challenge (between password and code steps) ─────
function hmacKey() { return crypto.createHmac('sha256', key()).update('challenge').digest(); }

function signChallenge(userId, ttlSeconds = 300) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = `${userId}.${exp}`;
  const mac = crypto.createHmac('sha256', hmacKey()).update(body).digest('hex');
  return `${body}.${mac}`;
}

function verifyChallenge(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, mac] = parts;
  const expect = crypto.createHmac('sha256', hmacKey()).update(`${uid}.${exp}`).digest('hex');
  if (!safeEqual(mac, expect)) return null;
  if (parseInt(exp, 10) < Math.floor(Date.now() / 1000)) return null;
  return parseInt(uid, 10);
}

module.exports = {
  base32Encode, base32Decode, generateSecret, hotp, verify, otpauthUri, STEP,
  encryptSecret, decryptSecret,
  generateRecoveryCodes, consumeRecoveryCode,
  signChallenge, verifyChallenge,
};
