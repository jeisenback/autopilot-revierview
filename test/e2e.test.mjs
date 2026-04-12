// E2E integration tests — issue #20
// Exercises full stack with in-memory SQLite, mocked Claude, mocked response server,
// mocked HA. No real network calls. No real crons fired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createBriefingEngine } from '../orchestrator/briefingEngine.mjs';
import { createProjectManager } from '../orchestrator/projectManager.mjs';
import { createApprovalManager } from '../orchestrator/approvalManager.mjs';
import { createHaEventHandler } from '../orchestrator/haAdapter.mjs';
import { createSuppressionModel } from '../orchestrator/suppressionModel.mjs';
import { createIntentParser } from '../orchestrator/intentParser.mjs';
import { createRouter } from '../orchestrator/commandRouter.mjs';
import { createResponseFormatter } from '../orchestrator/responseFormatter.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

// ── shared helpers ────────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.pragma('busy_timeout = 3000');
  return db;
}

function seedMember(db, { name = 'Alice', discordId = 'u-e2e-1', role = 'adult', channelId = 'dm-1' } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES (?, ?, ?, ?, '23:00', '05:00', 'America/Chicago', 10)`
  ).run(name, discordId, channelId, role);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

// Minimal mock response server: captures POSTs, returns { ok: true, message_id: 'mock-id' }.
async function startMockResponseServer() {
  const received = [];
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      received.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message_id: 'mock-msg-id' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, received, url: `http://127.0.0.1:${port}` });
    });
  });
}

// Build a fully-wired orchestrator using only in-memory db — no singletons.
function makeOrchestrator(db, { callClaude = async () => '[]' } = {}) {
  const pm = createProjectManager({ db, callClaude, postMessage: async () => {} });
  const am = createApprovalManager({ db, postMessage: async () => ({ message_id: 'mock' }), editMessage: async () => {} });
  const sm = createSuppressionModel({ db });
  const rf = createResponseFormatter({ callClaude: async (_sys, prompt) => `echo: ${prompt}` });
  const { parseIntent } = createIntentParser({ callClaude: async () => '{"intent":"unknown","command":null,"confidence":0}' });
  const router = createRouter({
    approvalManager: am,
    projectManager: pm,
    suppressionModel: sm,
    responseFormatter: rf,
  });

  return {
    async handle(body) {
      const discordUserId = body?.author?.discord_user_id ?? body?.author;
      if (!discordUserId) return "I don't know who you are — contact an admin to register.";
      const member = db.prepare(`SELECT * FROM members WHERE discord_user_id = ?`).get(discordUserId);
      if (!member) return "You're not registered.";
      if (body?.event_type === 'reaction') {
        return router.dispatch({ intent: 'reaction', command: null }, member, body);
      }
      const intent = await parseIntent(body?.content ?? '');
      return router.dispatch(intent, member, body);
    },
  };
}

// ── E2E 1: /project add → decompose → tasks created → checklist returned ─────

test('E2E: /project add → Claude decomposes → tasks inserted → checklist returned', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'e2e-u1' });

  const claudeResponse = JSON.stringify([
    { title: 'Buy paint', estimated_cost: 20, notes: 'Exterior latex' },
    { title: 'Sand walls', estimated_cost: 0, notes: '' },
    { title: 'Apply coat', estimated_cost: 0, notes: '' },
  ]);

  const pm = createProjectManager({
    db,
    callClaude: async () => claudeResponse,
    postMessage: async () => {},
    approvalThreshold: 25,
  });

  const result = await pm.create('Paint bedroom', member);

  // Verify DB state
  const project = db.prepare(`SELECT * FROM projects WHERE title='Paint bedroom'`).get();
  assert.ok(project, 'project should be created');

  const tasks = db.prepare(`SELECT * FROM tasks WHERE project_id=?`).all(project.id);
  assert.equal(tasks.length, 3);
  assert.ok(tasks.find(t => t.title === 'Buy paint'));
  assert.ok(tasks.find(t => t.title === 'Sand walls'));

  // All tasks under threshold — should be todo, not awaiting_approval
  assert.ok(tasks.every(t => t.status === 'todo'));
  assert.ok(tasks.every(t => t.requires_approval === 0));

  // Checklist returned
  assert.ok(result.includes('Paint bedroom'));
  assert.ok(result.includes('Buy paint'));
  assert.ok(result.includes('Sand walls'));
  assert.ok(result.includes('Apply coat'));
});

test('E2E: /project add with high-cost task → requires_approval=1, status=awaiting_approval', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'e2e-u2' });

  const postMessages = [];
  const pm = createProjectManager({
    db,
    callClaude: async () => JSON.stringify([
      { title: 'Buy lumber', estimated_cost: 200, notes: '' },
    ]),
    postMessage: async (ch, text) => { postMessages.push({ ch, text }); },
    approvalThreshold: 25,
  });

  await pm.create('Build deck', member);

  const task = db.prepare(`SELECT * FROM tasks WHERE title='Buy lumber'`).get();
  assert.equal(task.requires_approval, 1);
  assert.equal(task.status, 'awaiting_approval');
  // Approval DM should have been queued
  assert.equal(postMessages.length, 1);
  assert.ok(postMessages[0].text.includes('approval'));
});

