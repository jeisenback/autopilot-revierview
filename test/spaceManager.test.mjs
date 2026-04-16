// Tests for spaceManager.mjs — issue #37
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
    `INSERT INTO members (name, discord_user_id, role) VALUES ('Alice', ?, 'adult')`
  ).run(discordId);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return lastInsertRowid;
}

function seedSpace(db, { name = 'Mudroom', location = 'entryway', readyState = 'hooks clear', assignedTo = null, isReady = 1 } = {}) {
  return db.prepare(
    `INSERT INTO spaces (name, location, ready_state, assigned_to, is_ready) VALUES (?, ?, ?, ?, ?)`
  ).run(name, location, readyState, assignedTo, isReady).lastInsertRowid;
}

// ─── getAll ───────────────────────────────────────────────────────────────────

test('getAll(): empty DB → []', () => {
  const db = makeDb();
  const sm = createSpaceManager({ db });
  assert.deepEqual(sm.getAll(), []);
});

test('getAll(): returns all spaces ordered by name', () => {
  const db = makeDb();
  seedSpace(db, { name: 'Mudroom' });
  seedSpace(db, { name: 'Kitchen' });
  const sm = createSpaceManager({ db });
  const names = sm.getAll().map(s => s.name);
  assert.deepEqual(names, ['Kitchen', 'Mudroom']);
});

test('getAll(): includes assigned_to_name when joined', () => {
  const db = makeDb();
  const memberId = seedMember(db);
  seedSpace(db, { name: 'Mudroom', assignedTo: memberId });
  const sm = createSpaceManager({ db });
  const [s] = sm.getAll();
  assert.equal(s.assigned_to_name, 'Alice');
});

// ─── getById ─────────────────────────────────────────────────────────────────

test('getById(): returns null for unknown id', () => {
  const db = makeDb();
  const sm = createSpaceManager({ db });
  assert.equal(sm.getById(999), null);
});

test('getById(): returns space for known id', () => {
  const db = makeDb();
  const id = seedSpace(db, { name: 'Closet' });
  const sm = createSpaceManager({ db });
  assert.equal(sm.getById(id).name, 'Closet');
});

// ─── setReady ─────────────────────────────────────────────────────────────────

test('setReady(id, false): sets is_ready=0', () => {
  const db = makeDb();
  const id = seedSpace(db, { isReady: 1 });
  const sm = createSpaceManager({ db });
  const { space } = sm.setReady(id, false);
  assert.equal(space.is_ready, 0);
});

test('setReady(id, true): sets is_ready=1', () => {
  const db = makeDb();
  const id = seedSpace(db, { isReady: 0 });
  const sm = createSpaceManager({ db });
  const { space } = sm.setReady(id, true);
  assert.equal(space.is_ready, 1);
});

test('setReady(id, false): unknown id throws', () => {
  const db = makeDb();
  const sm = createSpaceManager({ db });
  assert.throws(() => sm.setReady(999, false), /not found/);
});

test('setReady(id, false, { createTask: true }): creates tidy task when assigned', () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const id = seedSpace(db, { name: 'Mudroom', readyState: 'hooks clear', assignedTo: memberId });
  const sm = createSpaceManager({ db });
  const { taskCreated } = sm.setReady(id, false, { createTask: true });
  assert.ok(taskCreated, 'should create a task');
  assert.ok(taskCreated.title.includes('Mudroom'), 'task title should reference space name');
  assert.equal(taskCreated.assigned_to, memberId);
});

test('setReady(id, false, { createTask: true }): no task if no assigned_to', () => {
  const db = makeDb();
  const id = seedSpace(db, { assignedTo: null });
  const sm = createSpaceManager({ db });
  const { taskCreated } = sm.setReady(id, false, { createTask: true });
  assert.equal(taskCreated, null);
});

