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

// ─── buildDigest ──────────────────────────────────────────────────────────────

function seedMember(db, { name = 'Alice', discordId = 'u-alice', role = 'adult', dmChannel = null } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications, discord_dm_channel_id)
     VALUES (?, ?, ?, '23:00', '05:00', 'America/Chicago', 5, ?)`
  ).run(name, discordId, role, dmChannel);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id = ?').get(lastInsertRowid);
}

function seedTaskFor(db, projectId, memberId, { title = 'Test task', status = 'todo', dueDate = null, priority = 2 } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO tasks (project_id, title, status, assigned_to, due_date, priority) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(projectId, title, status, memberId, dueDate, priority);
  return lastInsertRowid;
}

test('buildDigest: throws when member not found', () => {
  const db = makeDb();
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {} });
  assert.throws(() => engine.buildDigest(9999, '2026-01-01'), /member 9999 not found/);
});

test('buildDigest: returns myTasks for member, excludes done tasks', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-alice-bd' });
  const pid = seedProject(db);
  seedTaskFor(db, pid, alice.id, { title: 'Open task', status: 'todo' });
  seedTaskFor(db, pid, alice.id, { title: 'Done task', status: 'done' });

  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {} });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.myTasks.length, 1);
  assert.equal(digest.myTasks[0].title, 'Open task');
});

test('buildDigest: correctly categorizes overdue and dueToday', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-alice-ov' });
  const pid = seedProject(db);
  seedTaskFor(db, pid, alice.id, { title: 'Past due', dueDate: '2026-01-01' });
  seedTaskFor(db, pid, alice.id, { title: 'Due today', dueDate: '2026-04-12' });
  seedTaskFor(db, pid, alice.id, { title: 'Future', dueDate: '2026-12-31' });

  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {} });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.overdue.length, 1);
  assert.equal(digest.overdue[0].title, 'Past due');
  assert.equal(digest.dueToday.length, 1);
  assert.equal(digest.dueToday[0].title, 'Due today');
});

test('buildDigest: blocking — my incomplete task that a dep task awaits', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-alice-bl' });
  const bob   = seedMember(db, { name: 'Bob', discordId: 'u-bob-bl', role: 'adult' });
  const pid   = seedProject(db);

  const myTask  = seedTaskFor(db, pid, alice.id, { title: 'My blocker', status: 'todo' });
  const bobTask = seedTaskFor(db, pid, bob.id,   { title: 'Bob waiting', status: 'todo' });
  db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).run(bobTask, myTask);

  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {} });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.blocking.length, 1);
  assert.equal(digest.blocking[0].title, 'Bob waiting');
  assert.equal(digest.blocking[0].blocked_member_name, 'Bob');
});

test('buildDigest: blocking — does not include tasks assigned to same member', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-alice-self' });
  const pid   = seedProject(db);

  const taskA = seedTaskFor(db, pid, alice.id, { title: 'Step 1', status: 'todo' });
  const taskB = seedTaskFor(db, pid, alice.id, { title: 'Step 2', status: 'todo' });
  db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).run(taskB, taskA);

  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {} });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.blocking.length, 0);
});

test('buildDigest: unblocked — task assigned to me with all deps done', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-alice-ub' });
  const bob   = seedMember(db, { name: 'Bob', discordId: 'u-bob-ub', role: 'adult' });
  const pid   = seedProject(db);

  const bobTask   = seedTaskFor(db, pid, bob.id,   { title: 'Prerequisite', status: 'done' });
  const aliceTask = seedTaskFor(db, pid, alice.id, { title: 'Now unblocked', status: 'todo' });
  db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).run(aliceTask, bobTask);

  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {} });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.unblocked.length, 1);
  assert.equal(digest.unblocked[0].title, 'Now unblocked');
});

test('buildDigest: unblocked — not listed when dep still pending', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-alice-np' });
  const bob   = seedMember(db, { name: 'Bob', discordId: 'u-bob-np', role: 'adult' });
  const pid   = seedProject(db);

  const bobTask   = seedTaskFor(db, pid, bob.id,   { title: 'Still pending', status: 'todo' });
  const aliceTask = seedTaskFor(db, pid, alice.id, { title: 'Still blocked', status: 'todo' });
  db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).run(aliceTask, bobTask);

  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {} });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.unblocked.length, 0);
});

test('buildDigest: formatted contains member name and task titles', () => {
  const db = makeDb();
  const alice = seedMember(db, { name: 'Alice', discordId: 'u-alice-fmt' });
  const pid = seedProject(db);
  seedTaskFor(db, pid, alice.id, { title: 'Fix the deck' });

  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {} });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.ok(digest.formatted.includes('Alice'), 'formatted should include member name');
  assert.ok(digest.formatted.includes('Fix the deck'), 'formatted should include task title');
});

// ─── sendAllDigests ───────────────────────────────────────────────────────────

test('sendAllDigests: sends digest to each member with dm channel', async () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-ad-a', dmChannel: 'dm-alice' });
  const bob   = seedMember(db, { name: 'Bob', discordId: 'u-ad-b', role: 'adult', dmChannel: 'dm-bob' });
  const pid = seedProject(db);
  seedTaskFor(db, pid, alice.id, { title: 'Alice task' });

  const post = capturePostMessage();
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: post });
  await engine.sendAllDigests('2026-04-12');

  const channels = post.calls.map(c => c.channelId);
  assert.ok(channels.includes('dm-alice'), 'should send to alice DM');
  assert.ok(channels.includes('dm-bob'), 'should send to bob DM');
  assert.equal(post.calls.length, 2);
});

test('sendAllDigests: skips members without dm channel', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'u-nd-a', dmChannel: null });
  seedMember(db, { name: 'Bob', discordId: 'u-nd-b', role: 'adult', dmChannel: 'dm-bob-only' });

  const post = capturePostMessage();
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: post });
  await engine.sendAllDigests('2026-04-12');

  assert.equal(post.calls.length, 1);
  assert.equal(post.calls[0].channelId, 'dm-bob-only');
});

test('sendAllDigests: one member failure does not stop others', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'u-fail-a', dmChannel: 'dm-fail' });
  seedMember(db, { name: 'Bob', discordId: 'u-fail-b', role: 'adult', dmChannel: 'dm-ok' });

  let callCount = 0;
  const post = async (channelId) => {
    callCount++;
    if (channelId === 'dm-fail') throw new Error('Send failed');
  };

  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: post });
  await assert.doesNotReject(() => engine.sendAllDigests('2026-04-12'));
  assert.equal(callCount, 2, 'should attempt both members even after one fails');
});

// ─── spaces in digest (issue #39) ─────────────────────────────────────────────

import { createSpaceManager } from '../orchestrator/spaceManager.mjs';

function seedSpace(db, { name = 'Mudroom', readyState = 'hooks clear', isReady = 0, assignedTo = null } = {}) {
  return db.prepare(
    `INSERT INTO spaces (name, ready_state, is_ready, assigned_to) VALUES (?, ?, ?, ?)`
  ).run(name, readyState, isReady, assignedTo).lastInsertRowid;
}

test('buildDigest: notReadySpaces includes spaces assigned to member', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-space-1' });
  seedSpace(db, { name: 'Mudroom', isReady: 0, assignedTo: alice.id });
  seedSpace(db, { name: 'Kitchen', isReady: 1, assignedTo: alice.id });  // ready, should be excluded

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.notReadySpaces.length, 1);
  assert.equal(digest.notReadySpaces[0].name, 'Mudroom');
});

test('buildDigest: adult sees unassigned not-ready spaces too', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-space-2' });  // adult
  seedSpace(db, { name: 'Shared Counter', isReady: 0, assignedTo: null });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.notReadySpaces.length, 1);
  assert.equal(digest.notReadySpaces[0].name, 'Shared Counter');
});

test('buildDigest: kid does NOT see unassigned spaces', () => {
  const db = makeDb();
  const kid = seedMember(db, { name: 'Jordan', discordId: 'u-space-3', role: 'kid' });
  seedSpace(db, { name: 'Shared Counter', isReady: 0, assignedTo: null });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(kid.id, '2026-04-12');

  assert.equal(digest.notReadySpaces.length, 0);
});

test('buildDigest: no not-ready spaces → notReadySpaces empty', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-space-4' });
  seedSpace(db, { name: 'Mudroom', isReady: 1, assignedTo: alice.id });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.notReadySpaces.length, 0);
});

test('buildDigest: formatted includes spaces section when spaces not ready', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-space-5' });
  seedSpace(db, { name: 'Mudroom', readyState: 'hooks clear', isReady: 0, assignedTo: alice.id });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.ok(digest.formatted.includes('Spaces'), 'formatted should include spaces section header');
  assert.ok(digest.formatted.includes('Mudroom'), 'formatted should include space name');
});

test('buildDigest: formatted omits spaces section when all ready', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-space-6' });
  seedSpace(db, { name: 'Mudroom', isReady: 1, assignedTo: alice.id });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.ok(!digest.formatted.includes('Spaces needing'), 'should not include spaces section when all ready');
});

// ─── template blockers ────────────────────────────────────────────────────────

function seedTemplateRun(db, { title = 'School run', ownerId = null, spaceId = null, date = '2026-04-12', status = 'pending', departAt = '08:00' } = {}) {
  const templateId = db.prepare(
    `INSERT INTO process_templates (title, recurrence, owner_id, depart_time) VALUES (?, 'daily', ?, ?)`
  ).run(title, ownerId, departAt).lastInsertRowid;
  db.prepare(
    `INSERT INTO template_items (template_id, label, requires_space_ready) VALUES (?, 'Leave', ?)`
  ).run(templateId, spaceId);
  const runId = db.prepare(
    `INSERT INTO template_runs (template_id, scheduled_for, depart_at, status) VALUES (?, ?, ?, ?)`
  ).run(templateId, date, departAt, status).lastInsertRowid;
  return { templateId, runId };
}

test('buildDigest: templateBlockers includes run blocked by not-ready space (owner)', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-tb-1' });
  const spaceId = seedSpace(db, { name: 'Mudroom', isReady: 0 });
  seedTemplateRun(db, { title: 'School run', ownerId: alice.id, spaceId, date: '2026-04-12' });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.templateBlockers.length, 1);
  assert.equal(digest.templateBlockers[0].template_title, 'School run');
  assert.equal(digest.templateBlockers[0].space_name, 'Mudroom');
});

test('buildDigest: all members see template blockers regardless of ownership', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-tb-2', role: 'adult' });
  const bob = seedMember(db, { name: 'Bob', discordId: 'u-tb-2b', role: 'kid' });
  const spaceId = seedSpace(db, { name: 'Kitchen', isReady: 0 });
  seedTemplateRun(db, { title: "School run", ownerId: alice.id, spaceId, date: '2026-04-12' });

  const sm = createSpaceManager({ db });
  const engineAdult = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const engineKid = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });

  assert.equal(engineAdult.buildDigest(alice.id, '2026-04-12').templateBlockers.length, 1, 'adult sees blocker');
  assert.equal(engineKid.buildDigest(bob.id, '2026-04-12').templateBlockers.length, 1, 'kid also sees blocker');
});

test('buildDigest: no blockers when space is ready', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-tb-3' });
  const spaceId = seedSpace(db, { name: 'Mudroom', isReady: 1 });
  seedTemplateRun(db, { title: 'School run', ownerId: alice.id, spaceId, date: '2026-04-12' });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.templateBlockers.length, 0, 'no blockers when space is ready');
});

test('buildDigest: no blockers for runs on different date', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-tb-4' });
  const spaceId = seedSpace(db, { name: 'Mudroom', isReady: 0 });
  seedTemplateRun(db, { title: 'School run', ownerId: alice.id, spaceId, date: '2026-04-13' });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.equal(digest.templateBlockers.length, 0, 'runs on other dates should not appear');
});

test('buildDigest: formatted includes departure-blocked section', () => {
  const db = makeDb();
  const alice = seedMember(db, { discordId: 'u-tb-5' });
  const spaceId = seedSpace(db, { name: 'Mudroom', isReady: 0 });
  seedTemplateRun(db, { title: 'School run', ownerId: alice.id, spaceId, date: '2026-04-12', departAt: '08:00' });

  const sm = createSpaceManager({ db });
  const engine = createBriefingEngine({ db, callClaude: stubClaude(), getStates: stubGetStates(), postMessage: async () => {}, spaceManager: sm });
  const digest = engine.buildDigest(alice.id, '2026-04-12');

  assert.ok(digest.formatted.includes('Departure blocked'), 'formatted should include departure-blocked section');
  assert.ok(digest.formatted.includes('School run'), 'formatted should include template title');
  assert.ok(digest.formatted.includes('Mudroom'), 'formatted should include space name');
});
