'use strict';

// Groups and targets can be marked private (is_public = 0): they are still probed, alerted on and
// shown in the admin UI and /metrics, but never appear on the public dashboard or public API.
// A private group hides all of its targets, whatever their own flag says.

const PUBLIC_TARGET_SQL = 't.is_public = 1 AND g.is_public = 1';

/** The target row if it exists AND is publicly visible, otherwise null (→ respond 404). */
function publicTarget(db, id) {
  return db.prepare(
    `SELECT t.* FROM targets t JOIN groups g ON g.id = t.group_id WHERE t.id = ? AND ${PUBLIC_TARGET_SQL}`
  ).get(id) || null;
}

function publicGroup(db, id) {
  return db.prepare('SELECT * FROM groups WHERE id = ? AND is_public = 1').get(id) || null;
}

module.exports = { PUBLIC_TARGET_SQL, publicTarget, publicGroup };