test('setReady(id, false): no createTask option → no task created', () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const id = seedSpace(db, { assignedTo: memberId });
  const sm = createSpaceManager({ db });
  const { taskCreated } = sm.setReady(id, false);
  assert.equal(taskCreated, null);
});

// ─── getNotReady ─────────────────────────────────────────────────────────────

test('getNotReady(): returns only is_ready=0 spaces', () => {
  const db = makeDb();
  seedSpace(db, { name: 'Ready', isReady: 1 });
  seedSpace(db, { name: 'Messy', isReady: 0 });
  const sm = createSpaceManager({ db });
  const notReady = sm.getNotReady();
  assert.equal(notReady.length, 1);
  assert.equal(notReady[0].name, 'Messy');
});

test('getNotReady(): empty when all spaces are ready', () => {
  const db = makeDb();
  seedSpace(db, { isReady: 1 });
  const sm = createSpaceManager({ db });
  assert.deepEqual(sm.getNotReady(), []);
});

// ─── getBlockingSpaces ────────────────────────────────────────────────────────

test('getBlockingSpaces(): returns not-ready spaces', () => {
  const db = makeDb();
  seedSpace(db, { name: 'A', isReady: 0 });
  seedSpace(db, { name: 'B', isReady: 1 });
  const sm = createSpaceManager({ db });
  const blocking = sm.getBlockingSpaces(1);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].name, 'A');
});

// ─── getItems ────────────────────────────────────────────────────────────────

test('getItems(): returns items for a space', () => {
  const db = makeDb();
  const spaceId = seedSpace(db);
  db.prepare(`INSERT INTO space_items (space_id, name, belongs_here) VALUES (?, 'Keys', 1)`).run(spaceId);
  db.prepare(`INSERT INTO space_items (space_id, name, belongs_here) VALUES (?, 'Mail pile', 0)`).run(spaceId);
  const sm = createSpaceManager({ db });
  const items = sm.getItems(spaceId);
  assert.equal(items.length, 2);
});

test('getItems(): empty array for space with no items', () => {
  const db = makeDb();
  const spaceId = seedSpace(db);
  const sm = createSpaceManager({ db });
  assert.deepEqual(sm.getItems(spaceId), []);
});

// ─── formatList ───────────────────────────────────────────────────────────────

test('formatList(): no spaces → "No spaces defined yet."', () => {
  const db = makeDb();
  const sm = createSpaceManager({ db });
  assert.equal(sm.formatList(), 'No spaces defined yet.');
});

test('formatList(): shows checkmark for ready, red for not-ready', () => {
  const db = makeDb();
  seedSpace(db, { name: 'Mudroom', isReady: 1 });
  seedSpace(db, { name: 'Counter', isReady: 0 });
  const sm = createSpaceManager({ db });
  const result = sm.formatList();
  assert.ok(result.includes('✅'), 'should include green check for ready');
  assert.ok(result.includes('🔴'), 'should include red for not-ready');
  assert.ok(result.includes('Mudroom'));
  assert.ok(result.includes('Counter'));
});

// ─── setReady idempotency ─────────────────────────────────────────────────────

test('setReady(false): does not create a second tidy task if one already exists', () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const spaceId = seedSpace(db, { name: 'Mudroom', assignedTo: memberId, isReady: 1 });
  const sm = createSpaceManager({ db });

  // First call — creates task
  const first = sm.setReady(spaceId, false, { createTask: true });
  assert.ok(first.taskCreated, 'first call should create a task');
  const firstTaskId = first.taskCreated.id;

  // Reset to ready, then not-ready again
  sm.setReady(spaceId, true);
  const second = sm.setReady(spaceId, false, { createTask: true });
  assert.ok(second.taskCreated, 'second call should return a task');
  assert.equal(second.taskCreated.id, firstTaskId, 'should return the existing task, not a new one');

  const taskCount = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE title = 'Tidy Mudroom' AND status NOT IN ('done','skipped')`
  ).get().n;
  assert.equal(taskCount, 1, 'only one open tidy task should exist');
});
