'use strict';

/**
 * Small in-memory failure limiter: after `max` failures within `windowMs` a key is
 * blocked until the window rolls over. Entries are pruned, so it cannot grow without
 * bound (the previous login limiter never forgot an IP it had seen).
 */
function createLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> { count, start }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  timer.unref?.();

  function live(key) {
    const rec = hits.get(key);
    if (!rec) return null;
    if (Date.now() - rec.start > windowMs) { hits.delete(key); return null; }
    return rec;
  }

  return {
    /** { allowed, retryAfter } without counting anything */
    check(key) {
      const rec = live(key);
      if (rec && rec.count >= max) {
        return { allowed: false, retryAfter: Math.ceil((windowMs - (Date.now() - rec.start)) / 1000) };
      }
      return { allowed: true };
    },
    fail(key) {
      const rec = live(key);
      if (rec) rec.count++; else hits.set(key, { count: 1, start: Date.now() });
    },
    reset(key) { hits.delete(key); },
    size: () => hits.size,
  };
}

module.exports = { createLimiter };
