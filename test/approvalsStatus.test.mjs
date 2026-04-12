// Tests for /approvals list and /status commands — issue #16
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApprovalManager } from '../orchestrator/approvalManager.mjs';
import { createProjectManager } from '../orchestrator/projectManager.mjs';
import { createRouter } from '../orchestrator/commandRouter.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedMember(db, { discordId = 'u1', role = 'adult' } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, 'dm-1', ?, '23:00', '05:00', 'UTC', 5)`
  ).run(discordId, role);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

function seedPendingApproval(db, { title = 'Buy supplies', cost = 50, minsFromNow = 60 } = {}) {
  const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('P', 'active')`).run().lastInsertRowid;
  const taskId = db.prepare(
    `INSERT INTO tasks (project_id, title, estimated_cost, status, requires_approval) VALUES (?, ?, ?, 'awaiting_approval', 1)`
  ).run(projectId, title, cost).lastInsertRowid;
  const memberId = db.prepare(`SELECT id FROM members LIMIT 1`).get()?.id ?? 1;
  const expiresAt = new Date(Date.now() + minsFromNow * 60000).toISOString();
  db.prepare(
    `INSERT INTO approvals (task_id, requested_by, discord_message_id, discord_channel_id, status, expires_at)
     VALUES (?, ?, ?, 'ch-1', 'pending', ?)`
  ).run(taskId, memberId, `msg-${Date.now()}-${Math.random()}`, expiresAt);
  return taskId;
}

// ─── listPending() ────────────────────────────────────────────────────────────

test('listPending(): no pending approvals → "No pending approvals."', () => {
  const db = makeDb();
  seedMember(db);
  const mgr = createApprovalManager({ db });
  assert.equal(mgr.listPending(), 'No pending approvals.');
});

test('listPending(): returns numbered list with title, cost, expiry', () => {
  const db = makeDb();
  seedMember(db);
  seedPendingApproval(db, { title: 'Buy lumber', cost: 75, minsFromNow: 90 });
  const mgr = createApprovalManager({ db });
  const result = mgr.listPending();
  assert.ok(result.includes('1.'), 'should be numbered');
  assert.ok(result.includes('Buy lumber'), 'should include task title');
  assert.ok(result.includes('$75'), 'should include cost');
  assert.ok(result.includes('m'), 'should include minutes');
});

test('listPending(): multiple items sorted by soonest expiry first', () => {
  const db = makeDb();
  seedMember(db);
  seedPendingApproval(db, { title: 'Task A', minsFromNow: 120 });
  seedPendingApproval(db, { title: 'Task B', minsFromNow: 30 });
  const mgr = createApprovalManager({ db });
  const result = mgr.listPending();
  const idxA = result.indexOf('Task A');
  const idxB = result.indexOf('Task B');
  assert.ok(idxB < idxA, 'sooner expiry (Task B) should appear first');
});

// ─── /approvals list — role guard ─────────────────────────────────────────────

test('/approvals list by kid → role rejection', async () => {
  const db = makeDb();
  const kid = seedMember(db, { discordId: 'kid1', role: 'kid' });
  const am = createApprovalManager({ db });
  const router = createRouter({
    approvalManager: am,
    projectManager: { assign: async () => {}, create: async () => '', complete: async () => '', listOpen: () => '', statusSummary: () => '' },
    suppressionModel: { snooze: () => {} },
    responseFormatter: { formatWithClaude: async () => '' },
  });

  const result = await router.dispatch({ intent: 'command', command: 'list_approvals' }, kid, {});
  assert.ok(result.includes('parent'), 'kid should be told to ask a parent');
});

// ─── statusSummary() ──────────────────────────────────────────────────────────

test('statusSummary(): shows project counts', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('P1', 'active')`).run();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('P2', 'open')`).run();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('P3', 'done')`).run();
  const pm = createProjectManager({ db, postMessage: async () => {}, callClaude: async () => '[]' });
  const result = pm.statusSummary(0);
  assert.ok(result.includes('active') || result.includes('open'), 'should show open project statuses');
  assert.ok(!result.includes('done'), 'done projects should be excluded');
});

test('statusSummary(): shows overdue and due-today task counts', () => {
  const db = makeDb();
  const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('P', 'active')`).run().lastInsertRowid;
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  db.prepare(`INSERT INTO tasks (project_id, title, status, due_date) VALUES (?, 'overdue task', 'todo', ?)`).run(projectId, yesterday);
  db.prepare(`INSERT INTO tasks (project_id, title, status, due_date) VALUES (?, 'today task', 'todo', ?)`).run(projectId, today);
  const pm = createProjectManager({ db, postMessage: async () => {}, callClaude: async () => '[]' });
  const result = pm.statusSummary(0);
  assert.ok(result.includes('overdue'), 'should mention overdue');
  assert.ok(result.includes('today'), 'should mention due today');
});

test('statusSummary(): shows pending approvals count from argument', () => {
  const db = makeDb();
  const pm = createProjectManager({ db, postMessage: async () => {}, callClaude: async () => '[]' });
  const result = pm.statusSummary(3);
  assert.ok(result.includes('3'), 'should show pending approval count');
});

test('statusSummary(): shows next briefing time', () => {
  const db = makeDb();
  const pm = createProjectManager({ db, postMessage: async () => {}, callClaude: async () => '[]' });
  const result = pm.statusSummary(0);
  assert.ok(result.toLowerCase().includes('briefing'), 'should mention next briefing');
});

// ─── /status fast-path parse ──────────────────────────────────────────────────

test('/status intent parses to status command', async () => {
  const { createIntentParser } = await import('../orchestrator/intentParser.mjs');
  const { parseIntent } = createIntentParser({ callClaude: async () => '{}' });
  const r = await parseIntent('/status');
  assert.equal(r.command, 'status');
});

test('/approvals list intent parses to list_approvals command', async () => {
  const { createIntentParser } = await import('../orchestrator/intentParser.mjs');
  const { parseIntent } = createIntentParser({ callClaude: async () => '{}' });
  const r = await parseIntent('/approvals list');
  assert.equal(r.command, 'list_approvals');
});
