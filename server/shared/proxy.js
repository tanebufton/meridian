'use strict';

/**
 * Which proxies may tell us the real client IP (X-Forwarded-For).
 *
 * Trusting EVERY hop ("trustProxy: true") lets any client choose its own IP by sending the
 * header, which defeats rate limiting and falsifies the audit log. Instead only the
 * connection from the local Cloudflare Tunnel daemon is trusted, so the address Cloudflare
 * appended is what we use. Override with TRUSTED_PROXIES=ip,ip,... if cloudflared runs on
 * another machine.
 */
function trustedProxies() {
  if (process.env.TRUSTED_PROXIES) return process.env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.TRUST_CF_HEADERS === 'true') return ['127.0.0.1', '::1'];
  return false;
}

module.exports = { trustedProxies };
