#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const sep = trimmed.indexOf('=');
      if (sep === -1) continue;
      const key = trimmed.slice(0, sep).trim();
      if (!key || process.env[key] !== undefined) continue;
      let value = trimmed.slice(sep + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`webhook: failed to load .env: ${err}`);
  }
}

// Load repo root .env first (lower priority), then local .env (higher priority)
loadEnv(path.resolve(SCRIPT_DIR, '..', '..', '.env'));
loadEnv(path.resolve(SCRIPT_DIR, '.env'));

const PORT = Number(process.env.PORT || 8910);
const AUTO_REPLY = /^(1|true|on|yes)$/i.test(process.env.WEBHOOK_AUTO_REPLY || 'false');
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL_ID = (process.env.DISCORD_RESPONDER_MODEL || 'claude-sonnet-4-6').trim();
const SYSTEM_PROMPT = (
  process.env.DISCORD_RESPONDER_SYSTEM_PROMPT ||
  'You are an assistant for the autopilot-riverview project. Answer directly, briefly, and helpfully.'
).trim();
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateReply(body) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: body.content || '(empty message)' }]
      }),
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || '(no response)';
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, service: 'webhook-channel', port: PORT, autoReply: AUTO_REPLY });
    return;
  }

  if (req.method === 'POST' && req.url === '/feature') {
    try {
      const body = await readBody(req);
      const stamp = new Date().toISOString();

      // Log the incoming message
      const line = JSON.stringify({
        ts: stamp,
        project: body.project || 'default',
        author: body.author || null,
        channelId: body.channelId || null,
        channelName: body.channelName || null,
        content: body.content || '',
        requestId: body.requestId || null
      });
      process.stdout.write(`${line}\n`);

      json(res, 200, { ok: true, receivedAt: stamp });

      // Auto-reply via callback if enabled
      if (AUTO_REPLY && body.callbackUrl && body.requestId) {
        generateReply(body)
          .then(replyText =>
            postJson(body.callbackUrl, { requestId: body.requestId, response: replyText })
          )
          .catch(async err => {
            process.stderr.write(`auto-reply failed: ${err}\n`);
            await postJson(body.callbackUrl, {
              requestId: body.requestId,
              response: `Error: ${err.message || err}`
            }).catch(() => {});
          });
      }
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
});

function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const match = out.match(/LISTENING\s+(\d+)/);
      if (match) {
        execSync(`powershell -Command "Stop-Process -Id ${match[1]} -Force"`, { stdio: 'pipe' });
        return true;
      }
    } else {
      execSync(`fuser -k ${port}/tcp`, { stdio: 'pipe' });
      return true;
    }
  } catch {
    // process may have already exited
  }
  return false;
}

function startListening(isRetry = false) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`webhook-channel: listening on http://127.0.0.1:${PORT} autoReply=${AUTO_REPLY}`);
  });
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE' && !server._healed) {
    server._healed = true;
    console.warn(`webhook-channel: port ${PORT} in use — killing stale listener...`);
    killProcessOnPort(PORT);
    setTimeout(() => startListening(), 500);
  } else {
    console.error('webhook-channel: fatal error', err);
    process.exit(1);
  }
});

startListening();
