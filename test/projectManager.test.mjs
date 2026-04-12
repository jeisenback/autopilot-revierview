import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProjectManager } from '../orchestrator/projectManager.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedMember(db, { discordId = 'u1', role = 'adult', channelId = 'dm-1' } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, ?, ?, '23:00', '05:00', 'America/Chicago', 5)`
  ).run(discordId, channelId, role);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

function fakeClaude(response) {
  return async () => response;
}

// ─── create() ────────────────────────────────────────────────────────────────

test('create(): valid Claude response → correct task count', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const tasks = [
    { title: 'Buy paint', estimated_cost: 15, notes: '' },
    { title: 'Sand walls', estimated_cost: 0, notes: '' },
    { title: 'Apply primer', estimated_cost: 10, notes: '' },
  ];
  const pm = createProjectManager({ db, callClaude: fakeClaude(JSON.stringify(tasks)), postMessage: async () => {} });

  await pm.create('Paint bedroom', member);

  const created = db.prepare(`SELECT * FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE title='Paint bedroom')`).all();
  assert.equal(created.length, 3);
});

test('create(): invalid Claude JSON → fallback single task created', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u2' });
  const pm = createProjectManager({ db, callClaude: fakeClaude('not valid json'), postMessage: async () => {} });

  await pm.create('Fix fence', member);

  const tasks = db.prepare(`SELECT * FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE title='Fix fence')`).all();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Fix fence');
});

test('create(): estimated_cost=30 with threshold=25 → requires_approval=1, status=awaiting_approval', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u3' });
  const tasks = [{ title: 'Buy lumber', estimated_cost: 30, notes: '' }];
  const pm = createProjectManager({ db, callClaude: fakeClaude(JSON.stringify(tasks)), postMessage: async () => {}, approvalThreshold: 25 });

  await pm.create('Build shelf', member);

  const task = db.prepare(`SELECT * FROM tasks WHERE title='Buy lumber'`).get();
  assert.equal(task.requires_approval, 1);
  assert.equal(task.status, 'awaiting_approval');
});

test('create(): estimated_cost=10 → requires_approval=0, status=todo', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u4' });
  const tasks = [{ title: 'Buy screws', estimated_cost: 10, notes: '' }];
  const pm = createProjectManager({ db, callClaude: fakeClaude(JSON.stringify(tasks)), postMessage: async () => {}, approvalThreshold: 25 });

  await pm.create('Hang shelves', member);

  const task = db.prepare(`SELECT * FROM tasks WHERE title='Buy screws'`).get();
  assert.equal(task.requires_approval, 0);
  assert.equal(task.status, 'todo');
});

// ─── complete() ───────────────────────────────────────────────────────────────

function seedTask(db, { title = 'Fix it', status = 'todo', assignedTo = null, recurrence = null, dueDate = null } = {}) {
  const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('P', 'active')`).run().lastInsertRowid;
  const taskId = db.prepare(
    `INSERT INTO tasks (project_id, title, status, assigned_to, recurrence, due_date) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(projectId, title, status, assignedTo, recurrence, dueDate).lastInsertRowid;
  return { taskId, projectId };
}

test('complete(): task not found → returns error message', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u5' });
  const pm = createProjectManager({ db, postMessage: async () => {} });

  const result = await pm.complete(9999, member);
  assert.ok(result.includes('not found'));
});

test('complete(): kid, task not assigned to them → rejection message', async () => {
  const db = makeDb();
  const kid = seedMember(db, { discordId: 'kid1', role: 'kid' });
  const adult = seedMember(db, { discordId: 'adult1', role: 'adult' });
  const { taskId } = seedTask(db, { assignedTo: adult.id });
  const pm = createProjectManager({ db, postMessage: async () => {} });

  const result = await pm.complete(taskId, kid);
  assert.ok(result.includes("isn't assigned to you"));
});

test('complete(): kid, assigned to them → success', async () => {
  const db = makeDb();
  const kid = seedMember(db, { discordId: 'kid2', role: 'kid' });
  const { taskId } = seedTask(db, { assignedTo: kid.id });
  const pm = createProjectManager({ db, postMessage: async () => {} });

  const result = await pm.complete(taskId, kid);
  assert.ok(result.toLowerCase().includes('done'));
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  assert.equal(task.status, 'done');
});

test('complete(): no recurrence → status=done, no new task created', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u6' });
  const { taskId } = seedTask(db, { recurrence: null });
  const pm = createProjectManager({ db, postMessage: async () => {} });

  await pm.complete(taskId, member);

  const allTasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(allTasks.length, 1);
  assert.equal(allTasks[0].status, 'done');
});

test('complete(): daily recurrence → new task created with due_date+1', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u7' });
  const { taskId } = seedTask(db, { recurrence: 'daily', dueDate: '2026-04-10' });
  const pm = createProjectManager({ db, postMessage: async () => {} });

  await pm.complete(taskId, member);

  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'done');
  assert.equal(tasks[1].due_date, '2026-04-11');
  assert.equal(tasks[1].recurrence, 'daily');
});

test('complete(): recurring with dependencies → deps copied to new instance', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u8' });
  const { taskId } = seedTask(db, { recurrence: 'weekly', dueDate: '2026-04-10' });

  // Create a dependency task and link it
  const projectId = db.prepare(`SELECT project_id FROM tasks WHERE id=?`).get(taskId).project_id;
  const depTaskId = db.prepare(`INSERT INTO tasks (project_id, title) VALUES (?, 'dep task')`).run(projectId, ).lastInsertRowid;
  db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).run(taskId, depTaskId);

  const pm = createProjectManager({ db, postMessage: async () => {} });
  await pm.complete(taskId, member);

  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const newTask = tasks.find(t => t.id !== taskId && t.id !== depTaskId);
  assert.ok(newTask, 'new recurring task should exist');

  const newDeps = db.prepare('SELECT * FROM task_dependencies WHERE task_id=?').all(newTask.id);
  assert.equal(newDeps.length, 1);
  assert.equal(newDeps[0].depends_on_task_id, depTaskId);
});

test('complete(): completing task unblocks dependent task', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u9' });
  const { taskId } = seedTask(db, { title: 'prereq' });

  const projectId = db.prepare(`SELECT project_id FROM tasks WHERE id=?`).get(taskId).project_id;
  const blockedId = db.prepare(`INSERT INTO tasks (project_id, title, status) VALUES (?, 'blocked task', 'blocked')`).run(projectId).lastInsertRowid;
  db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).run(blockedId, taskId);

  const pm = createProjectManager({ db, postMessage: async () => {} });
  await pm.complete(taskId, member);

  const blocked = db.prepare('SELECT * FROM tasks WHERE id=?').get(blockedId);
  assert.equal(blocked.status, 'todo');
});
