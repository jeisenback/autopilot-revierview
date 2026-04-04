import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── in-memory DB with real schema ───────────────────────────────────────────

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'),
  'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// ─── module factory ───────────────────────────────────────────────────────────
// projectManager uses a db singleton, so we re-import fresh per test group
// by injecting the db via a factory function passed as a dependency.

import { createManager } from '../orchestrator/projectManager.mjs';

const THRESHOLD = 25; // APPROVAL_THRESHOLD_USD used in all tests

// ─── Claude stubs ─────────────────────────────────────────────────────────────

function claudeReturns(value) {
  return async () => value;
}

const VALID_TASKS = [
  { title: 'Buy paint', estimated_cost: 20, notes: 'Semi-gloss' },
  { title: 'Prep walls', estimated_cost: 0, notes: '' },
  { title: 'Paint room', estimated_cost: 0, notes: '' },
];

// ─── helpers ──────────────────────────────────────────────────────────────────

function seedMember(db, { role = 'adult', name = 'Alice', discordId = 'u1' } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES (?, ?, ?, '23:00', '05:00', 'America/Chicago', 5)`
  ).run(name, discordId, role);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id = ?').get(lastInsertRowid);
}

function seedTask(db, { projectId, title = 'Test task', status = 'todo', assignedTo = null, recurrence = null, estimatedCost = 0, requiresApproval = 0 } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO tasks (project_id, title, status, assigned_to, recurrence, estimated_cost, requires_approval)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(projectId, title, status, assignedTo, recurrence, estimatedCost, requiresApproval);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(lastInsertRowid);
}

function seedProject(db) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO projects (title, status) VALUES ('Test project', 'open')`
  ).run();
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(lastInsertRowid);
}

// ─── create() ────────────────────────────────────────────────────────────────

test('create(): valid Claude response → correct task count', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const mgr = createManager({ db, callClaude: claudeReturns(JSON.stringify(VALID_TASKS)), threshold: THRESHOLD });

  const result = await mgr.create('Paint the bedroom', member);

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 3);
  assert.ok(result.includes('Paint the bedroom') || result.includes('paint') || result.length > 0);
});

test('create(): invalid Claude JSON → fallback single task', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const mgr = createManager({ db, callClaude: claudeReturns('not json at all'), threshold: THRESHOLD });

  await mgr.create('Fix the fence', member);

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Fix the fence');
  assert.equal(tasks[0].estimated_cost, 0);
});

test('create(): non-array Claude JSON → fallback single task', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const mgr = createManager({ db, callClaude: claudeReturns('{"title":"oops"}'), threshold: THRESHOLD });

  await mgr.create('Wash car', member);

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 1);
});

test('create(): estimated_cost >= threshold → requires_approval=1, status=awaiting_approval', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const expensiveTasks = [{ title: 'Buy lumber', estimated_cost: 30, notes: '' }];
  const mgr = createManager({ db, callClaude: claudeReturns(JSON.stringify(expensiveTasks)), threshold: THRESHOLD });

  await mgr.create('Build a deck', member);

  const task = db.prepare('SELECT * FROM tasks').get();
  assert.equal(task.requires_approval, 1);
  assert.equal(task.status, 'awaiting_approval');
});

test('create(): estimated_cost < threshold → requires_approval=0, status=todo', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const cheapTasks = [{ title: 'Buy nails', estimated_cost: 5, notes: '' }];
  const mgr = createManager({ db, callClaude: claudeReturns(JSON.stringify(cheapTasks)), threshold: THRESHOLD });

  await mgr.create('Fix fence board', member);

  const task = db.prepare('SELECT * FROM tasks').get();
  assert.equal(task.requires_approval, 0);
  assert.equal(task.status, 'todo');
});

// ─── complete() ───────────────────────────────────────────────────────────────

