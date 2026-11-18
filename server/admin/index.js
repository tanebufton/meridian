'use strict';

require('dotenv').config({ quiet: true });
const path = require('path');
const fastify = require('fastify');
const { closeDb, requireSchema } = require('../db/db');
const { validateSession, generateCsrfToken, validateCsrf } = require('./auth');
const { audit } = require('./audit');
const { trustedProxies } = require('../shared/proxy');

const app = fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    // Never log request bodies, cookies or auth headers
    serializers: { req: (req) => ({ method: req.method, url: req.url, ip: req.ip }) },
  },
  // When reached through the Cloudflare Tunnel, req.ip must be the real client or every
  // visitor shares one login-throttle bucket (and the audit log records 127.0.0.1)
  trustProxy: trustedProxies(),
});

app.decorateRequest('session', null);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function start() {
  requireSchema();

  await app.register(require('@fastify/helmet'), {
    // No HSTS: the admin UI is also served over plain HTTP on the LAN, and a cached HSTS
    // policy would force HTTPS on every later visit and break it. Same for COOP.
    hsts: false,
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  });

  await app.register(require('@fastify/cookie'));

  await app.register(require('@fastify/rate-limit'), {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  // Session + CSRF cookie on every request
  app.addHook('preHandler', async (req, reply) => {
    const token = req.cookies && req.cookies.session_token;
    if (token) req.session = validateSession(token);

    if (!req.cookies || !req.cookies.csrf_token) {
      reply.setCookie('csrf_token', generateCsrfToken(), {
        httpOnly: false, // must be readable by JS for double-submit
        sameSite: 'Strict',
        secure: req.protocol === 'https',
        path: '/',
      });
    }
  });

  // CSRF enforcement for state-changing admin API routes
  app.addHook('preHandler', async (req, reply) => {
    const isAdminApi = req.url.startsWith('/api/admin/');
    const isLoginRoute = req.url === '/api/admin/auth/login' || req.url === '/api/admin/auth/login/2fa';
    if (isAdminApi && MUTATING.has(req.method.toUpperCase()) && !isLoginRoute && !validateCsrf(req)) {
      return reply.status(403).send({ error: 'Invalid CSRF token' });
    }
  });

  // Audit trail: every successful admin change is recorded with who/when/from where.
  // Bodies are deliberately NOT logged (they can contain passwords and webhook secrets).
  // Auth routes record their own, more specific entries.
  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method) || !req.url.startsWith('/api/admin/') || reply.statusCode >= 400) return;
    const route = (req.routeOptions && req.routeOptions.url) || req.url.split('?')[0];
    if (route.startsWith('/api/admin/auth/')) return;
    const params = req.params && Object.keys(req.params).length ? req.params : null;
    audit(req, `${req.method} ${route.replace('/api/admin', '')}`, params);
  });

  // Static files — admin SPA
  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, '../../apps/admin/dist'),
    prefix: '/',
  });

  await app.register(require('./routes/health'), { prefix: '' });
  await app.register(require('./routes/metrics'), { prefix: '' });
  for (const r of ['auth', 'groups', 'targets', 'users', 'settings', 'config', 'notifications', 'maintenance', 'incidents', 'audit']) {
    await app.register(require(`./routes/${r}`), { prefix: '/api/admin' });
  }

  // SPA fallback
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url === '/metrics') {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  app.setErrorHandler(async (err, req, reply) => {
    const status = err.statusCode || err.status || 500;
    if (status >= 500) {
      app.log.error({ err, url: req.url }, 'Request error');
      return reply.status(500).send({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
    }
    return reply.status(status).send({ error: err.message });
  });

  const port = parseInt(process.env.ADMIN_PORT || '3002', 10);
  // Loopback by default: the admin UI speaks plain HTTP, so it should only be reachable
  // from outside this machine when you deliberately choose that. Set ADMIN_HOST=0.0.0.0
  // (or a specific LAN/Tailscale address) to serve it on the network.
  const host = process.env.ADMIN_HOST || '127.0.0.1';
  await app.listen({ port, host });
  app.log.info(`Admin server listening on ${host}:${port}`);
}

async function shutdown() {
  app.log.info('Shutting down admin server...');
  await app.close();
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
