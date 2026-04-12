import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApprovalManager } from '../orchestrator/approvalManager.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedMember(db, discordId = 'appr-u1', channelId = 'dm-channel-1') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, ?, 'adult', '23:00', '05:00', 'America/Chicago', 5)`
  ).run(discordId, channelId);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return lastInsertRowid;
}

function seedProject(db) {
  return db.prepare(`INSERT INTO projects (title, status) VALUES ('Test', 'active')`).run().lastInsertRowid;
}

function seedTask(db, projectId, { status = 'awaiting_approval', cost = 50 } = {}) {
  return db.prepare(
    `INSERT INTO tasks (project_id, title, estimated_cost, status, requires_approval)
     VALUES (?, 'Fix the roof', ?, ?, 1)`
  ).run(projectId, cost, status).lastInsertRowid;
}

function seedApproval(db, { taskId, memberId, messageId = 'msg-xyz', channelId = 'ch-1', status = 'pending', expiresAt }) {
  expiresAt = expiresAt || new Date(Date.now() + 86400000).toISOString();
  return db.prepare(
    `INSERT INTO approvals (task_id, requested_by, discord_message_id, discord_channel_id, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(taskId, memberId, messageId, channelId, status, expiresAt).lastInsertRowid;
}

function capturePostMessage(messageId = 'new-msg-id') {
  const calls = [];
  const fn = async (channelId, text) => { calls.push({ channelId, text }); return { message_id: messageId }; };
  fn.calls = calls;
  return fn;
}

function captureEditMessage() {
  const calls = [];
  const fn = async (channelId, messageId, text) => { calls.push({ channelId, messageId, text }); };
  fn.calls = calls;
  return fn;
}

// ─── request() ───────────────────────────────────────────────────────────────

test('request(): inserts pending approval row with correct task_id and requested_by', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const postMessage = capturePostMessage('msg-001');
  const mgr = createApprovalManager({ db, postMessage });

  await mgr.request(task, member);

  const approval = db.prepare('SELECT * FROM approvals WHERE task_id=?').get(taskId);
  assert.ok(approval, 'approval row should exist');
  assert.equal(approval.task_id, taskId);
  assert.equal(approval.requested_by, memberId);
  assert.equal(approval.status, 'pending');
});

test('request(): approval discord_message_id matches postMessage return value', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u2', 'dm-ch-2');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const postMessage = capturePostMessage('sentinel-msg-id');
  const mgr = createApprovalManager({ db, postMessage });

  await mgr.request(task, member);

  const approval = db.prepare('SELECT * FROM approvals WHERE task_id=?').get(taskId);
  assert.equal(approval.discord_message_id, 'sentinel-msg-id');
});

test('request(): posts to requestedBy discord_dm_channel_id', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u3', 'dm-ch-3');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const postMessage = capturePostMessage('m1');
  const mgr = createApprovalManager({ db, postMessage });

  await mgr.request(task, member);

  assert.equal(postMessage.calls.length, 1);
  assert.equal(postMessage.calls[0].channelId, 'dm-ch-3');
});

test('request(): message text includes task title and cost', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u4', 'dm-ch-4');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId, { cost: 75 });
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const postMessage = capturePostMessage('m2');
  const mgr = createApprovalManager({ db, postMessage });

  await mgr.request(task, member);

  const text = postMessage.calls[0].text;
  assert.ok(text.includes('Fix the roof'), 'message should include task title');
  assert.ok(text.includes('75') || text.includes('$75'), 'message should include cost');
});

test('request(): expires_at is in the future', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u5', 'dm-ch-5');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const mgr = createApprovalManager({ db, postMessage: capturePostMessage('m3') });

  await mgr.request(task, member);

  const approval = db.prepare('SELECT * FROM approvals WHERE task_id=?').get(taskId);
  assert.ok(approval.expires_at > new Date().toISOString(), 'expires_at should be in the future');
});

// ─── resolve() ───────────────────────────────────────────────────────────────

test('resolve(): 👍 → approval=approved, task=todo', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u6');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  seedApproval(db, { taskId, memberId, messageId: 'msg-thumbsup' });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.resolve('msg-thumbsup', '👍');

  const approval = db.prepare('SELECT * FROM approvals WHERE discord_message_id=?').get('msg-thumbsup');
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  assert.equal(approval.status, 'approved');
  assert.equal(task.status, 'todo');
});

test('resolve(): 👎 → approval=denied, task=skipped', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u7');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  seedApproval(db, { taskId, memberId, messageId: 'msg-thumbsdown' });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.resolve('msg-thumbsdown', '👎');

  const approval = db.prepare('SELECT * FROM approvals WHERE discord_message_id=?').get('msg-thumbsdown');
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  assert.equal(approval.status, 'denied');
  assert.equal(task.status, 'skipped');
});

test('resolve(): 👍 → Discord message edited with approval confirmation', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u8');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  seedApproval(db, { taskId, memberId, messageId: 'msg-edit-test', channelId: 'ch-edit' });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.resolve('msg-edit-test', '👍');

  assert.equal(editMessage.calls.length, 1);
  assert.equal(editMessage.calls[0].channelId, 'ch-edit');
  assert.equal(editMessage.calls[0].messageId, 'msg-edit-test');
  assert.ok(editMessage.calls[0].text.toLowerCase().includes('approved'));
});

test('resolve(): 👎 → Discord message edited with denial notice', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u9');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  seedApproval(db, { taskId, memberId, messageId: 'msg-deny-test', channelId: 'ch-deny' });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.resolve('msg-deny-test', '👎');

  assert.equal(editMessage.calls.length, 1);
  assert.ok(editMessage.calls[0].text.toLowerCase().includes('denied') || editMessage.calls[0].text.toLowerCase().includes('skipped'));
});

test('resolve(): unknown discord_message_id → no crash, no DB change', async () => {
  const db = makeDb();
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await assert.doesNotReject(() => mgr.resolve('nonexistent-msg', '👍'));
  assert.equal(editMessage.calls.length, 0);
});

test('resolve(): already-resolved approval → ignored', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'appr-u10');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId, { status: 'todo' });
  seedApproval(db, { taskId, memberId, messageId: 'msg-already-done', status: 'approved' });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.resolve('msg-already-done', '👎');

  const approval = db.prepare('SELECT * FROM approvals WHERE discord_message_id=?').get('msg-already-done');
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  assert.equal(approval.status, 'approved'); // unchanged
  assert.equal(task.status, 'todo');          // unchanged
  assert.equal(editMessage.calls.length, 0);
});
