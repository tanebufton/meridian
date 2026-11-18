'use strict';

const https = require('https');
const http = require('http');
const { getDb } = require('../db/db');
const { loadSettings } = require('../shared/settings');

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function formatMessage({ event, target, host, group, status, targetUrl, durationSeconds, cause, digest }) {
  if (event === 'digest') return digest;
  const loc = group ? ` (${group})` : '';
  let msg;
  if (event === 'recovered' || (!event && status === 'UP')) {
    const took = durationSeconds ? ` after ${fmtDuration(durationSeconds)}` : '';
    msg = `✅ ${target} recovered${took} — ${host}${loc}`;
  } else if (event === 'reminder') {
    msg = `⏰ ${target} is still DOWN (${fmtDuration(durationSeconds)}) — ${host}${loc}`;
  } else {
    msg = `🔴 ${target} is ${status || 'DOWN'} — ${host}${loc}`;
    if (cause) msg += `\n${String(cause).slice(0, 200)}`;
  }
  if (targetUrl) msg += `\n${targetUrl}`;
  return msg;
}

// Endpoints for hosted services. Exposed (and mutable) so tests can point them at a local server.
const endpoints = {
  pagerduty: 'https://events.pagerduty.com/v2/enqueue',
  pushover: 'https://api.pushover.net/1/messages.json',
  opsgenie: { us: 'https://api.opsgenie.com/v2/alerts', eu: 'https://api.eu.opsgenie.com/v2/alerts' },
  telegram: 'https://api.telegram.org',
};

// Transient failures (network errors, 5xx, 429) are retried; a 4xx means the config is wrong
// and retrying won't help. Delays are exposed so tests don't wait.
const retry = { delays: [1000, 4000] };

// Channels that page a human through an escalation system. They de-duplicate on their own side,
// so they are exempt from our flood limiter: a mass outage is exactly when you want to be paged.
const PAGING = new Set(['pagerduty', 'opsgenie']);

class HttpError extends Error {
  constructor(status, host) { super(`HTTP ${status} from ${host}`); this.status = status; }
}

function requestOnce(url, { method = 'POST', body, headers = {}, form = false }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }

    const data = body == null ? null : form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    const isHttps = parsed.protocol === 'https:';
    const hdrs = {
      'User-Agent': 'Meridian/1.0',
      ...(data != null ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...headers,
    };
    if (parsed.username) hdrs.Authorization = hdrs.Authorization || `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`;

    const req = (isHttps ? https : http).request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: hdrs,
    }, (res) => {
      res.resume();
      if (res.statusCode >= 400) return reject(new HttpError(res.statusCode, parsed.hostname));
      resolve({ status: res.statusCode });
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`Timeout: ${parsed.hostname}`)));
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

async function send(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt <= retry.delays.length; attempt++) {
    try { return await requestOnce(url, opts); }
    catch (err) {
      lastErr = err;
      const transient = !(err instanceof HttpError) || err.status >= 500 || err.status === 429;
      if (!transient || attempt === retry.delays.length) break;
      await new Promise((r) => setTimeout(r, retry.delays[attempt]));
    }
  }
  throw lastErr;
}

const postJson = (url, body, headers) => send(url, { body, headers });

const isRecovery = (p) => p.event === 'recovered' || (!p.event && p.status === 'UP');

