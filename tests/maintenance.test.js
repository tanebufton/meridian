'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../server/shared/maintenance');

const H = 3600;
test('one-off windows', () => {
  const w = { starts_at: 1000, ends_at: 2000, repeat: 'none' };
  assert.equal(m.describe(w, 999).active, false);
  assert.equal(m.describe(w, 1000).active, true);
  assert.equal(m.describe(w, 1999).active, true);
  assert.equal(m.describe(w, 2000), null, 'finished windows disappear');
});

test('daily repeat', () => {
  const w = { starts_at: 10 * 86400 + 2 * H, ends_at: 10 * 86400 + 3 * H, repeat: 'daily' };
  assert.equal(m.describe(w, 15 * 86400 + 2.5 * H).active, true);
  assert.equal(m.describe(w, 15 * 86400 + 4 * H).active, false);
  const d = m.describe(w, 15 * 86400 + 4 * H);
  assert.equal(d.start, 16 * 86400 + 2 * H, 'next occurrence is tomorrow');
  assert.equal(m.describe(w, 5 * 86400).active, false, 'not before first start');
});

test('weekly repeat', () => {
  const w = { starts_at: 7 * 86400, ends_at: 7 * 86400 + H, repeat: 'weekly' };
  assert.equal(m.describe(w, 14 * 86400 + 60).active, true);
  assert.equal(m.describe(w, 15 * 86400).active, false);
});

test('scope matching', () => {
  const t = { id: 5, group_id: 2 };
  assert.ok(m.covers({ scope: 'all' }, t));
  assert.ok(m.covers({ scope: 'group', scope_id: 2 }, t));
  assert.ok(!m.covers({ scope: 'group', scope_id: 3 }, t));
  assert.ok(m.covers({ scope: 'target', scope_id: 5 }, t));
  assert.ok(!m.covers({ scope: 'target', scope_id: 6 }, t));
});
