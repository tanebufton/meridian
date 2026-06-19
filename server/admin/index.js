'use strict';

require('dotenv').config();
const path = require('path');
const fastify = require('fastify');
const { closeDb } = require('../db/db');
const { validateSession, generateCsrfToken, validateCsrf } = require('./auth');

const app = fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

// Decorate request with session
app.decorateRequest('session', null);

async function start() {
  await app.register(require('@fastify/helmet'), {
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
      },
    },
    // HSTS must be disabled — server is HTTP on LAN. If enabled (even by default)
    // the browser caches it and forces HTTPS on all future visits, breaking the UI.
    hsts: false,
    // Same reason — COOP is only meaningful on secure origins
    crossOriginOpenerPolicy: false,
  });

  await app.register(require('@fastify/cookie'));

  await app.register(require('@fastify/rate-limit'), {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  // Auth middleware — runs on every request (auth routes handle their own logic)
  app.addHook('preHandler', async (req, reply) => {
    const token = req.cookies && req.cookies.session_token;
    if (token) {
      req.session = validateSession(token);
    }

    // Issue or refresh CSRF cookie on each response
    if (!req.cookies || !req.cookies.csrf_token) {
      reply.setCookie('csrf_token', generateCsrfToken(), {
        httpOnly: false, // must be readable by JS for double-submit
        sameSite: 'Strict',
        path: '/',
      });
    }
  });

  // CSRF enforcement for state-changing admin API routes
  app.addHook('preHandler', async (req, reply) => {
    const method = req.method.toUpperCase();
    const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
    const isAdminApi = req.url.startsWith('/api/admin/');
    const isLoginRoute = req.url === '/api/admin/auth/login';

    if (isAdminApi && isStateChanging && !isLoginRoute) {
      if (!validateCsrf(req)) {
        return reply.status(403).send({ error: 'Invalid CSRF token' });
      }
    }
  });

  // Static files — admin SPA
  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, '../../apps/admin/dist'),
    prefix: '/',
  });

  // API routes
  await app.register(require('./routes/health'), { prefix: '' });
  await app.register(require('./routes/auth'), { prefix: '/api/admin' });
  await app.register(require('./routes/groups'), { prefix: '/api/admin' });
  await app.register(require('./routes/targets'), { prefix: '/api/admin' });
  await app.register(require('./routes/users'), { prefix: '/api/admin' });
  await app.register(require('./routes/settings'), { prefix: '/api/admin' });
  await app.register(require('./routes/config'), { prefix: '/api/admin' });

  // SPA fallback
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  const port = parseInt(process.env.ADMIN_PORT || '3002', 10);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`Admin server listening on 0.0.0.0:${port}`);
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
