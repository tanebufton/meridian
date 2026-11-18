'use strict';

// Hostnames, IPv4 and IPv6 literals (optionally with a %zone; IPv6 may start with ':' as in
// ::1). Must not start with '-' or '.'
// so a host can never be interpreted as a command-line option by ping/traceroute.
const HOST_RE = /^[A-Za-z0-9_:][A-Za-z0-9_.:%-]*$/;

function isSafeHost(host) {
  return typeof host === 'string' && host.length > 0 && host.length <= 255 && HOST_RE.test(host);
}

module.exports = { isSafeHost, HOST_RE };

/**
 * Validate a notification channel URL. Admins are trusted, but a webhook pointed at the
 * cloud metadata service or a link-local address is almost always a mistake or an SSRF
 * attempt, so those are refused. LAN/private addresses are allowed (Home Assistant etc).
 * Returns an error string, or null when the URL is acceptable.
 */
function validateChannelUrl(type, url) {
  switch (type) {
    case 'telegram':
      return /^tgram:\/\/[^/\s]+\/\S+$/.test(url) ? null : 'Telegram URL must look like tgram://BOT_TOKEN/CHAT_ID';
    case 'pagerduty':
      return /^pagerduty:\/\/[A-Za-z0-9]{16,64}$/.test(url) ? null : 'PagerDuty URL must look like pagerduty://INTEGRATION_KEY (the Events API v2 routing key)';
    case 'pushover':
      return /^pushover:\/\/[A-Za-z0-9]{20,40}@[A-Za-z0-9]{20,40}(\?[\w=&.-]*)?$/.test(url) ? null : 'Pushover URL must look like pushover://USER_KEY@APP_TOKEN';
    case 'opsgenie':
      return /^opsgenie:\/\/[A-Za-z0-9-]{20,60}(\?region=(us|eu))?$/.test(url) ? null : 'Opsgenie URL must look like opsgenie://API_KEY (add ?region=eu for the EU instance)';
    default: break;
  }
  let u;
  try { u = new URL(url); } catch { return 'Invalid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL must start with http:// or https://';
  const h = u.hostname.toLowerCase();
  if (h === '0.0.0.0' || h === '[::]' || /^169\.254\./.test(h) || /^\[?fe80:/i.test(h) || h === 'metadata.google.internal') {
    return 'That address is not allowed as a notification target';
  }
  return null;
}

module.exports.validateChannelUrl = validateChannelUrl;

// ── Per-probe-type host parsing ─────────────────────────────────────────────

/** tcp targets are written "host:port" or "[v6addr]:port". */
function parseTcpTarget(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^\[([0-9a-fA-F:.%]+)\]:(\d{1,5})$/) || value.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*):(\d{1,5})$/);
  if (!m) return null;
  const port = parseInt(m[2], 10);
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

function parseHttpTarget(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u;
  } catch { return null; }
}

/** Validate the `host` field for a probe type. Returns an error string or null. */
function validateHostFor(probeType, host) {
  switch (probeType) {
    case 'tcp':
      return parseTcpTarget(host) ? null : 'TCP targets must look like host:port (IPv6: [addr]:port)';
    case 'http':
      return parseHttpTarget(host) ? null : 'HTTP targets must be a full http:// or https:// URL';
    default:
      return isSafeHost(host) ? null : 'Host must be a hostname or IP address';
  }
}

/** The bare hostname to use for traceroute / display, whatever the probe type. */
function probeHostname(target) {
  if (target.probe_type === 'tcp') return parseTcpTarget(target.host)?.host ?? null;
  if (target.probe_type === 'http') return parseHttpTarget(target.host)?.hostname.replace(/^\[|\]$/g, '') ?? null;
  return target.host;
}

module.exports.parseTcpTarget = parseTcpTarget;
module.exports.parseHttpTarget = parseHttpTarget;
module.exports.validateHostFor = validateHostFor;
module.exports.probeHostname = probeHostname;