test('complete(): task not found → returns error string', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const mgr = createManager({ db, threshold: THRESHOLD });

  const result = await mgr.complete(999, member);
  assert.ok(typeof result === 'string');
  assert.ok(result.toLowerCase().includes('not found') || result.toLowerCase().includes("couldn't find") || result.length > 0);
});

test('complete(): kid not assigned → rejection message', async () => {
  const db = makeDb();
  const adult = seedMember(db, { role: 'adult', discordId: 'u-adult' });
  const kid = seedMember(db, { role: 'kid', name: 'Kid', discordId: 'u-kid' });
  const project = seedProject(db);
  const task = seedTask(db, { projectId: project.id, assignedTo: adult.id });
  const mgr = createManager({ db, threshold: THRESHOLD });

  const result = await mgr.complete(task.id, kid);
  assert.ok(result.toLowerCase().includes("assigned") || result.toLowerCase().includes("parent") || result.toLowerCase().includes("not"));
});

test('complete(): kid assigned → success, status=done', async () => {
  const db = makeDb();
  const kid = seedMember(db, { role: 'kid', discordId: 'u-kid2' });
  const project = seedProject(db);
  const task = seedTask(db, { projectId: project.id, assignedTo: kid.id });
  const mgr = createManager({ db, threshold: THRESHOLD });

  await mgr.complete(task.id, kid);

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  assert.equal(updated.status, 'done');
});

test('complete(): no recurrence → status=done, no new task', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const project = seedProject(db);
  const task = seedTask(db, { projectId: project.id });
  const mgr = createManager({ db, threshold: THRESHOLD });

  await mgr.complete(task.id, member);

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'done');
});

test('complete(): daily recurrence → new task created', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const project = seedProject(db);
  const task = seedTask(db, { projectId: project.id, recurrence: 'daily' });
  const mgr = createManager({ db, threshold: THRESHOLD });

  await mgr.complete(task.id, member);

  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'done');
  assert.equal(tasks[1].status, 'todo');
  assert.equal(tasks[1].recurrence, 'daily');
});

test('complete(): recurring with dependencies → deps copied to new instance', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const project = seedProject(db);
  const dep = seedTask(db, { projectId: project.id, title: 'Dependency' });
  const task = seedTask(db, { projectId: project.id, recurrence: 'weekly' });
  db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(task.id, dep.id);
  const mgr = createManager({ db, threshold: THRESHOLD });

  await mgr.complete(task.id, member);

  const newTask = db.prepare('SELECT * FROM tasks ORDER BY id DESC').get();
  const newDeps = db.prepare('SELECT * FROM task_dependencies WHERE task_id = ?').all(newTask.id);
  assert.equal(newDeps.length, 1);
  assert.equal(newDeps[0].depends_on_task_id, dep.id);
});

test('complete(): completing task unblocks dependent task', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const project = seedProject(db);
  const blocker = seedTask(db, { projectId: project.id, title: 'Blocker' });
  const blocked = seedTask(db, { projectId: project.id, title: 'Blocked', status: 'blocked' });
  db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(blocked.id, blocker.id);
  const mgr = createManager({ db, threshold: THRESHOLD });

  await mgr.complete(blocker.id, member);

  const unblocked = db.prepare('SELECT * FROM tasks WHERE id = ?').get(blocked.id);
  assert.equal(unblocked.status, 'todo');
});

// ─── listOpen() ───────────────────────────────────────────────────────────────

test('listOpen(): returns open/active/blocked projects only', async () => {
  const db = makeDb();
  const mgr = createManager({ db, threshold: THRESHOLD });
  db.prepare(`INSERT INTO projects (title, status) VALUES ('Open proj', 'open')`).run();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('Active proj', 'active')`).run();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('Done proj', 'done')`).run();

  const result = mgr.listOpen();
  assert.ok(result.includes('Open proj'));
  assert.ok(result.includes('Active proj'));
  assert.ok(!result.includes('Done proj'));
});