// ── E2E 2: Morning briefing → HA state → Claude → posted to channel ──────────

test('E2E: morning briefing fetches HA state and posts Claude-generated text', async () => {
  const db = makeDb();
  const mock = await startMockResponseServer();

  try {
    const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('Fix roof', 'active')`).run().lastInsertRowid;
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`INSERT INTO tasks (project_id, title, status, due_date) VALUES (?, 'Replace shingles', 'todo', ?)`).run(projectId, today);

    const generatedText = 'Good morning! You have 1 task due today: Replace shingles.';
    const engine = createBriefingEngine({
      db,
      callClaude: async (ctx) => {
        assert.ok(ctx.includes('Replace shingles'), 'Claude context should include due task');
        return generatedText;
      },
      getStates: async () => [{ entity_id: 'sensor.front_door', state: 'closed' }],
      postMessage: async (channelId, text) => {
        const res = await fetch(mock.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId, content: text }),
        });
        return res.json();
      },
      channelId: 'family-channel',
      monitoredEntities: ['sensor.front_door'],
    });

    await engine.sendMorningBriefing();

    assert.equal(mock.received.length, 1, 'exactly one message should be posted');
    assert.equal(mock.received[0].body.channelId, 'family-channel');
    assert.equal(mock.received[0].body.content, generatedText);
  } finally {
    mock.server.close();
  }
});

test('E2E: morning briefing posts fallback message when Claude fails', async () => {
  const db = makeDb();
  const posted = [];

  const engine = createBriefingEngine({
    db,
    callClaude: async () => { throw new Error('API down'); },
    getStates: async () => [],
    postMessage: async (channelId, text) => { posted.push({ channelId, text }); },
    channelId: 'family-channel',
    monitoredEntities: [],
  });

  await engine.sendMorningBriefing();

  assert.equal(posted.length, 1);
  assert.ok(posted[0].text.includes('unavailable') || posted[0].text.includes('manually'));
});

// ── E2E 3: HA water leak → CRITICAL task → member DM'd immediately ────────────

test('E2E: HA water_leak wet → CRITICAL task created with priority=1', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'e2e-leak-1', channelId: 'dm-leak-1' });

  const handler = createHaEventHandler({ db });
  await handler({
    entity_id: 'binary_sensor.water_leak',
    state: 'wet',
  });

  // Task should be created — title is "Water leak detected: binary_sensor.water_leak"
  const task = db.prepare(`SELECT * FROM tasks WHERE title LIKE '%Water leak%'`).get();
  assert.ok(task, 'CRITICAL task should be created');
  assert.equal(task.priority, 1);
  assert.equal(task.status, 'todo');

  // Event should be logged as processed=1
  const event = db.prepare(`SELECT * FROM events WHERE source='ha'`).get();
  assert.equal(event.processed, 1);
  assert.equal(event.task_created_id, task.id);
});

// ── E2E 4: Approval flow — task → approval posted → 👍 → task activated ───────

test('E2E: approval flow — task awaiting_approval → 👍 → task becomes todo', async () => {
  const db = makeDb();
  const mock = await startMockResponseServer();

  try {
    const member = seedMember(db, { discordId: 'e2e-appr-1', channelId: 'dm-appr-1' });
    const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('Fix fence', 'active')`).run().lastInsertRowid;

    // Create task requiring approval
    const taskId = db.prepare(`
      INSERT INTO tasks (project_id, title, estimated_cost, status, requires_approval)
      VALUES (?, 'Buy lumber', 150, 'awaiting_approval', 1)
    `).run(projectId).lastInsertRowid;
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);

    const postedMessages = [];
    const editedMessages = [];
    const mgr = createApprovalManager({
      db,
      postMessage: async (channelId, text) => {
        postedMessages.push({ channelId, text });
        return { message_id: 'appr-msg-001' };
      },
      editMessage: async (channelId, messageId, text) => {
        editedMessages.push({ channelId, messageId, text });
      },
    });

    // Step 1: request approval
    await mgr.request(task, member);

    const approval = db.prepare(`SELECT * FROM approvals WHERE task_id=?`).get(taskId);
    assert.ok(approval, 'approval row should exist');
    assert.equal(approval.status, 'pending');
    assert.ok(postedMessages.length === 1);
    assert.ok(postedMessages[0].text.includes('150') || postedMessages[0].text.includes('$150'));

    // Step 2: 👍 reaction arrives
    await mgr.resolve('appr-msg-001', '👍');

    const updatedApproval = db.prepare(`SELECT * FROM approvals WHERE id=?`).get(approval.id);
    const updatedTask = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
    assert.equal(updatedApproval.status, 'approved');
    assert.equal(updatedTask.status, 'todo');
    assert.equal(editedMessages.length, 1);
    assert.ok(editedMessages[0].text.toLowerCase().includes('approved'));
  } finally {
    mock.server.close();
  }
});

