'use strict';

// SQL fragments shared by rollups, uptime and migrations so "what counts as a failed
// probe" and "what is the loss figure" are defined exactly once.

// A raw probe counts as failed when ICMP lost every packet, or DNS did not resolve.
const RAW_FAIL = `(CASE
  WHEN dns_success IS NOT NULL THEN (dns_success = 0)
  ELSE (COALESCE(packet_loss, 100) >= 100)
END)`;

// Loss % for a raw probe row (DNS failures count as 100% loss).
const RAW_LOSS = `(CASE
  WHEN packet_loss IS NOT NULL THEN packet_loss
  WHEN dns_success IS NOT NULL THEN (CASE WHEN dns_success = 0 THEN 100.0 ELSE 0.0 END)
  ELSE NULL
END)`;

// Failed-probe count for an aggregate row. Rows written before fail_count existed are
// estimated: a bucket with 100% loss failed completely, anything else is assumed clean.
const AGG_FAIL = `COALESCE(fail_count, CASE WHEN packet_loss >= 100 THEN sample_count ELSE 0 END)`;

module.exports = { RAW_FAIL, RAW_LOSS, AGG_FAIL };
