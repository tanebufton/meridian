'use strict';

const dns = require('dns').promises;

/**
 * Resolve a hostname using dns.resolve4() and measure time.
 * Returns { dns_time, dns_success, resolved_ip, error }
 */
async function resolveHost(host) {
  const start = Date.now();
  try {
    const addresses = await dns.resolve4(host);
    const dns_time = Date.now() - start;
    return {
      dns_time,
      dns_success: 1,
      resolved_ip: addresses[0] || null,
      error: null,
    };
  } catch (err) {
    const dns_time = Date.now() - start;
    return {
      dns_time,
      dns_success: 0,
      resolved_ip: null,
      error: err.message.slice(0, 500),
    };
  }
}

module.exports = { resolveHost };