test('E2E: approval flow — 👎 → task becomes skipped', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'e2e-appr-2', channelId: 'dm-appr-2' });
  const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('P', 'active')`).run().lastInsertRowid;
  const taskId = db.prepare(`INSERT INTO tasks (project_id, title, status, requires_approval) VALUES (?, 'Expensive item', 'awaiting_approval', 1)`).run(projectId).lastInsertRowid;
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);

  const mgr = createApprovalManager({
    db,
    postMessage: async () => ({ message_id: 'appr-msg-002' }),
    editMessage: async () => {},
  });

  await mgr.request(task, member);
  await mgr.resolve('appr-msg-002', '👎');

  const updatedTask = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
  assert.equal(updatedTask.status, 'skipped');
});

// ── E2E 5: Full orchestrator path — inbound message → intent → dispatch ───────

test('E2E: orchestrator handles /project list end-to-end', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'e2e-orch-1' });

  db.prepare(`INSERT INTO projects (title, status) VALUES ('Active project', 'active')`).run();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('Done project', 'done')`).run();

  const orch = makeOrchestrator(db);

  const result = await orch.handle({
    author: { discord_user_id: 'e2e-orch-1' },
    content: '/project list',
  });

  assert.ok(typeof result === 'string', 'should return a string');
  assert.ok(result.includes('Active project'), 'should include open project');
});

test('E2E: orchestrator returns "not registered" for unknown user', async () => {
  const db = makeDb();
  const orch = makeOrchestrator(db);

  const result = await orch.handle({
    author: { discord_user_id: 'unknown-user' },
    content: '/project list',
  });

  assert.ok(result.toLowerCase().includes("not registered") || result.toLowerCase().includes("registered"));
});

test('E2E: orchestrator kid role guard blocks /project add', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'e2e-kid-1', role: 'kid' });

  const orch = makeOrchestrator(db);

  const result = await orch.handle({
    author: { discord_user_id: 'e2e-kid-1' },
    content: '/project add Build a treehouse',
  });

  assert.ok(result.toLowerCase().includes('parent'), 'kid should be told to ask a parent');
});

test('E2E: orchestrator routes reaction to approvalManager.resolve', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'e2e-react-1' });
  const projectId = db.prepare(`INSERT INTO projects (title) VALUES ('P')`).run().lastInsertRowid;
  const taskId = db.prepare(`INSERT INTO tasks (project_id, title, status) VALUES (?, 'T', 'awaiting_approval')`).run(projectId).lastInsertRowid;
  db.prepare(`
    INSERT INTO approvals (task_id, requested_by, discord_message_id, discord_channel_id, status, expires_at)
    VALUES (?, ?, 'reaction-msg-001', 'ch-1', 'pending', datetime('now', '+1 day'))
  `).run(taskId, member.id);

  const orch = makeOrchestrator(db);

  await orch.handle({
    author: { discord_user_id: 'e2e-react-1' },
    event_type: 'reaction',
    emoji: '👍',
    discord_message_id: 'reaction-msg-001',
  });

  const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
  assert.equal(task.status, 'todo');
});

// ── E2E 6: Suppression model integration ─────────────────────────────────────

test('E2E: suppression blocks normal notifications during quiet hours', () => {
  const db = makeDb();

  // Member with quiet hours covering "now" in UTC
  const now = new Date();
  const h = now.getUTCHours();
  // Set quiet window to cover current UTC hour
  const start = `${String(h).padStart(2, '0')}:00`;
  const end = `${String((h + 1) % 24).padStart(2, '0')}:00`;

  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Bob', 'u-quiet', 'adult', ?, ?, 'UTC', 5)`
  ).run(start, end);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);

  const member = db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
  const state = db.prepare('SELECT * FROM notification_state WHERE member_id=?').get(lastInsertRowid);

  const sm = createSuppressionModel({ db });
  // NORMAL priority (2) — should be blocked by quiet hours
  assert.equal(sm.canNotify(member, state, 2), false, 'normal notification should be suppressed in quiet hours');
  // CRITICAL priority (1) — bypasses quiet hours
  assert.equal(sm.canNotify(member, state, 1), true, 'critical notification should bypass quiet hours');
});

test('E2E: daily limit blocks notifications after max reached', () => {
  const db = makeDb();
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Carol', 'u-daily', 'adult', '23:00', '05:00', 'UTC', 3)`
  ).run();
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 3, date('now'))`).run(lastInsertRowid);

  const member = db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
  const state = db.prepare('SELECT * FROM notification_state WHERE member_id=?').get(lastInsertRowid);

  const sm = createSuppressionModel({ db });
  assert.equal(sm.canNotify(member, state, 2), false, 'should be blocked after hitting daily limit');
  assert.equal(sm.canNotify(member, state, 1), true, 'critical bypasses daily limit');
});
