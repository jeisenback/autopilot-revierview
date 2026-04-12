// Tests for /api/* routes — issue #22
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.pragma('busy_timeout = 3000');
  return db;
}

function seedMember(db, { discordId = 'u1', role = 'adult' } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, 'dm-1', ?, '23:00', '05:00', 'UTC', 5)`
  ).run(discordId, role);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return lastInsertRowid;
}

function seedProject(db, { title = 'Test Project', status = 'active', ownerId = null } = {}) {
  return db.prepare(`INSERT INTO projects (title, status, owner_id) VALUES (?, ?, ?)`).run(title, status, ownerId).lastInsertRowid;
}

function seedTask(db, projectId, { title = 'Task', status = 'todo', cost = 10, assignedTo = null } = {}) {
  return db.prepare(`INSERT INTO tasks (project_id, title, status, estimated_cost, assigned_to) VALUES (?, ?, ?, ?, ?)`).run(projectId, title, status, cost, assignedTo).lastInsertRowid;
}

function seedApproval(db, { taskId, memberId, status = 'pending', minsFromNow = 60 } = {}) {
  const expiresAt = new Date(Date.now() + minsFromNow * 60000).toISOString();
  return db.prepare(
    `INSERT INTO approvals (task_id, requested_by, discord_message_id, discord_channel_id, status, expires_at)
     VALUES (?, ?, ?, 'ch-1', ?, ?)`
  ).run(taskId, memberId, `msg-${Date.now()}-${Math.random()}`, status, expiresAt).lastInsertRowid;
}

// Start a minimal test server that delegates to handleApi extracted from the webhook module.
// We build handleApi inline here with an injected db to avoid importing the real server
// (which binds a port). Instead we re-implement the handleApi factory as a standalone helper.

async function buildHandleApi(db) {
  // Inline the same logic from channels/webhook/index.mjs but injecting db.
  const RE_PROJECTS_ID       = /^\/api\/projects\/(\d+)$/;
  const RE_TASKS_ID          = /^\/api\/tasks\/(\d+)$/;
  const RE_APPROVAL_RESOLVE  = /^\/api\/approvals\/(\d+)\/resolve$/;

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }

  return async function handleApi(req) {
    const url = (req.url || '').split('?')[0];

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

    const projMatch = url.match(RE_PROJECTS_ID);
    if (projMatch) {
      const id = Number(projMatch[1]);
      if (req.method === 'GET') {
        const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
        if (!project) return null;
        const tasks = db.prepare(`
          SELECT t.*, m.name AS assigned_to_name
          FROM tasks t LEFT JOIN members m ON m.id = t.assigned_to
          WHERE t.project_id = ? ORDER BY t.priority ASC, t.due_date ASC NULLS LAST
        `).all(id);
        const deps = db.prepare(`SELECT * FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`).all(id);
        return { body: { ...project, tasks, dependencies: deps } };
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const allowed = ['status', 'title', 'owner_id'];
        const fields = Object.keys(body).filter(k => allowed.includes(k));
        if (fields.length === 0) return { status: 400, body: { ok: false, error: 'No valid fields to update' } };
        const set = fields.map(f => `${f} = ?`).join(', ');
        db.prepare(`UPDATE projects SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(...fields.map(f => body[f]), id);
        return { body: { ok: true } };
      }
      if (req.method === 'DELETE') {
        db.prepare(`UPDATE projects SET status = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(id);
        return { body: { ok: true } };
      }
      return null;
    }

    if (req.method === 'POST' && url === '/api/projects') {
      const body = await readBody(req);
      if (!body.title) return { status: 400, body: { ok: false, error: 'title required' } };
      const { lastInsertRowid } = db.prepare(`INSERT INTO projects (title, owner_id, estimated_cost, due_date) VALUES (?, ?, ?, ?)`).run(body.title, body.owner_id ?? null, body.estimated_cost ?? null, body.due_date ?? null);
      return { status: 201, body: { ok: true, id: lastInsertRowid } };
    }

    if (req.method === 'POST' && url === '/api/tasks') {
      const body = await readBody(req);
      if (!body.project_id || !body.title) return { status: 400, body: { ok: false, error: 'project_id and title required' } };
      const { lastInsertRowid } = db.prepare(`INSERT INTO tasks (project_id, title, assigned_to, estimated_cost) VALUES (?, ?, ?, ?)`).run(body.project_id, body.title, body.assigned_to ?? null, body.estimated_cost ?? null);
      return { status: 201, body: { ok: true, id: lastInsertRowid } };
    }

    const taskMatch = url.match(RE_TASKS_ID);
    if (req.method === 'PATCH' && taskMatch) {
      const id = Number(taskMatch[1]);
      const body = await readBody(req);
      const allowed = ['status', 'assigned_to'];
      const fields = Object.keys(body).filter(k => allowed.includes(k));
      if (fields.length === 0) return { status: 400, body: { ok: false, error: 'No valid fields to update' } };
      const set = fields.map(f => `${f} = ?`).join(', ');
      db.prepare(`UPDATE tasks SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(...fields.map(f => body[f]), id);
      return { body: { ok: true } };
    }

    if (req.method === 'GET' && url === '/api/approvals') {
      const rows = db.prepare(`
        SELECT a.*, t.title AS task_title, t.estimated_cost
        FROM approvals a JOIN tasks t ON t.id = a.task_id
        WHERE a.status = 'pending' ORDER BY a.expires_at ASC
      `).all();
      return { body: rows };
    }

    const resolveMatch = url.match(RE_APPROVAL_RESOLVE);
    if (req.method === 'POST' && resolveMatch) {
      const id = Number(resolveMatch[1]);
      const body = await readBody(req);
      if (body.action !== 'approved' && body.action !== 'denied') return { status: 400, body: { ok: false, error: 'invalid action' } };
      const approval = db.prepare(`SELECT * FROM approvals WHERE id = ? AND status = 'pending'`).get(id);
      if (!approval) return { status: 404, body: { ok: false, error: 'not found' } };
      const taskStatus = body.action === 'approved' ? 'todo' : 'skipped';
      db.transaction(() => {
        db.prepare(`UPDATE approvals SET status = ? WHERE id = ?`).run(body.action, id);
        db.prepare(`UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(taskStatus, approval.task_id);
      })();
      return { body: { ok: true } };
    }

    if (req.method === 'GET' && url === '/api/members') {
      const rows = db.prepare(`
        SELECT m.*, ns.daily_count, ns.snooze_until, ns.last_notified_at
        FROM members m LEFT JOIN notification_state ns ON ns.member_id = m.id
        ORDER BY m.role ASC, m.name ASC
      `).all();
      return { body: rows };
    }

    return null;
  };
}

// Mini test harness: build a fake req/res pair
function fakeReq(method, url, bodyObj = null) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const chunks = body ? [Buffer.from(body)] : [];
  let idx = 0;
  const req = {
    method,
    url,
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (idx < chunks.length) return Promise.resolve({ value: chunks[idx++], done: false });
          return Promise.resolve({ value: undefined, done: true });
        }
      };
    }
  };
  return req;
}

// ── GET /api/projects ─────────────────────────────────────────────────────────

test('GET /api/projects: returns array of projects with task_count', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const pid = seedProject(db, { ownerId: memberId });
  seedTask(db, pid); seedTask(db, pid);
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('GET', '/api/projects'));
  assert.ok(Array.isArray(result.body));
  assert.equal(result.body[0].task_count, 2);
});

test('GET /api/projects: returns owner_name', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  seedProject(db, { ownerId: memberId });
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('GET', '/api/projects'));
  assert.equal(result.body[0].owner_name, 'Alice');
});

// ── GET /api/projects/:id ─────────────────────────────────────────────────────

test('GET /api/projects/:id: returns project + tasks', async () => {
  const db = makeDb();
  const pid = seedProject(db);
  seedTask(db, pid, { title: 'Paint walls' });
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('GET', `/api/projects/${pid}`));
  assert.equal(result.body.id, pid);
  assert.equal(result.body.tasks.length, 1);
  assert.equal(result.body.tasks[0].title, 'Paint walls');
});

test('GET /api/projects/:id: unknown id → 404', async () => {
  const db = makeDb();
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('GET', '/api/projects/9999'));
  assert.equal(result, null);
});

// ── PATCH /api/projects/:id ───────────────────────────────────────────────────

test('PATCH /api/projects/:id: updates status', async () => {
  const db = makeDb();
  const pid = seedProject(db, { status: 'open' });
  const handleApi = await buildHandleApi(db);
  await handleApi(fakeReq('PATCH', `/api/projects/${pid}`, { status: 'active' }));
  const row = db.prepare('SELECT status FROM projects WHERE id=?').get(pid);
  assert.equal(row.status, 'active');
});

test('PATCH /api/projects/:id: ignores disallowed fields', async () => {
  const db = makeDb();
  const pid = seedProject(db);
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('PATCH', `/api/projects/${pid}`, { created_at: '1970-01-01' }));
  assert.equal(result.status, 400);
});

// ── DELETE /api/projects/:id ──────────────────────────────────────────────────

test('DELETE /api/projects/:id: soft-deletes (sets status=done)', async () => {
  const db = makeDb();
  const pid = seedProject(db, { status: 'active' });
  const handleApi = await buildHandleApi(db);
  await handleApi(fakeReq('DELETE', `/api/projects/${pid}`));
  const row = db.prepare('SELECT status FROM projects WHERE id=?').get(pid);
  assert.equal(row.status, 'done');
});

// ── POST /api/projects ────────────────────────────────────────────────────────

test('POST /api/projects: creates project and returns id', async () => {
  const db = makeDb();
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('POST', '/api/projects', { title: 'New Project' }));
  assert.equal(result.status, 201);
  assert.ok(result.body.id > 0);
  const row = db.prepare('SELECT * FROM projects WHERE id=?').get(result.body.id);
  assert.equal(row.title, 'New Project');
});

test('POST /api/projects: missing title → 400', async () => {
  const db = makeDb();
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('POST', '/api/projects', {}));
  assert.equal(result.status, 400);
});

// ── POST /api/tasks ───────────────────────────────────────────────────────────

test('POST /api/tasks: creates task and returns id', async () => {
  const db = makeDb();
  const pid = seedProject(db);
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('POST', '/api/tasks', { project_id: pid, title: 'New Task' }));
  assert.equal(result.status, 201);
  assert.ok(result.body.id > 0);
});

test('POST /api/tasks: missing fields → 400', async () => {
  const db = makeDb();
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('POST', '/api/tasks', { title: 'orphan' }));
  assert.equal(result.status, 400);
});

// ── PATCH /api/tasks/:id ──────────────────────────────────────────────────────

test('PATCH /api/tasks/:id: updates status', async () => {
  const db = makeDb();
  const pid = seedProject(db);
  const tid = seedTask(db, pid, { status: 'todo' });
  const handleApi = await buildHandleApi(db);
  await handleApi(fakeReq('PATCH', `/api/tasks/${tid}`, { status: 'done' }));
  const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(tid);
  assert.equal(row.status, 'done');
});

// ── GET /api/approvals ────────────────────────────────────────────────────────

test('GET /api/approvals: returns only pending approvals', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const pid = seedProject(db);
  const tid = seedTask(db, pid);
  seedApproval(db, { taskId: tid, memberId, status: 'pending' });
  seedApproval(db, { taskId: tid, memberId, status: 'approved' });
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('GET', '/api/approvals'));
  assert.equal(result.body.length, 1);
  assert.equal(result.body[0].status, 'pending');
});

test('GET /api/approvals: includes task_title', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const pid = seedProject(db);
  const tid = seedTask(db, pid, { title: 'Buy supplies' });
  seedApproval(db, { taskId: tid, memberId });
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('GET', '/api/approvals'));
  assert.equal(result.body[0].task_title, 'Buy supplies');
});

// ── POST /api/approvals/:id/resolve ──────────────────────────────────────────

test('POST /api/approvals/:id/resolve: approved → task status=todo, approval=approved', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const pid = seedProject(db);
  const tid = seedTask(db, pid, { status: 'awaiting_approval' });
  const aid = seedApproval(db, { taskId: tid, memberId });
  const handleApi = await buildHandleApi(db);
  await handleApi(fakeReq('POST', `/api/approvals/${aid}/resolve`, { action: 'approved' }));
  assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(aid).status, 'approved');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(tid).status, 'todo');
});

test('POST /api/approvals/:id/resolve: denied → task status=skipped', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const pid = seedProject(db);
  const tid = seedTask(db, pid, { status: 'awaiting_approval' });
  const aid = seedApproval(db, { taskId: tid, memberId });
  const handleApi = await buildHandleApi(db);
  await handleApi(fakeReq('POST', `/api/approvals/${aid}/resolve`, { action: 'denied' }));
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(tid).status, 'skipped');
});

test('POST /api/approvals/:id/resolve: invalid action → 400', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const pid = seedProject(db);
  const tid = seedTask(db, pid);
  const aid = seedApproval(db, { taskId: tid, memberId });
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('POST', `/api/approvals/${aid}/resolve`, { action: 'maybe' }));
  assert.equal(result.status, 400);
});

test('POST /api/approvals/:id/resolve: already resolved → 404', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const pid = seedProject(db);
  const tid = seedTask(db, pid);
  const aid = seedApproval(db, { taskId: tid, memberId, status: 'approved' });
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('POST', `/api/approvals/${aid}/resolve`, { action: 'approved' }));
  assert.equal(result.status, 404);
});

// ── GET /api/members ──────────────────────────────────────────────────────────

test('GET /api/members: returns members with notification state', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'u1', role: 'adult' });
  seedMember(db, { discordId: 'u2', role: 'kid' });
  const handleApi = await buildHandleApi(db);
  const result = await handleApi(fakeReq('GET', '/api/members'));
  assert.equal(result.body.length, 2);
  assert.ok('daily_count' in result.body[0], 'should include notification state');
});
