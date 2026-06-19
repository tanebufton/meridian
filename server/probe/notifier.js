'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/db');

function formatMessage({ target, host, group, status, previousStatus, targetUrl }) {
  const icon = status === 'UP' ? '✅' : '🔴';
  const verb = status === 'UP' ? 'recovered' : `is ${status}`;
  const loc = group ? ` (${group})` : '';
  let msg = `${icon} ${target} ${verb} — ${host}${loc} [${previousStatus} → ${status}]`;
  if (targetUrl) msg += `\n${targetUrl}`;
  return msg;
}

function readBaseUrl() {
  const settingsFile = path.resolve(
    process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data',
    'settings.json'
  );
  try {
    if (fs.existsSync(settingsFile)) {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return s.public_base_url || null;
    }
  } catch { /* ignore */ }
  return null;
}

function postJson(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

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

  switch (channel.type) {
    case 'slack':
      return postJson(channel.url, { text: msg, username: 'Meridian', icon_emoji: ':satellite_antenna:' });

    case 'discord':
      return postJson(channel.url, { content: msg, username: 'Meridian' });

    case 'ntfy': {
      const isRecovery = payload.status === 'UP';
      const body = {
        title: isRecovery ? `${payload.target} recovered` : `${payload.target} is ${payload.status}`,
        message: `${payload.host}${payload.group ? ` (${payload.group})` : ''} — ${payload.previousStatus} → ${payload.status}`,
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
      return postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: msg,
      });
    }

    case 'webhook':
    default:
      return postJson(channel.url, {
        target: payload.target,
        host: payload.host,
        group: payload.group,
        status: payload.status,
        previous_status: payload.previousStatus,
        message: msg,
        target_url: payload.targetUrl || null,
        timestamp: payload.timestamp,
      });
  }
}

async function fireStatusChange({ targetId, name, host, groupName, prevStatus, newStatus }) {
  let channels;
  try {
    const db = getDb();
    channels = db.prepare('SELECT * FROM notification_channels WHERE enabled = 1').all();
  } catch {
    return; // Table not yet created (pre-migration install)
  }

  if (!channels || channels.length === 0) return;
  if (isFlooding()) return;

  const baseUrl = readBaseUrl();
  const targetUrl = (baseUrl && targetId) ? `${baseUrl.replace(/\/$/, '')}/target/${targetId}` : null;

  const payload = {
    target: name,
    host,
    group: groupName || null,
    status: newStatus,
    previousStatus: prevStatus,
    targetUrl,
    timestamp: new Date().toISOString(),
  };

  await Promise.allSettled(channels.map((ch) => sendToChannel(ch, payload)));
}

// Flood guard — if more than FLOOD_THRESHOLD notifications fire within FLOOD_WINDOW_MS
// (e.g. mass outage or mass recovery), suppress further ones for FLOOD_COOLDOWN_MS.
const FLOOD_WINDOW_MS = 60_000;
const FLOOD_THRESHOLD = 5;
const FLOOD_COOLDOWN_MS = 5 * 60_000;

const recentSends = [];
let suppressUntil = 0;

function isFlooding() {
  const now = Date.now();
  if (now < suppressUntil) return true;

  while (recentSends.length > 0 && recentSends[0] < now - FLOOD_WINDOW_MS) recentSends.shift();

  recentSends.push(now);
  if (recentSends.length > FLOOD_THRESHOLD) {
    suppressUntil = now + FLOOD_COOLDOWN_MS;
    console.warn(`[notifier] flood protection engaged — notifications suppressed for ${FLOOD_COOLDOWN_MS / 60_000} min`);
    return true;
  }
  return false;
}

module.exports = { fireStatusChange, sendToChannel, formatMessage };
