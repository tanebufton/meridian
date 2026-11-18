'use strict';

const bcrypt = require('bcrypt');
const { getDb } = require('../../db/db');
const { createSession, deleteSession, revokeSessions, verifyPassword, SESSION_DURATION } = require('../auth');
const { requireAuth } = require('../middleware');
const { createLimiter } = require('../ratelimit');
const { audit } = require('../audit');
const totp = require('../../shared/totp');
const {
  LoginSchema, SelfPasswordSchema, TwoFactorLoginSchema, PasswordAndCodeSchema,
} = require('../../shared/schemas');

// Count FAILED attempts only (a successful login no longer eats into the budget), and
// key on both IP and username so one IP can't hammer many accounts and many IPs can't
// hammer one account. Behind Cloudflare, req.ip is the real client (trustProxy).
const WINDOW = 15 * 60 * 1000;
const ipLimiter = createLimiter({ max: 10, windowMs: WINDOW });
const userLimiter = createLimiter({ max: 8, windowMs: WINDOW });

function limited(reply, ...checks) {
  const hit = checks.map((c) => c.limiter.check(c.key)).find((r) => !r.allowed);
  if (!hit) return false;
  reply.status(429).send({ error: 'Too many failed attempts. Please wait and try again.', retryAfter: hit.retryAfter });
  return true;
}

function setSessionCookie(req, reply, token) {
  reply.setCookie('session_token', token, {
    httpOnly: true,
    sameSite: 'Strict',
    // Secure whenever the request really arrived over HTTPS (e.g. via the Cloudflare
    // Tunnel), still works over plain HTTP on the LAN
    secure: req.protocol === 'https',
    path: '/',
    maxAge: SESSION_DURATION,
  });
}

function finishLogin(req, reply, user) {
  const token = createSession(user.id);
  setSessionCookie(req, reply, token);
  req.session = { userId: user.id, username: user.username };
  audit(req, 'login', null);
  return { ok: true, username: user.username };
}

const getUser = (id) => getDb().prepare('SELECT * FROM admin_users WHERE id = ?').get(id);

/**
 * Verify a TOTP code or a recovery code for this user. TOTP replay is blocked by
 * recording the step atomically. Returns 'totp' | 'recovery' | null.
 */
function checkSecondFactor(user, code) {
  const db = getDb();
  if (user.totp_secret) {
    let secret;
    try { secret = totp.decryptSecret(user.totp_secret); } catch { secret = null; }
    if (secret) {
      const step = totp.verify(secret, code, { lastStep: user.totp_last_step });
      if (step !== null) {
        const r = db.prepare(
          'UPDATE admin_users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)'
        ).run(step, user.id, step);
        if (r.changes === 1) return 'totp';
      }
    }
  }
  if (user.recovery_codes) {
    const list = JSON.parse(user.recovery_codes);
    const left = totp.consumeRecoveryCode(list, code);
    if (left) {
      const r = db.prepare('UPDATE admin_users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?')
        .run(JSON.stringify(left), user.id, user.recovery_codes);
      if (r.changes === 1) return 'recovery';
    }
  }
  return null;
}

