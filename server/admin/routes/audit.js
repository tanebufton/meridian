'use strict';

const { getDb } = require('../../db/db');
const { requireAuth } = require('../middleware');

module.exports = async function auditRoutes(app) {
  // GET /api/admin/audit?limit=100&before=<id>
  app.get('/audit', { preHandler: requireAuth }, async (req) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const before = parseInt(req.query.before, 10);
    return getDb().prepare(
      `SELECT id, at, username, ip, action, detail FROM audit_log
       ${Number.isFinite(before) ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`
    ).all(...(Number.isFinite(before) ? [before, limit] : [limit]));
  });
};
