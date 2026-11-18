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

function formatMessage({ event, target, host, group, status, previousStatus, targetUrl, durationSeconds, cause, digest }) {
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

function postJson(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }

    const data = JSON.stringify(body);
    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Meridian/1.0',
        ...extraHeaders,
      },
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      res.resume();
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${parsed.hostname}`));
      resolve({ status: res.statusCode });
    });

    req.setTimeout(10_000, () => req.destroy(new Error(`Timeout: ${parsed.hostname}`)));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendToChannel(channel, payload) {
  const msg = formatMessage(payload);
  const isRecovery = payload.event === 'recovered' || (!payload.event && payload.status === 'UP');

  switch (channel.type) {
    case 'slack':
      return postJson(channel.url, { text: msg, username: 'Meridian', icon_emoji: ':satellite_antenna:' });

    case 'discord':
      return postJson(channel.url, { content: msg, username: 'Meridian' });

    case 'ntfy': {
      if (payload.event === 'digest') {
        return postJson(channel.url, { title: 'Meridian: alert digest', message: msg, priority: 4, tags: ['warning'] });
      }
      const title = isRecovery
        ? `${payload.target} recovered`
        : payload.event === 'reminder' ? `${payload.target} still DOWN` : `${payload.target} is ${payload.status}`;
      const body = {
        title,
        message: msg.split('\n')[0].replace(/^\S+\s/, ''),
        priority: isRecovery ? 3 : 5,
        tags: [isRecovery ? 'white_check_mark' : 'red_circle'],
      };
      if (payload.targetUrl) body.click = payload.targetUrl;
      return postJson(channel.url, body);
    }

    case 'telegram': {
      const match = channel.url.match(/^tgram:\/\/([^/]+)\/(.+)$/);
      if (!match) throw new Error('Invalid Telegram URL — expected tgram://TOKEN/CHATID');
      const [, token, chatId] = match;
      return postJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: msg });
    }

    case 'webhook':
    default:
      return postJson(channel.url, {
        event: payload.event || (isRecovery ? 'recovered' : 'down'),
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

// ── Flood protection ────────────────────────────────────────────────────────
// If more than FLOOD_THRESHOLD alerts fire within FLOOD_WINDOW_MS (a mass outage or mass
// recovery), stop sending them individually. Suppressed events are collected and sent as
// a single digest when the cooldown ends, so nothing is silently lost.
const FLOOD_WINDOW_MS = 60_000;
const FLOOD_THRESHOLD = 5;
const FLOOD_COOLDOWN_MS = 5 * 60_000;

const recentSends = [];
let suppressUntil = 0;
let suppressed = [];
let digestTimer = null;

function floodGuard(now = Date.now()) {
  if (now < suppressUntil) return true;
  while (recentSends.length > 0 && recentSends[0] < now - FLOOD_WINDOW_MS) recentSends.shift();
  recentSends.push(now);
  if (recentSends.length > FLOOD_THRESHOLD) {
    suppressUntil = now + FLOOD_COOLDOWN_MS;
    console.warn(`[notifier] flood protection engaged — batching alerts for ${FLOOD_COOLDOWN_MS / 60_000} min`);
    digestTimer = setTimeout(flushDigest, FLOOD_COOLDOWN_MS + 1000);
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
  const down = events.filter((e) => e.event !== 'recovered');
  const rec = events.filter((e) => e.event === 'recovered');
  const names = (list) => list.slice(0, 10).map((e) => e.target).join(', ') + (list.length > 10 ? `, +${list.length - 10} more` : '');
  const lines = [`⚠️ ${events.length} alerts were batched during an alert flood:`];
  if (down.length) lines.push(`🔴 ${down.length} down: ${names(down)}`);
  if (rec.length) lines.push(`✅ ${rec.length} recovered: ${names(rec)}`);
  await sendAll({ event: 'digest', digest: lines.join('\n'), target: 'Meridian', host: '', status: 'DIGEST', timestamp: new Date().toISOString() });
}

async function sendAll(payload) {
  let channels;
  try {
    channels = getDb().prepare('SELECT * FROM notification_channels WHERE enabled = 1').all();
  } catch {
    return;
  }
  if (!channels || channels.length === 0) return;
  const results = await Promise.allSettled(channels.map((ch) => sendToChannel(ch, payload)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`[notifier] channel "${channels[i].name}" failed: ${r.reason?.message}`);
  });
}

/**
 * Dispatch an incident event.
 * kind: 'down' | 'recovered' | 'reminder'
 */
async function fireStatusChange({ kind, targetId, name, host, groupName, incidentId, durationSeconds, cause }) {
  let hasChannels = false;
  try { hasChannels = getDb().prepare('SELECT 1 FROM notification_channels WHERE enabled = 1 LIMIT 1').get() != null; }
  catch { return; } // table not yet created (pre-migration install)
  if (!hasChannels) return;

  const baseUrl = loadSettings().public_base_url;
  const targetUrl = (baseUrl && targetId) ? `${baseUrl.replace(/\/$/, '')}/target/${targetId}` : null;

  const payload = {
    event: kind,
    incidentId,
    target: name,
    host,
    group: groupName || null,
    status: kind === 'recovered' ? 'UP' : 'DOWN',
    previousStatus: kind === 'recovered' ? 'DOWN' : kind === 'reminder' ? 'DOWN' : 'UP',
    durationSeconds,
    cause,
    targetUrl,
    timestamp: new Date().toISOString(),
  };

  if (floodGuard()) {
    suppressed.push(payload);
    return;
  }
  await sendAll(payload);
}

module.exports = { fireStatusChange, sendToChannel, formatMessage, fmtDuration };
