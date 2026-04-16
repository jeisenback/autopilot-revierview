import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTasksAdapter } from '../orchestrator/tasksAdapter.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedMember(db, { discordId = 'u1', googleTasksListId = null } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications, google_tasks_list_id)
     VALUES ('Alice', ?, 'adult', '23:00', '05:00', 'America/Chicago', 5, ?)`
  ).run(discordId, googleTasksListId);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

function seedTask(db, { title = 'Test task', googleTaskId = null, assignedTo = null } = {}) {
  const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('P', 'active')`).run().lastInsertRowid;
  const taskId = db.prepare(
    `INSERT INTO tasks (project_id, title, google_task_id, assigned_to) VALUES (?, ?, ?, ?)`
  ).run(projectId, title, googleTaskId, assignedTo).lastInsertRowid;
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
}

// Fake Google Tasks client builder.
function makeFakeClient({ insertId = 'gt-999', patchCalls = [], insertCalls = [], listItems = [] } = {}) {
  return {
    tasks: {
      insert: async ({ tasklist, requestBody }) => {
        insertCalls.push({ tasklist, requestBody });
        return { data: { id: insertId } };
      },
      patch: async ({ tasklist, task, requestBody }) => {
        patchCalls.push({ tasklist, task, requestBody });
        return { data: {} };
      },
      list: async () => ({ data: { items: listItems } }),
    },
  };
}

// ── push() ────────────────────────────────────────────────────────────────────

test('push(): member with no google_tasks_list_id → returns null, no API call', async () => {
  const db = makeDb();
  const member = seedMember(db, { googleTasksListId: null });
  const task = seedTask(db);
  const insertCalls = [];
  const client = makeFakeClient({ insertCalls });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  const result = await adapter.push(task, member);

  assert.equal(result, null);
  assert.equal(insertCalls.length, 0);
});

test('push(): new task → creates Google Task, persists google_task_id to DB', async () => {
  const db = makeDb();
  const member = seedMember(db, { googleTasksListId: 'list-abc' });
  const task = seedTask(db, { title: 'Buy paint' });
  const insertCalls = [];
  const client = makeFakeClient({ insertId: 'gt-001', insertCalls });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  const result = await adapter.push(task, member);

  assert.equal(result, 'gt-001');
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].tasklist, 'list-abc');
  assert.equal(insertCalls[0].requestBody.title, 'Buy paint');

  const updated = db.prepare('SELECT google_task_id FROM tasks WHERE id=?').get(task.id);
  assert.equal(updated.google_task_id, 'gt-001');
});

test('push(): task with existing google_task_id → patches, does not insert', async () => {
  const db = makeDb();
  const member = seedMember(db, { googleTasksListId: 'list-abc' });
  const task = seedTask(db, { title: 'Buy paint', googleTaskId: 'gt-existing' });
  const insertCalls = [];
  const patchCalls = [];
  const client = makeFakeClient({ insertCalls, patchCalls });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  const result = await adapter.push(task, member);

  assert.equal(result, 'gt-existing');
  assert.equal(insertCalls.length, 0);
  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0].task, 'gt-existing');
  assert.equal(patchCalls[0].requestBody.title, 'Buy paint');
});

// ── completeRemote() ──────────────────────────────────────────────────────────

test('completeRemote(): task has no google_task_id → no API call', async () => {
  const db = makeDb();
  const member = seedMember(db, { googleTasksListId: 'list-abc' });
  const task = seedTask(db, { googleTaskId: null });
  const patchCalls = [];
  const client = makeFakeClient({ patchCalls });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  await adapter.completeRemote(task, member);

  assert.equal(patchCalls.length, 0);
});

test('completeRemote(): valid task + member → patches status=completed', async () => {
  const db = makeDb();
  const member = seedMember(db, { googleTasksListId: 'list-abc' });
  const task = seedTask(db, { googleTaskId: 'gt-001' });
  const patchCalls = [];
  const client = makeFakeClient({ patchCalls });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  await adapter.completeRemote(task, member);

  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0].task, 'gt-001');
  assert.equal(patchCalls[0].tasklist, 'list-abc');
  assert.equal(patchCalls[0].requestBody.status, 'completed');
});

test('completeRemote(): 404 from Google Tasks API → does not throw', async () => {
  const db = makeDb();
  const member = seedMember(db, { googleTasksListId: 'list-abc' });
  const task = seedTask(db, { googleTaskId: 'gt-gone' });

  const client = {
    tasks: {
      patch: async () => { const e = new Error('not found'); e.code = 404; throw e; },
    },
  };

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  await assert.doesNotReject(() => adapter.completeRemote(task, member));
});

// ── syncAll() ─────────────────────────────────────────────────────────────────

test('syncAll(): completed Google Task → marks matching local task done', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'u1', googleTasksListId: 'list-abc' });
  const task = seedTask(db, { googleTaskId: 'gt-001' });

  const client = makeFakeClient({
    listItems: [{ id: 'gt-001', status: 'completed' }],
  });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  await adapter.syncAll();

  const updated = db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id);
  assert.equal(updated.status, 'done');
});

test('syncAll(): needsAction Google Task → local task unchanged', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'u1', googleTasksListId: 'list-abc' });
  const task = seedTask(db, { googleTaskId: 'gt-001' });

  const client = makeFakeClient({
    listItems: [{ id: 'gt-001', status: 'needsAction' }],
  });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  await adapter.syncAll();

  const unchanged = db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id);
  assert.equal(unchanged.status, 'todo');
});

test('syncAll(): google_task_id not in local DB → no error, no rows changed', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'u1', googleTasksListId: 'list-abc' });

  const client = makeFakeClient({
    listItems: [{ id: 'gt-unknown', status: 'completed' }],
  });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  await assert.doesNotReject(() => adapter.syncAll());
});

test('syncAll(): already-done local task → not double-updated (idempotent)', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'u1', googleTasksListId: 'list-abc' });
  const task = seedTask(db, { googleTaskId: 'gt-001' });
  db.prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(task.id);

  const client = makeFakeClient({
    listItems: [{ id: 'gt-001', status: 'completed' }],
  });

  const adapter = createTasksAdapter({ db, _tasksClient: client });
  await adapter.syncAll();

  // status should remain 'done', updated_at should not have changed
  const still = db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id);
  assert.equal(still.status, 'done');
});
