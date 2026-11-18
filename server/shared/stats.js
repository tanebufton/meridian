'use strict';

/** Percentile of an ascending-sorted array, linear interpolation between ranks. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** p50/p95 over the answered packets of one probe. Needs a few samples to mean anything. */
function probePercentiles(rtts) {
  const ok = (rtts || []).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (ok.length < 3) return { p50: null, p95: null };
  const r = (v) => Math.round(v * 1000) / 1000;
  return { p50: r(percentile(ok, 50)), p95: r(percentile(ok, 95)) };
}

module.exports = { percentile, probePercentiles };
