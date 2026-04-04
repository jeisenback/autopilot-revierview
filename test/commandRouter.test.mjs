import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../orchestrator/commandRouter.mjs';

// ─── helpers ──────────────────────────────────────────────────────────────────

function adult(id = 1) {
  return { id, role: 'adult', name: 'Alice' };
}

function kid(id = 2) {
  return { id, role: 'kid', name: 'Sam' };
}

function intent(command, args = {}) {
  return { intent: 'command', command, args };
}

function makeManager(overrides = {}) {
  return {
    create: async () => 'project created',
    complete: async () => '✓ done',
    listOpen: () => '**Project A**',
    assign: async () => 'assigned',
    ...overrides,
  };
}

// ─── role guard ───────────────────────────────────────────────────────────────

test('kid + add_project → role guard rejection', async () => {
  const router = createRouter({ projectManager: makeManager() });
  const result = await router.dispatch(intent('add_project', { title: 'New' }), kid(), {});
  assert.ok(result.toLowerCase().includes('parent'), `expected parent message, got: ${result}`);
});

test('kid + assign_task → role guard rejection', async () => {
  const router = createRouter({ projectManager: makeManager() });
  const result = await router.dispatch(intent('assign_task', { taskId: 1, mention: '@bob' }), kid(), {});
  assert.ok(result.toLowerCase().includes('parent'), `expected parent message, got: ${result}`);
});

test('adult + add_project → allowed', async () => {
  let called = false;
  const mgr = makeManager({ create: async () => { called = true; return 'created'; } });
  const router = createRouter({ projectManager: mgr });
  const result = await router.dispatch(intent('add_project', { title: 'Paint fence' }), adult(), {});
  assert.ok(called, 'projectManager.create should be called');
  assert.equal(result, 'created');
});

// ─── command routing ──────────────────────────────────────────────────────────

test('add_project routes to projectManager.create with title', async () => {
  let receivedTitle;
  const mgr = makeManager({ create: async (title) => { receivedTitle = title; return 'ok'; } });
  const router = createRouter({ projectManager: mgr });
  await router.dispatch(intent('add_project', { title: 'Fix roof' }), adult(), {});
  assert.equal(receivedTitle, 'Fix roof');
});

test('list_projects routes to projectManager.listOpen', async () => {
  let called = false;
  const mgr = makeManager({ listOpen: () => { called = true; return 'list'; } });
  const router = createRouter({ projectManager: mgr });
  const result = await router.dispatch(intent('list_projects'), adult(), {});
  assert.ok(called);
  assert.equal(result, 'list');
});

test('complete_task routes to projectManager.complete with taskId and member', async () => {
  let receivedArgs;
  const mgr = makeManager({ complete: async (taskId, member) => { receivedArgs = { taskId, member }; return 'done'; } });
  const router = createRouter({ projectManager: mgr });
  const member = adult();
  await router.dispatch(intent('complete_task', { taskId: 7 }), member, {});
  assert.equal(receivedArgs.taskId, 7);
  assert.equal(receivedArgs.member, member);
});

test('assign_task routes to projectManager.assign', async () => {
  let called = false;
  const mgr = makeManager({ assign: async () => { called = true; return 'assigned'; } });
  const router = createRouter({ projectManager: mgr });
  await router.dispatch(intent('assign_task', { taskId: 3, mention: '@bob' }), adult(), {});
  assert.ok(called);
});

test('snooze command returns confirmation string', async () => {
  const router = createRouter({ projectManager: makeManager() });
  const result = await router.dispatch(intent('snooze', { hours: 2 }), adult(), {});
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('unknown command returns fallback string', async () => {
  const router = createRouter({ projectManager: makeManager() });
  const result = await router.dispatch(intent('totally_unknown'), adult(), {});
  assert.ok(typeof result === 'string' && result.length > 0);
});

// ─── orchestrator/index.mjs ───────────────────────────────────────────────────

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHandle } from '../orchestrator/index.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeHandleDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedHandleMember(db, discordId = 'handle-u1') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, 'adult', '23:00', '05:00', 'America/Chicago', 5)`
  ).run(discordId);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id = ?').get(lastInsertRowid);
}

test('handle(): unknown discord_user_id → not registered message', async () => {
  const db = makeHandleDb();
  const handle = createHandle({ db, parseIntent: async () => ({}), dispatch: async () => 'ok' });
  const result = await handle({ author: { discord_user_id: 'unknown-id' }, content: 'hi' });
  assert.ok(result.toLowerCase().includes('not registered') || result.toLowerCase().includes("aren't registered"));
});

test('handle(): known member → parseIntent called with content', async () => {
  const db = makeHandleDb();
  seedHandleMember(db, 'h-u2');
  let parsedText;
  const handle = createHandle({
    db,
    parseIntent: async (text) => { parsedText = text; return { intent: 'command', command: 'list_projects' }; },
    dispatch: async () => 'list result',
  });
  await handle({ author: { discord_user_id: 'h-u2' }, content: '/project list' });
  assert.equal(parsedText, '/project list');
});

test('handle(): dispatch result returned', async () => {
  const db = makeHandleDb();
  seedHandleMember(db, 'h-u3');
  const handle = createHandle({
    db,
    parseIntent: async () => ({ intent: 'command', command: 'list_projects' }),
    dispatch: async () => 'dispatch result',
  });
  const result = await handle({ author: { discord_user_id: 'h-u3' }, content: '/project list' });
  assert.equal(result, 'dispatch result');
});
