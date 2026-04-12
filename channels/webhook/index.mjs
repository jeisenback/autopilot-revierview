#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { checkHaAuth, createHaEventHandler } from '../../orchestrator/haAdapter.mjs';
import { handle as orchestratorHandle } from '../../orchestrator/index.mjs';
import db from '../../db/db.mjs';
import '../../boot.mjs';

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


// ── API route handler ─────────────────────────────────────────────────────────
// Returns { status, body } or null (404). Throws { status, message } for errors.

const RE_PROJECTS_ID    = /^\/api\/projects\/(\d+)$/;
const RE_TASKS_ID       = /^\/api\/tasks\/(\d+)$/;
const RE_APPROVAL_RESOLVE = /^\/api\/approvals\/(\d+)\/resolve$/;

async function handleApi(req) {
  const url = req.url.split('?')[0]; // strip query string

  // GET /api/projects
  if (req.method === 'GET' && url === '/api/projects') {
    const rows = db.prepare(`
      SELECT p.*, m.name AS owner_name,
        COUNT(t.id) AS task_count,
        SUM(t.estimated_cost) AS total_estimated_cost
      FROM projects p
      LEFT JOIN members m ON m.id = p.owner_id
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id
      ORDER BY p.priority ASC, p.created_at DESC
    `).all();
    return { body: rows };
  }

  // GET /api/projects/:id
  const projMatch = url.match(RE_PROJECTS_ID);
  if (projMatch) {
    const id = Number(projMatch[1]);

    if (req.method === 'GET') {
      const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
      if (!project) return null;
      const tasks = db.prepare(`
        SELECT t.*, m.name AS assigned_to_name
        FROM tasks t
        LEFT JOIN members m ON m.id = t.assigned_to
        WHERE t.project_id = ?
        ORDER BY t.priority ASC, t.due_date ASC NULLS LAST
      `).all(id);
      const deps = db.prepare(`
        SELECT * FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
      `).all(id);
      return { body: { ...project, tasks, dependencies: deps } };
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const allowed = ['status', 'title', 'owner_id'];
      const fields = Object.keys(body).filter(k => allowed.includes(k));
      if (fields.length === 0) return { status: 400, body: { ok: false, error: 'No valid fields to update' } };
      const set = fields.map(f => `${f} = ?`).join(', ');
      const vals = fields.map(f => body[f]);
      db.prepare(`UPDATE projects SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(...vals, id);
      return { body: { ok: true } };
    }

    if (req.method === 'DELETE') {
      db.prepare(`UPDATE projects SET status = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(id);
      return { body: { ok: true } };
    }

    return null;
  }

  // POST /api/projects
  if (req.method === 'POST' && url === '/api/projects') {
    const body = await readBody(req);
    if (!body.title) return { status: 400, body: { ok: false, error: 'title required' } };
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO projects (title, owner_id, estimated_cost, due_date)
      VALUES (?, ?, ?, ?)
    `).run(body.title, body.owner_id ?? null, body.estimated_cost ?? null, body.due_date ?? null);
    return { status: 201, body: { ok: true, id: lastInsertRowid } };
  }

  // POST /api/tasks
  if (req.method === 'POST' && url === '/api/tasks') {
    const body = await readBody(req);
    if (!body.project_id || !body.title) return { status: 400, body: { ok: false, error: 'project_id and title required' } };
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO tasks (project_id, title, assigned_to, estimated_cost)
      VALUES (?, ?, ?, ?)
    `).run(body.project_id, body.title, body.assigned_to ?? null, body.estimated_cost ?? null);
    return { status: 201, body: { ok: true, id: lastInsertRowid } };
  }

  // PATCH /api/tasks/:id
  const taskMatch = url.match(RE_TASKS_ID);
  if (req.method === 'PATCH' && taskMatch) {
    const id = Number(taskMatch[1]);
    const body = await readBody(req);
    const allowed = ['status', 'assigned_to'];
    const fields = Object.keys(body).filter(k => allowed.includes(k));
    if (fields.length === 0) return { status: 400, body: { ok: false, error: 'No valid fields to update' } };
    const set = fields.map(f => `${f} = ?`).join(', ');
    const vals = fields.map(f => body[f]);
    db.prepare(`UPDATE tasks SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(...vals, id);
    return { body: { ok: true } };
  }

  // GET /api/approvals
  if (req.method === 'GET' && url === '/api/approvals') {
    const rows = db.prepare(`
      SELECT a.*, t.title AS task_title, t.estimated_cost
      FROM approvals a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'pending'
      ORDER BY a.expires_at ASC
    `).all();
    return { body: rows };
  }

  // POST /api/approvals/:id/resolve
  const resolveMatch = url.match(RE_APPROVAL_RESOLVE);
  if (req.method === 'POST' && resolveMatch) {
    const id = Number(resolveMatch[1]);
    const body = await readBody(req);
    if (body.action !== 'approved' && body.action !== 'denied') {
      return { status: 400, body: { ok: false, error: 'action must be "approved" or "denied"' } };
    }
    const approval = db.prepare(`SELECT * FROM approvals WHERE id = ? AND status = 'pending'`).get(id);
    if (!approval) return { status: 404, body: { ok: false, error: 'Approval not found or already resolved' } };

    const taskStatus = body.action === 'approved' ? 'todo' : 'skipped';
    db.transaction(() => {
      db.prepare(`UPDATE approvals SET status = ? WHERE id = ?`).run(body.action, id);
      db.prepare(`UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(taskStatus, approval.task_id);
    })();
    return { body: { ok: true } };
  }

  // GET /api/members
  if (req.method === 'GET' && url === '/api/members') {
    const rows = db.prepare(`
      SELECT m.*, ns.daily_count, ns.snooze_until, ns.last_notified_at
      FROM members m
      LEFT JOIN notification_state ns ON ns.member_id = m.id
      ORDER BY m.role ASC, m.name ASC
    `).all();
    return { body: rows };
  }

  return null; // 404
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, service: 'webhook-channel', port: PORT });
    return;
  }

  // ── /api/* routes ────────────────────────────────────────────────────────────

  if (req.url.startsWith('/api/')) {
    try {
      const result = await handleApi(req);
      if (result === null) {
        json(res, 404, { ok: false, error: 'not found' });
      } else {
        json(res, result.status ?? 200, result.body);
      }
    } catch (err) {
      json(res, err.status ?? 500, { ok: false, error: err.message || String(err) });
    }
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

      // Ack immediately — never block waiting for orchestrator (eng review async dispatch)
      json(res, 200, { ok: true, receivedAt: stamp });

      // Reactions are fire-and-forget (no callbackUrl); regular messages reply via callbackUrl.
      orchestratorHandle(body)
        .then(replyText => {
          if (body.callbackUrl && body.requestId) {
            return postJson(body.callbackUrl, { requestId: body.requestId, response: replyText });
          }
        })
        .catch(async err => {
          process.stderr.write(`orchestrator failed: ${err}\n`);
          if (body.callbackUrl && body.requestId) {
            await postJson(body.callbackUrl, {
              requestId: body.requestId,
              response: `Error: ${err.message || err}`
            }).catch(() => {});
          }
        });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/ha-events') {
    const HA_WEBHOOK_SECRET = (process.env.HA_WEBHOOK_SECRET || '').trim();
    const auth = checkHaAuth(HA_WEBHOOK_SECRET, req.headers.authorization || '');
    if (auth.status !== 200) {
      json(res, auth.status, { ok: false, error: 'unauthorized' });
      return;
    }
    try {
      const payload = await readBody(req);
      json(res, 200, { ok: true });
      const handler = createHaEventHandler({ db });
      handler(payload).catch(err => {
        process.stderr.write(`ha-events handler error: ${err.message}\n`);
      });
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
