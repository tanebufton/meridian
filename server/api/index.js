'use strict';

require('dotenv').config();
const path = require('path');
const fastify = require('fastify');
const { closeDb } = require('../db/db');

const app = fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    // Never log request bodies — they could contain sensitive data from probes
    serializers: { req: (req) => ({ method: req.method, url: req.url }) },
  },
  trustProxy: process.env.TRUST_CF_HEADERS === 'true',
  // Reject request bodies over 16 KB — the public API has no write endpoints,
  // so any large body is either a bug or an attack
  bodyLimit: 16_384,
  // Reject excessively long URLs
  maxParamLength: 128,
});

async function start() {
  // Security headers
  await app.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],          // no unsafe-inline for scripts
        styleSrc: ["'self'", "'unsafe-inline'"], // needed for React inline styles
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],          // no Flash / plugins
        mediaSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],     // prevent clickjacking via iframes
        baseUri: ["'self'"],            // prevent base-tag injection
        formAction: ["'self'"],
        // handled by Cloudflare Tunnel. This directive would force the
        // browser to reload assets over HTTPS and break LAN access.
      },
    },
    hidePoweredBy: true,
    noSniff: true,
    frameguard: { action: 'deny' },
    // No HSTS — once a browser stores an HSTS policy for this IP it forces
    // HTTPS on all future visits, causing ERR_SSL_PROTOCOL_ERROR on LAN.
    // Cloudflare enforces HTTPS for external users without us setting this.
    hsts: false,
    // Don't allow the page to be loaded in an object/embed
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    // Referrer policy
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  // Rate limiting — keyed on the real client IP from Cloudflare.
  // 600/min accommodates group views with 140+ targets, each fetching its own
  // mini-chart data on page load, plus the 60s polling interval.
  await app.register(require('@fastify/rate-limit'), {
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) =>
      req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip,
    errorResponseBuilder: (_req, context) => ({
      error: 'Too many requests',
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });

  // Reject any request with path traversal patterns before they reach route handlers.
  // @fastify/static already normalises paths safely, but this adds an explicit early guard.
  app.addHook('onRequest', async (req, reply) => {
    const raw = req.url;
    if (
      raw.includes('..') ||           // directory traversal
      raw.includes('\0') ||           // null byte injection
      raw.includes('%2e%2e') ||       // URL-encoded ..
      raw.includes('%00') ||          // URL-encoded null byte
      raw.includes('%2f%2e%2e') ||    // URL-encoded /..
      /[<>'"`;]/.test(raw)            // obvious injection characters in URL
    ) {
      return reply.status(400).send({ error: 'Invalid request' });
    }
  });

  // Prevent search engines from indexing the monitoring dashboard
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow');
  });

  // Static files — public SPA
  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, '../../apps/public/dist'),
    prefix: '/',
  });

  // API routes — all read-only
  await app.register(require('./routes/health'), { prefix: '' });
  await app.register(require('./routes/groups'), { prefix: '/api/v1' });
  await app.register(require('./routes/targets'), { prefix: '/api/v1' });
  await app.register(require('./routes/summary'), { prefix: '/api/v1' });

  // SPA fallback
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  // Hide implementation details from error responses in production.
  // Note: @fastify/rate-limit may not set err.statusCode when errorResponseBuilder
  // returns a plain object — check err.retryAfter as a fallback signal for 429s.
  app.setErrorHandler(async (err, req, reply) => {
    const status = err.statusCode || err.status || (err.retryAfter != null ? 429 : 500);
    if (status === 429) {
      return reply.status(429).send({ error: 'Too many requests', retryAfter: err.retryAfter ?? 60 });
    }
    app.log.error({ err, url: req.url }, 'Request error');
    if (process.env.NODE_ENV === 'production' && status >= 500) {
      return reply.status(500).send({ error: 'Internal server error' });
    }
    return reply.status(status).send({ error: err.message });
  });

  const port = parseInt(process.env.PUBLIC_PORT || '3001', 10);
  const host = process.env.PUBLIC_HOST || '127.0.0.1';
  await app.listen({ port, host });
  app.log.info(`Public server listening on ${host}:${port}`);
}

async function shutdown() {
  app.log.info('Shutting down public server...');
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
