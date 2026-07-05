#!/usr/bin/env node
/**
 * Crivacy Telegram Alert Bot.
 *
 * A lightweight HTTP server that receives Alertmanager webhook payloads
 * and forwards formatted alert messages to Telegram. Extends Alertmanager's
 * native telegram_configs with:
 *
 *   - On-call rotation: routes critical alerts to the on-call person's
 *     chat/DM in addition to the team channel.
 *   - Status page integration: POSTs to the Crivacy admin API to create
 *     incidents when critical alerts fire (optional, via STATUS_API_URL).
 *   - Ack/silence commands via Telegram bot commands (future).
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN  — Bot API token (from @BotFather)
 *   TELEGRAM_CHAT_ID    — Team channel/group chat ID
 *   ONCALL_CHAT_ID      — On-call person's DM chat ID (optional)
 *   BOT_PORT            — HTTP listen port (default: 9095)
 *   STATUS_API_URL      — Crivacy admin API base URL (optional)
 *   STATUS_API_TOKEN     — Admin JWT for status page auto-update (optional)
 *
 * Alertmanager config:
 *   receivers:
 *     - name: 'telegram-bot'
 *       webhook_configs:
 *         - url: 'http://telegram-alert-bot:9095/webhook'
 *           send_resolved: true
 *
 * @module
 */

import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const ONCALL_CHAT_ID = process.env.ONCALL_CHAT_ID ?? '';
const BOT_PORT = Number.parseInt(process.env.BOT_PORT ?? '9095', 10);
const STATUS_API_URL = process.env.STATUS_API_URL ?? '';
const STATUS_API_TOKEN = process.env.STATUS_API_TOKEN ?? '';

if (TELEGRAM_BOT_TOKEN === '') {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}
if (TELEGRAM_CHAT_ID === '') {
  console.error('TELEGRAM_CHAT_ID is required');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ---------------------------------------------------------------------------
// Telegram send
// ---------------------------------------------------------------------------

/**
 * @param {string} chatId
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function sendTelegramMessage(chatId, text) {
  try {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`Telegram API error: ${response.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram send failed:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Alert formatting
// ---------------------------------------------------------------------------

/**
 * @param {object} alertmanagerPayload
 * @returns {string}
 */
function formatAlertMessage(alertmanagerPayload) {
  const { status, alerts, commonLabels, groupLabels } = alertmanagerPayload;
  const isFiring = status === 'firing';
  const emoji = isFiring ? '\u{1F6A8}' : '\u{2705}'; // 🚨 or ✅
  const statusText = isFiring ? 'FIRING' : 'RESOLVED';

  const alertName = commonLabels?.alertname ?? groupLabels?.alertname ?? 'Unknown';
  const severity = commonLabels?.severity ?? 'unknown';
  const component = commonLabels?.component ?? '';

  const lines = [
    `${emoji} <b>${statusText}</b> — ${escapeHtml(alertName)}`,
    `<b>Severity:</b> ${escapeHtml(severity)}`,
  ];

  if (component !== '') {
    lines.push(`<b>Component:</b> ${escapeHtml(component)}`);
  }

  lines.push('');

  if (Array.isArray(alerts)) {
    for (const alert of alerts.slice(0, 5)) {
      const summary = alert.annotations?.summary ?? '';
      const description = alert.annotations?.description ?? '';
      const runbook = alert.annotations?.runbook_url ?? '';
      const startsAt = alert.startsAt ?? '';

      if (summary !== '') lines.push(`<b>Summary:</b> ${escapeHtml(summary)}`);
      if (description !== '') lines.push(escapeHtml(description));
      if (startsAt !== '') lines.push(`<b>Since:</b> ${escapeHtml(formatTime(startsAt))}`);
      if (runbook !== '') lines.push(`<b>Runbook:</b> ${escapeHtml(runbook)}`);
      lines.push('---');
    }

    if (alerts.length > 5) {
      lines.push(`<i>... and ${alerts.length - 5} more alerts</i>`);
    }
  }

  return lines.join('\n');
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {string} isoStr
 * @returns {string}
 */
function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return isoStr;
  }
}

// ---------------------------------------------------------------------------
// Status page integration (optional)
// ---------------------------------------------------------------------------

/**
 * Auto-create a status incident when a critical alert fires.
 * @param {object} alertmanagerPayload
 */
async function createStatusIncident(alertmanagerPayload) {
  if (STATUS_API_URL === '' || STATUS_API_TOKEN === '') return;
  if (alertmanagerPayload.status !== 'firing') return;

  const severity = alertmanagerPayload.commonLabels?.severity;
  if (severity !== 'critical') return;

  const alertName = alertmanagerPayload.commonLabels?.alertname ?? 'Unknown Alert';
  const summary =
    alertmanagerPayload.alerts?.[0]?.annotations?.summary ?? 'A critical alert has fired.';

  try {
    const response = await fetch(`${STATUS_API_URL}/api/internal/admin/status/incidents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${STATUS_API_TOKEN}`,
      },
      body: JSON.stringify({
        title: `[Auto] ${alertName}`,
        body: summary,
        severity: 'major',
        status: 'investigating',
        componentIds: [],
      }),
    });

    if (!response.ok) {
      console.error(`Status API error: ${response.status}`);
    } else {
      console.log(`Status incident created for: ${alertName}`);
    }
  } catch (err) {
    console.error('Status incident creation failed:', err);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Alertmanager webhook
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_048_576) {
        res.writeHead(413);
        res.end('Payload too large');
        return;
      }
    }

    /** @type {object} */
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const message = formatAlertMessage(payload);

    // Send to team channel
    const sent = await sendTelegramMessage(TELEGRAM_CHAT_ID, message);

    // Send to on-call DM if critical
    if (ONCALL_CHAT_ID !== '' && payload.commonLabels?.severity === 'critical') {
      await sendTelegramMessage(ONCALL_CHAT_ID, message);
    }

    // Auto-create status incident
    await createStatusIncident(payload);

    res.writeHead(sent ? 200 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: sent }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(BOT_PORT, '127.0.0.1', () => {
  console.log(`Telegram alert bot listening on 127.0.0.1:${BOT_PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});