module.exports = async function authRoutes(app) {
  const auth = { preHandler: requireAuth };

  // POST /api/admin/auth/login
  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request' });
    const { username, password } = parsed.data;

    const ip = { limiter: ipLimiter, key: req.ip };
    const usr = { limiter: userLimiter, key: username.toLowerCase() };
    if (limited(reply, ip, usr)) return;

    const user = await verifyPassword(username, password);
    if (!user) {
      ipLimiter.fail(ip.key); userLimiter.fail(usr.key);
      audit({ ip: req.ip }, 'login_failed', { username });
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    if (user.totp_enabled) {
      // Password is right, but no session until the second factor checks out
      return { requires_2fa: true, challenge: totp.signChallenge(user.id) };
    }

    userLimiter.reset(usr.key);
    return finishLogin(req, reply, user);
  });

  // POST /api/admin/auth/login/2fa — second step of a login for accounts with 2FA on
  app.post('/auth/login/2fa', async (req, reply) => {
    const parsed = TwoFactorLoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request' });

    const userId = totp.verifyChallenge(parsed.data.challenge);
    if (!userId) return reply.status(401).send({ error: 'Login expired — please sign in again' });
    const user = getUser(userId);
    if (!user || !user.totp_enabled) return reply.status(401).send({ error: 'Login expired — please sign in again' });

    const ip = { limiter: ipLimiter, key: req.ip };
    const usr = { limiter: userLimiter, key: user.username.toLowerCase() };
    if (limited(reply, ip, usr)) return;

    const how = checkSecondFactor(user, parsed.data.code);
    if (!how) {
      ipLimiter.fail(ip.key); userLimiter.fail(usr.key);
      audit({ ip: req.ip }, 'login_2fa_failed', { username: user.username });
      return reply.status(401).send({ error: 'Invalid code' });
    }

    userLimiter.reset(usr.key);
    const out = finishLogin(req, reply, user);
    if (how === 'recovery') {
      const left = JSON.parse(getUser(user.id).recovery_codes || '[]').length;
      audit(req, 'recovery_code_used', { remaining: left });
      out.recovery_codes_remaining = left;
    }
    return out;
  });

  // POST /api/admin/auth/logout
  app.post('/auth/logout', auth, async (req, reply) => {
    audit(req, 'logout', null);
    deleteSession(req.cookies && req.cookies.session_token);
    reply.clearCookie('session_token', { path: '/' });
    return { ok: true };
  });

  // GET /api/admin/auth/me
  app.get('/auth/me', auth, async (req) => {
    const u = getUser(req.session.userId);
    return {
      userId: req.session.userId,
      username: req.session.username,
      totp_enabled: !!(u && u.totp_enabled),
    };
  });

  // POST /api/admin/auth/change-password — change your own password
  app.post('/auth/change-password', auth, async (req, reply) => {
    const parsed = SelfPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || 'Invalid request';
      return reply.status(400).send({ error: msg });
    }
    const { current_password, new_password } = parsed.data;

    const key = { limiter: userLimiter, key: req.session.username.toLowerCase() };
    if (limited(reply, key)) return;

    const user = getUser(req.session.userId);
    // 403 not 401: the UI treats 401 as "session expired" and bounces to the login page
    if (!(await bcrypt.compare(current_password, user.password_hash))) {
      userLimiter.fail(key.key);
      audit(req, 'password_change_failed', null);
      return reply.status(403).send({ error: 'Current password is incorrect' });
    }
    if (new_password === current_password) return reply.status(400).send({ error: 'New password must be different' });
    if (new_password.toLowerCase() === user.username.toLowerCase()) return reply.status(400).send({ error: 'Password must not be the same as the username' });

    const hash = await bcrypt.hash(new_password, 12);
    getDb().prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    // Anyone holding an old session (including a thief) is signed out; this one stays
    const revoked = revokeSessions(user.id, req.cookies.session_token);
    audit(req, 'password_changed', { other_sessions_revoked: revoked });
    return { ok: true, other_sessions_revoked: revoked };
  });

  // ── Two-factor authentication ─────────────────────────────────────────────

  // GET /api/admin/auth/2fa
  app.get('/auth/2fa', auth, async (req) => {
    const u = getUser(req.session.userId);
    return {
      enabled: !!u.totp_enabled,
      pending: !u.totp_enabled && !!u.totp_secret,
      recovery_codes_remaining: u.recovery_codes ? JSON.parse(u.recovery_codes).length : 0,
    };
  });

  // POST /api/admin/auth/2fa/setup — start enrolment (re-authenticates with the password)
  app.post('/auth/2fa/setup', auth, async (req, reply) => {
    const password = req.body && req.body.password;
    if (typeof password !== 'string') return reply.status(400).send({ error: 'Password required' });
    const user = getUser(req.session.userId);
    if (user.totp_enabled) return reply.status(409).send({ error: 'Two-factor authentication is already enabled' });
    if (!(await bcrypt.compare(password, user.password_hash))) return reply.status(403).send({ error: 'Password is incorrect' });

    let encrypted;
    const secret = totp.generateSecret();
    try { encrypted = totp.encryptSecret(secret); }
    catch (e) { return reply.status(500).send({ error: e.message }); }

    getDb().prepare('UPDATE admin_users SET totp_secret = ?, totp_enabled = 0, totp_last_step = NULL WHERE id = ?').run(encrypted, user.id);

    const uri = totp.otpauthUri({ secret, account: user.username });
    const QRCode = require('qrcode');
    const qr_svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 220 });
    return { secret, otpauth_uri: uri, qr_svg };
  });

  // POST /api/admin/auth/2fa/enable — confirm with a code from the authenticator app
  app.post('/auth/2fa/enable', auth, async (req, reply) => {
    const user = getUser(req.session.userId);
    if (user.totp_enabled) return reply.status(409).send({ error: 'Already enabled' });
    if (!user.totp_secret) return reply.status(400).send({ error: 'Start setup first' });

    const key = { limiter: userLimiter, key: `2fa-enable:${user.id}` };
    if (limited(reply, key)) return;

    const step = totp.verify(totp.decryptSecret(user.totp_secret), req.body && req.body.code);
    if (step === null) { userLimiter.fail(key.key); return reply.status(400).send({ error: 'That code is not correct — check the time on your phone and try again' }); }

    const { plain, hashed } = totp.generateRecoveryCodes(10);
    getDb().prepare(
      'UPDATE admin_users SET totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?'
    ).run(step, JSON.stringify(hashed), user.id);
    // Other sessions were created without a second factor — end them
    revokeSessions(user.id, req.cookies.session_token);
    audit(req, '2fa_enabled', null);
    return { ok: true, recovery_codes: plain };
  });

  // Shared guard for disabling 2FA / regenerating codes: password AND a current code
  async function reauth(req, reply) {
    const parsed = PasswordAndCodeSchema.safeParse(req.body);
    if (!parsed.success) { reply.status(400).send({ error: 'Password and code required' }); return null; }
    const user = getUser(req.session.userId);
    const key = { limiter: userLimiter, key: req.session.username.toLowerCase() };
    if (limited(reply, key)) return null;
    const pwOk = await bcrypt.compare(parsed.data.password, user.password_hash);
    const how = pwOk ? checkSecondFactor(user, parsed.data.code) : null;
    if (!pwOk || !how) {
      userLimiter.fail(key.key);
      reply.status(403).send({ error: pwOk ? 'Code is incorrect' : 'Password is incorrect' });
      return null;
    }
    return user;
  }

  // POST /api/admin/auth/2fa/disable
  app.post('/auth/2fa/disable', auth, async (req, reply) => {
    const user = await reauth(req, reply);
    if (!user) return;
    getDb().prepare(
      'UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?'
    ).run(user.id);
    audit(req, '2fa_disabled', null);
    return { ok: true };
  });

  // POST /api/admin/auth/2fa/recovery-codes — replace all recovery codes
  app.post('/auth/2fa/recovery-codes', auth, async (req, reply) => {
    const user = await reauth(req, reply);
    if (!user) return;
    const { plain, hashed } = totp.generateRecoveryCodes(10);
    getDb().prepare('UPDATE admin_users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashed), user.id);
    audit(req, '2fa_recovery_codes_regenerated', null);
    return { ok: true, recovery_codes: plain };
  });
};