async function sendToChannel(channel, payload) {
  const msg = formatMessage(payload);
  const recovered = isRecovery(payload);

  switch (channel.type) {
    case 'slack':
      return postJson(channel.url, { text: msg, username: 'Meridian', icon_emoji: ':satellite_antenna:' });

    case 'discord':
      return postJson(channel.url, { content: msg.slice(0, 1900), username: 'Meridian' });

    case 'teams': {
      // Legacy Office 365 connectors want a MessageCard; Workflows webhooks want an Adaptive Card
      if (/office\.com|office365\.com/.test(channel.url)) {
        return postJson(channel.url, {
          '@type': 'MessageCard', '@context': 'http://schema.org/extensions',
          themeColor: recovered ? '2EA44F' : 'CF222E', summary: msg.split('\n')[0], text: msg.replace(/\n/g, '\n\n'),
        });
      }
      return postJson(channel.url, {
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: msg, wrap: true }] } }],
      });
    }

    case 'gotify':
      return postJson(channel.url, {
        title: recovered ? `${payload.target} recovered` : payload.event === 'digest' ? 'Meridian alert digest' : `${payload.target} is down`,
        message: msg, priority: recovered ? 3 : 8,
      });

    case 'ntfy': {
      // ?token=tk_… sends it as a Bearer token; user:pass@ in the URL is sent as Basic auth
      const u = new URL(channel.url);
      const token = u.searchParams.get('token');
      u.searchParams.delete('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      if (payload.event === 'digest') return postJson(u.toString(), { topic: undefined, title: 'Meridian: alert digest', message: msg, priority: 4, tags: ['warning'] }, headers);
      const title = recovered ? `${payload.target} recovered` : payload.event === 'reminder' ? `${payload.target} still DOWN` : `${payload.target} is ${payload.status}`;
      const body = { title, message: msg.split('\n')[0].replace(/^\S+\s/, ''), priority: recovered ? 3 : 5, tags: [recovered ? 'white_check_mark' : 'red_circle'] };
      if (payload.targetUrl) body.click = payload.targetUrl;
      return postJson(u.toString(), body, headers);
    }

    case 'telegram': {
      const match = channel.url.match(/^tgram:\/\/([^/]+)\/(.+)$/);
      if (!match) throw new Error('Invalid Telegram URL — expected tgram://TOKEN/CHATID');
      const [, token, chatId] = match;
      return postJson(`${endpoints.telegram}/bot${token}/sendMessage`, { chat_id: chatId, text: msg });
    }

    case 'pushover': {
      // pushover://USER_KEY@APP_TOKEN[?device=phone&sound=siren]
      const m = channel.url.match(/^pushover:\/\/([^@/?]+)@([^/?]+)(\?.*)?$/);
      if (!m) throw new Error('Invalid Pushover URL — expected pushover://USER_KEY@APP_TOKEN');
      const extra = new URLSearchParams((m[3] || '').slice(1));
      const body = {
        token: m[2], user: m[1],
        title: recovered ? `${payload.target} recovered` : payload.event === 'digest' ? 'Meridian alert digest' : `${payload.target} is DOWN`,
        message: msg.slice(0, 1000),
        priority: recovered || payload.event === 'digest' ? 0 : 1, // 1 = bypass quiet hours
      };
      if (payload.targetUrl) { body.url = payload.targetUrl; body.url_title = 'Open in Meridian'; }
      for (const k of ['device', 'sound']) if (extra.get(k)) body[k] = extra.get(k);
      return send(endpoints.pushover, { body, form: true });
    }

    case 'pagerduty': {
      const m = channel.url.match(/^pagerduty:\/\/([A-Za-z0-9]+)$/);
      if (!m) throw new Error('Invalid PagerDuty URL — expected pagerduty://INTEGRATION_KEY');
      if (payload.event === 'digest') return { skipped: true }; // paging systems get every event individually
      const dedup = `meridian-incident-${payload.incidentId ?? payload.target}`;
      const body = { routing_key: m[1], dedup_key: dedup, event_action: recovered ? 'resolve' : 'trigger' };
      if (!recovered) {
        body.payload = {
          summary: `${payload.target} is DOWN (${payload.host})${payload.cause ? ` — ${String(payload.cause).slice(0, 120)}` : ''}`,
          source: payload.host || payload.target,
          severity: 'critical',
          timestamp: payload.timestamp,
          component: payload.target,
          group: payload.group || undefined,
          class: 'connectivity',
          custom_details: { host: payload.host, group: payload.group, down_for_seconds: payload.durationSeconds, event: payload.event },
        };
        if (payload.targetUrl) body.links = [{ href: payload.targetUrl, text: 'Open in Meridian' }];
      }
      return postJson(endpoints.pagerduty, body);
    }

    case 'opsgenie': {
      const m = channel.url.match(/^opsgenie:\/\/([A-Za-z0-9-]+)(\?.*)?$/);
      if (!m) throw new Error('Invalid Opsgenie URL — expected opsgenie://API_KEY[?region=eu]');
      if (payload.event === 'digest') return { skipped: true };
      const region = new URLSearchParams((m[2] || '').slice(1)).get('region') === 'eu' ? 'eu' : 'us';
      const base = endpoints.opsgenie[region];
      const headers = { Authorization: `GenieKey ${m[1]}` };
      const alias = `meridian-incident-${payload.incidentId ?? payload.target}`;
      if (recovered) return postJson(`${base}/${encodeURIComponent(alias)}/close?identifierType=alias`, { source: 'Meridian', note: msg }, headers);
      return postJson(base, {
        message: `${payload.target} is DOWN`.slice(0, 130), alias, description: msg, source: 'Meridian', priority: 'P2',
        tags: ['meridian', ...(payload.group ? [payload.group] : [])], details: { host: String(payload.host || ''), cause: String(payload.cause || '') },
      }, headers);
    }

    case 'webhook':
    default:
      return postJson(channel.url, {
        event: payload.event || (recovered ? 'recovered' : 'down'),
        incident_id: payload.incidentId ?? null,
        target: payload.target,
        host: payload.host,
        group: payload.group,
        status: payload.status,
        previous_status: payload.previousStatus,
        duration_seconds: payload.durationSeconds ?? null,
        cause: payload.cause ?? null,
        message: msg,
        target_url: payload.targetUrl || null,
        timestamp: payload.timestamp,
      });
  }
}

