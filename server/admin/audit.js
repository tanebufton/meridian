'use strict';

const { getDb } = require('../db/db');

/** Record an admin action. Never throws — auditing must not break the request. */
function audit(req, action, detail) {
  try {
    getDb().prepare('INSERT INTO audit_log (username, ip, action, detail) VALUES (?, ?, ?, ?)').run(
      req?.session?.username ?? null,
      req?.ip ?? null,
      action,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1000)
    );
  } catch { /* ignore */ }
}

module.exports = { audit };
