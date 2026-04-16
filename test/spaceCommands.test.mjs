// Tests for /space commands in commandRouter + intentParser — issue #38
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRouter } from '../orchestrator/commandRouter.mjs';
import { createSpaceManager } from '../orchestrator/spaceManager.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedMember(db, discordId = 'u1') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role) VALUES ('Alice', ?, 'dm-1', 'adult')`
  ).run(discordId);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

function seedSpace(db, { name = 'Mudroom', location = 'entryway', readyState = 'hooks clear', isReady = 1 } = {}) {
  return db.prepare(
    `INSERT INTO spaces (name, location, ready_state, is_ready) VALUES (?, ?, ?, ?)`
  ).run(name, location, readyState, isReady).lastInsertRowid;
}

function makeRouter(db) {
  const sm = createSpaceManager({ db });
  return createRouter({
    approvalManager: { resolve: async () => '', listPending: () => '', countPending: () => 0 },
    projectManager: { assign: async () => {}, create: async () => '', complete: async () => '', listOpen: () => '', statusSummary: () => '' },
    suppressionModel: { snooze: () => {} },
    responseFormatter: { formatWithClaude: async () => '' },
    briefingEngine: { buildDigest: () => ({ formatted: '' }) },
    spaceManager: sm,
  });
}

// ─── intentParser fast-paths ──────────────────────────────────────────────────

test('/space list parses to space_list command', async () => {
  const { createIntentParser } = await import('../orchestrator/intentParser.mjs');
  const { parseIntent } = createIntentParser({ callClaude: async () => '{}' });
  const r = await parseIntent('/space list');
  assert.equal(r.command, 'space_list');
});

test('/space set-ready Mudroom parses correctly', async () => {
  const { createIntentParser } = await import('../orchestrator/intentParser.mjs');
  const { parseIntent } = createIntentParser({ callClaude: async () => '{}' });
  const r = await parseIntent('/space set-ready Mudroom');
  assert.equal(r.command, 'space_set_ready');
  assert.equal(r.args.name, 'Mudroom');
});

test('/space set-not-ready Counter parses correctly', async () => {
  const { createIntentParser } = await import('../orchestrator/intentParser.mjs');
  const { parseIntent } = createIntentParser({ callClaude: async () => '{}' });
  const r = await parseIntent('/space set-not-ready Counter');
  assert.equal(r.command, 'space_set_not_ready');
  assert.equal(r.args.name, 'Counter');
});

// ─── /space list ──────────────────────────────────────────────────────────────

test('/space list: no spaces → "No spaces defined yet."', async () => {
  const db = makeDb();
  const router = makeRouter(db);
  const result = await router.dispatch({ intent: 'command', command: 'space_list' }, null, {});
  assert.equal(result, 'No spaces defined yet.');
});

test('/space list: shows all spaces with icons', async () => {
  const db = makeDb();
  seedSpace(db, { name: 'Mudroom', isReady: 1 });
  seedSpace(db, { name: 'Counter', isReady: 0 });
  const router = makeRouter(db);
  const result = await router.dispatch({ intent: 'command', command: 'space_list' }, null, {});
  assert.ok(result.includes('Mudroom'));
  assert.ok(result.includes('Counter'));
  assert.ok(result.includes('✅'));
  assert.ok(result.includes('🔴'));
});

// ─── /space set-ready ─────────────────────────────────────────────────────────

test('/space set-ready: marks space ready, returns confirmation', async () => {
  const db = makeDb();
  seedSpace(db, { name: 'Mudroom', isReady: 0 });
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_ready', args: { name: 'Mudroom' } },
    null, {}
  );
  assert.ok(result.includes('✅'));
  assert.ok(result.includes('Mudroom'));
  assert.ok(result.toLowerCase().includes('ready'));
});

test('/space set-ready: case-insensitive name match', async () => {
  const db = makeDb();
  seedSpace(db, { name: 'Mudroom', isReady: 0 });
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_ready', args: { name: 'mudroom' } },
    null, {}
  );
  assert.ok(result.includes('✅'));
});

test('/space set-ready: partial name match', async () => {
  const db = makeDb();
  seedSpace(db, { name: 'Kitchen Counter', isReady: 0 });
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_ready', args: { name: 'kitchen' } },
    null, {}
  );
  assert.ok(result.includes('✅'));
  assert.ok(result.includes('Kitchen Counter'));
});

test('/space set-ready: unknown name → error message', async () => {
  const db = makeDb();
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_ready', args: { name: 'Garage' } },
    null, {}
  );
  assert.ok(result.toLowerCase().includes('not found') || result.toLowerCase().includes('garage'));
});

test('/space set-ready: missing name → usage hint', async () => {
  const db = makeDb();
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_ready', args: { name: '' } },
    null, {}
  );
  assert.ok(result.toLowerCase().includes('usage'));
});

// ─── /space set-not-ready ─────────────────────────────────────────────────────

test('/space set-not-ready: marks space not-ready', async () => {
  const db = makeDb();
  seedSpace(db, { name: 'Mudroom', isReady: 1 });
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_not_ready', args: { name: 'Mudroom' } },
    null, {}
  );
  assert.ok(result.includes('🔴'));
  assert.ok(result.toLowerCase().includes('not ready'));
});

test('/space set-not-ready: mentions tidy task when created', async () => {
  const db = makeDb();
  const member = seedMember(db);
  db.prepare(`INSERT INTO spaces (name, ready_state, is_ready, assigned_to) VALUES ('Mudroom', 'hooks clear', 1, ?)`).run(member.id);
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_not_ready', args: { name: 'Mudroom' } },
    null, {}
  );
  assert.ok(result.includes('Tidy task created'), `Expected "Tidy task created" in: ${result}`);
});

test('/space set-not-ready: says "already open" when tidy task already exists', async () => {
  const db = makeDb();
  const member = seedMember(db);
  db.prepare(`INSERT INTO spaces (name, ready_state, is_ready, assigned_to) VALUES ('Mudroom', 'hooks clear', 1, ?)`).run(member.id);
  const router = makeRouter(db);
  // First call creates the task
  await router.dispatch(
    { intent: 'command', command: 'space_set_not_ready', args: { name: 'Mudroom' } },
    null, {}
  );
  // Mark ready again so the next set-not-ready triggers task lookup
  await router.dispatch(
    { intent: 'command', command: 'space_set_ready', args: { name: 'Mudroom' } },
    null, {}
  );
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_not_ready', args: { name: 'Mudroom' } },
    null, {}
  );
  assert.ok(result.includes('already open'), `Expected "already open" in: ${result}`);
});

// ─── kid role restrictions ─────────────────────────────────────────────────────

function seedKid(db, discordId = 'kid1') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role) VALUES ('Bob', ?, 'dm-2', 'kid')`
  ).run(discordId);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

test('/space set-ready: kid role → rejected', async () => {
  const db = makeDb();
  seedSpace(db, { name: 'Mudroom', isReady: 0 });
  const kid = seedKid(db);
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_ready', args: { name: 'Mudroom' } },
    kid, {}
  );
  assert.ok(result.toLowerCase().includes('parent'), `Expected parent message, got: ${result}`);
});

test('/space set-not-ready: kid role → rejected', async () => {
  const db = makeDb();
  seedSpace(db, { name: 'Mudroom', isReady: 1 });
  const kid = seedKid(db);
  const router = makeRouter(db);
  const result = await router.dispatch(
    { intent: 'command', command: 'space_set_not_ready', args: { name: 'Mudroom' } },
    kid, {}
  );
  assert.ok(result.toLowerCase().includes('parent'), `Expected parent message, got: ${result}`);
});