// ── Delivery status ─────────────────────────────────────────────────────────
function recordDelivery(channelId, err) {
  try {
    const db = getDb();
    if (err) db.prepare('UPDATE notification_channels SET last_error = ?, last_error_at = unixepoch() WHERE id = ?').run(String(err.message || err).slice(0, 300), channelId);
    else db.prepare('UPDATE notification_channels SET last_ok_at = unixepoch(), last_error = NULL, last_error_at = NULL WHERE id = ?').run(channelId);
  } catch { /* status is best-effort */ }
}

// Does this channel want this event? (group filter + "send recoveries" switch)
function wants(channel, payload) {
  if (channel.send_recovery === 0 && isRecovery(payload)) return false;
  if (channel.groups_json && payload.groupId != null) {
    try { if (!JSON.parse(channel.groups_json).includes(payload.groupId)) return false; } catch { /* bad filter: don't drop alerts */ }
  }
  return true;
}

// ── Flood protection ────────────────────────────────────────────────────────
// More than FLOOD_THRESHOLD alerts within FLOOD_WINDOW_MS (a mass outage or recovery) are held for
// FLOOD_COOLDOWN_MS and sent as one digest. Applies to chat-style channels only (see PAGING).
const flood = { windowMs: 60_000, threshold: 5, cooldownMs: 5 * 60_000 };

let recentSends = [];
let suppressUntil = 0;
let suppressed = [];
let digestTimer = null;

function floodGuard(now = Date.now()) {
  if (now < suppressUntil) return true;
  recentSends = recentSends.filter((t) => t >= now - flood.windowMs);
  recentSends.push(now);
  if (recentSends.length > flood.threshold) {
    suppressUntil = now + flood.cooldownMs;
    console.warn(`[notifier] flood protection engaged — batching chat alerts for ${flood.cooldownMs / 60_000} min`);
    digestTimer = setTimeout(flushDigest, flood.cooldownMs + 1000);
    digestTimer.unref?.();
    return true;
  }
  return false;
}

async function flushDigest() {
  digestTimer = null;
  const events = suppressed;
  suppressed = [];
  if (events.length === 0) return;
  for (const ch of enabledChannels().filter((c) => !PAGING.has(c.type))) {
    const mine = events.filter((e) => wants(ch, e));
    if (mine.length === 0) continue;
    const down = mine.filter((e) => e.event !== 'recovered');
    const rec = mine.filter((e) => e.event === 'recovered');
    const names = (list) => list.slice(0, 10).map((e) => e.target).join(', ') + (list.length > 10 ? `, +${list.length - 10} more` : '');
    const lines = [`⚠️ ${mine.length} alerts were batched during an alert flood:`];
    if (down.length) lines.push(`🔴 ${down.length} down: ${names(down)}`);
    if (rec.length) lines.push(`✅ ${rec.length} recovered: ${names(rec)}`);
    await deliver(ch, { event: 'digest', digest: lines.join('\n'), target: 'Meridian', host: '', status: 'DIGEST', timestamp: new Date().toISOString() });
  }
}

function enabledChannels() {
  try { return getDb().prepare('SELECT * FROM notification_channels WHERE enabled = 1').all(); }
  catch { return []; } // table not yet created (pre-migration install)
}

async function deliver(ch, payload) {
  try { await sendToChannel(ch, payload); recordDelivery(ch.id, null); }
  catch (err) { recordDelivery(ch.id, err); console.warn(`[notifier] channel "${ch.name}" failed: ${err.message}`); }
}

/**
 * Dispatch an incident event.  kind: 'down' | 'recovered' | 'reminder'
 */
async function fireStatusChange({ kind, targetId, groupId, name, host, groupName, incidentId, durationSeconds, cause }) {
  const channels = enabledChannels();
  if (channels.length === 0) return;

  const baseUrl = loadSettings().public_base_url;
  const targetUrl = (baseUrl && targetId) ? `${baseUrl.replace(/\/$/, '')}/target/${targetId}` : null;

  const payload = {
    event: kind, incidentId, groupId,
    target: name, host, group: groupName || null,
    status: kind === 'recovered' ? 'UP' : 'DOWN',
    previousStatus: kind === 'recovered' ? 'DOWN' : kind === 'reminder' ? 'DOWN' : 'UP',
    durationSeconds, cause, targetUrl,
    timestamp: new Date().toISOString(),
  };

  const interested = channels.filter((c) => wants(c, payload));
  const paging = interested.filter((c) => PAGING.has(c.type));
  const chat = interested.filter((c) => !PAGING.has(c.type));

  const jobs = paging.map((c) => deliver(c, payload));
  if (chat.length > 0) {
    if (floodGuard()) suppressed.push(payload);
    else jobs.push(...chat.map((c) => deliver(c, payload)));
  }
  await Promise.allSettled(jobs);
}

// Test hooks
function _reset() { recentSends = []; suppressUntil = 0; suppressed = []; if (digestTimer) clearTimeout(digestTimer); digestTimer = null; }

module.exports = { fireStatusChange, sendToChannel, formatMessage, fmtDuration, recordDelivery, endpoints, retry, flood, flushDigest, PAGING, _reset };
