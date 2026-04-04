#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as orchestrator from '../../orchestrator/index.mjs';

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

      // Ack immediately — do NOT await orchestrator (blocks new requests while Claude runs)
      json(res, 200, { ok: true, receivedAt: stamp });

      if (body.callbackUrl && body.requestId) {
        orchestrator.handle(body)
          .then(text => postJson(body.callbackUrl, { requestId: body.requestId, response: text }))
          .catch(err => {
            process.stderr.write(`orchestrator error: ${err}\n`);
            return postJson(body.callbackUrl, { requestId: body.requestId, response: `Error: ${err.message}` });
          });
      }
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return;
  }

  // HA webhook — auth and full handling in issue #13
  if (req.method === 'POST' && req.url === '/ha-events') {
    try {
      const body = await readBody(req);
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), source: 'ha', payload: body })}\n`);
      json(res, 200, { ok: true });
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
