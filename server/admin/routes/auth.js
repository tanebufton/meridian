'use strict';

const { createSession, deleteSession, verifyPassword } = require('../auth');
const { requireAuth } = require('../middleware');
const { LoginSchema } = require('../../shared/schemas');

// Login rate limiter: 10 attempts per IP per 15 minutes
const loginAttempts = new Map();

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const window = 15 * 60 * 1000;
  const max = 10;

  const record = loginAttempts.get(ip) || { count: 0, windowStart: now };

  if (now - record.windowStart > window) {
    // Reset window
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (record.count >= max) {
    const retryAfter = Math.ceil((window - (now - record.windowStart)) / 1000);
    return { allowed: false, retryAfter };
  }

  record.count++;
  loginAttempts.set(ip, record);
  return { allowed: true };
}

module.exports = async function authRoutes(app) {
  // POST /api/admin/auth/login
  app.post('/auth/login', async (req, reply) => {
    const ip = req.ip;
    const rateCheck = checkLoginRateLimit(ip);
    if (!rateCheck.allowed) {
      return reply.status(429).send({
        error: 'Too many login attempts. Please wait.',
        retryAfter: rateCheck.retryAfter,
      });
    }

    const result = LoginSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: 'Invalid request' });
    }

    const { username, password } = result.data;
    const user = await verifyPassword(username, password);
    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = createSession(user.id);

    reply.setCookie('session_token', token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 24 * 60 * 60,
    });

    return { ok: true, username: user.username };
  });

  // POST /api/admin/auth/logout
  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const token = req.cookies && req.cookies.session_token;
    deleteSession(token);
    reply.clearCookie('session_token', { path: '/' });
    return { ok: true };
  });

  // GET /api/admin/auth/me
  app.get('/auth/me', { preHandler: requireAuth }, async (req) => ({
    userId: req.session.userId,
    username: req.session.username,
  }));
};
