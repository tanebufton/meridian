'use strict';

// Require a valid session — use as preHandler on protected routes
async function requireAuth(req, reply) {
  if (!req.session) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

module.exports = { requireAuth };
