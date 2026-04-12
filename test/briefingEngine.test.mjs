import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createBriefingEngine } from '../orchestrator/briefingEngine.mjs';

// ─── in-memory DB ─────────────────────────────────────────────────────────────

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedAdult(db, discordId = 'briefing-adult') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, 'adult', '23:00', '05:00', 'America/Chicago', 5)`
  ).run(discordId);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id = ?').get(lastInsertRowid);
}

function seedProject(db) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO projects (title, status) VALUES ('Test project', 'active')`
  ).run();
  return lastInsertRowid;
}

function seedTask(db, projectId, { status = 'todo', dueDate = null, priority = 2 } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO tasks (project_id, title, status, due_date, priority) VALUES (?, 'Test task', ?, ?, ?)`
  ).run(projectId, status, dueDate, priority);
  return lastInsertRowid;
}

// ─── stubs ────────────────────────────────────────────────────────────────────

function stubClaude(text = 'Morning briefing text.') {
  return async () => text;
}

function stubGetStates(states = []) {
  return async () => states;
}

function rejectGetStates() {
  return async () => { throw new Error('HA unreachable'); };
}

function capturePostMessage() {
  const calls = [];
  const fn = async (channelId, text) => { calls.push({ channelId, text }); };
  fn.calls = calls;
  return fn;
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('HA unreachable → briefing posts without HA section, no crash', async () => {
  const db = makeDb();
  const post = capturePostMessage();
  const engine = createBriefingEngine({
    db,
    callClaude: stubClaude('Briefing without HA'),
    getStates: rejectGetStates(),
    postMessage: post,
  });

  await engine.sendMorningBriefing();

  assert.equal(post.calls.length, 1, 'briefing should be posted once');
  assert.ok(post.calls[0].text.length > 0, 'briefing text should not be empty');
});

test('HA_MONITORED_ENTITIES empty → briefing posts, no HA section', async () => {
  const db = makeDb();
  const post = capturePostMessage();
  let claudeContext = '';
  const engine = createBriefingEngine({
    db,
    callClaude: async (ctx) => { claudeContext = ctx; return 'Briefing text'; },
    getStates: stubGetStates([]),
    postMessage: post,
    monitoredEntities: [],
  });

  await engine.sendMorningBriefing();

  assert.equal(post.calls.length, 1);
  assert.ok(!claudeContext.toLowerCase().includes('home assistant'), 'HA section should be absent');
});

test('no overdue tasks → briefing still posts', async () => {
  const db = makeDb();
  const post = capturePostMessage();
  const engine = createBriefingEngine({
    db,
    callClaude: stubClaude('No tasks today.'),
    getStates: stubGetStates([]),
    postMessage: post,
  });

  await engine.sendMorningBriefing();

  assert.equal(post.calls.length, 1);
});

test('open tasks included in Claude context', async () => {
  const db = makeDb();
  const pid = seedProject(db);
  seedTask(db, pid, { dueDate: '2026-01-01' }); // overdue
  seedTask(db, pid, { status: 'todo', priority: 1 });

  let capturedContext = '';
  const post = capturePostMessage();
  const engine = createBriefingEngine({
    db,
    callClaude: async (ctx) => { capturedContext = ctx; return 'Briefing'; },
    getStates: stubGetStates([]),
    postMessage: post,
  });

  await engine.sendMorningBriefing();

  assert.ok(capturedContext.includes('Test task') || capturedContext.includes('task'), 'tasks should appear in context');
});

test('HA states included in Claude context when available', async () => {
  const db = makeDb();
  const states = [{ entity_id: 'sensor.temperature', state: '72', attributes: {} }];
  let capturedContext = '';
  const post = capturePostMessage();
  const engine = createBriefingEngine({
    db,
    callClaude: async (ctx) => { capturedContext = ctx; return 'Briefing'; },
    getStates: stubGetStates(states),
    postMessage: post,
    monitoredEntities: ['sensor.temperature'],
  });

  await engine.sendMorningBriefing();

  assert.ok(capturedContext.includes('sensor.temperature') || capturedContext.includes('temperature'), 'HA state should appear in context');
});

test('Claude failure → fallback message posted, no crash', async () => {
  const db = makeDb();
  const post = capturePostMessage();
  const engine = createBriefingEngine({
    db,
    callClaude: async () => { throw new Error('Claude API error'); },
    getStates: stubGetStates([]),
    postMessage: post,
  });

  await engine.sendMorningBriefing();

  assert.equal(post.calls.length, 1);
  assert.ok(post.calls[0].text.toLowerCase().includes('unavailable') || post.calls[0].text.toLowerCase().includes('manually'), 'fallback message should indicate unavailability');
});

test('postMessage failure → logs error, does not throw', async () => {
  const db = makeDb();
  const engine = createBriefingEngine({
    db,
    callClaude: stubClaude('Briefing'),
    getStates: stubGetStates([]),
    postMessage: async () => { throw new Error('Discord unreachable'); },
  });

  // Must not throw
  await assert.doesNotReject(() => engine.sendMorningBriefing());
});

test('briefing posted to BRIEFING_CHANNEL_ID', async () => {
  const db = makeDb();
  const post = capturePostMessage();
  const engine = createBriefingEngine({
    db,
    callClaude: stubClaude('Briefing'),
    getStates: stubGetStates([]),
    postMessage: post,
    channelId: 'test-channel-123',
  });

  await engine.sendMorningBriefing();

  assert.equal(post.calls[0].channelId, 'test-channel-123');
});
