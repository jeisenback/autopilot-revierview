import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApprovalManager } from '../orchestrator/approvalManager.mjs';
import { resetDailyCounts } from '../orchestrator/crons.mjs';

// ─── in-memory DB ─────────────────────────────────────────────────────────────

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedMember(db, discordId = 'cron-u1') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, 'adult', '23:00', '05:00', 'America/Chicago', 5)`
  ).run(discordId);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 3, date('now'))`).run(lastInsertRowid);
  return lastInsertRowid;
}

function seedProject(db) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO projects (title, status) VALUES ('Test project', 'active')`
  ).run();
  return lastInsertRowid;
}

function seedTask(db, projectId, status = 'awaiting_approval') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO tasks (project_id, title, status, requires_approval) VALUES (?, 'Test task', ?, 1)`
  ).run(projectId, status);
  return lastInsertRowid;
}

function seedApproval(db, { taskId, memberId, status = 'pending', expiresAt }) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO approvals (task_id, requested_by, discord_message_id, discord_channel_id, status, expires_at)
     VALUES (?, ?, ?, 'channel-123', ?, ?)`
  ).run(taskId, memberId, `msg-${Date.now()}-${Math.random()}`, status, expiresAt);
  return lastInsertRowid;
}

function past(hours = 1) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function future(hours = 24) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function captureEditMessage() {
  const calls = [];
  const fn = async (channelId, messageId, text) => { calls.push({ channelId, messageId, text }); };
  fn.calls = calls;
  return fn;
}

// ─── expireStale() ────────────────────────────────────────────────────────────

test('expireStale(): pending approval past expires_at → status=expired, task=skipped', async () => {
  const db = makeDb();
  const memberId = seedMember(db);
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const approvalId = seedApproval(db, { taskId, memberId, expiresAt: past() });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.expireStale();

  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assert.equal(approval.status, 'expired');
  assert.equal(task.status, 'skipped');
});

test('expireStale(): Discord message edited with expiry notice', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'cron-u2');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  seedApproval(db, { taskId, memberId, expiresAt: past() });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.expireStale();

  assert.equal(editMessage.calls.length, 1);
  assert.ok(editMessage.calls[0].text.toLowerCase().includes('expired') || editMessage.calls[0].text.toLowerCase().includes('skipped'));
  assert.equal(editMessage.calls[0].channelId, 'channel-123');
});

test('expireStale(): no pending rows → no-op, no error', async () => {
  const db = makeDb();
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await assert.doesNotReject(() => mgr.expireStale());
  assert.equal(editMessage.calls.length, 0);
});

test('expireStale(): approval not yet expired → untouched', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'cron-u3');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const approvalId = seedApproval(db, { taskId, memberId, expiresAt: future() });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.expireStale();

  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  assert.equal(approval.status, 'pending');
  assert.equal(task.status, 'awaiting_approval');
  assert.equal(editMessage.calls.length, 0);
});

test('expireStale(): already-expired approval not re-processed', async () => {
  const db = makeDb();
  const memberId = seedMember(db, 'cron-u4');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId, 'skipped');
  seedApproval(db, { taskId, memberId, status: 'expired', expiresAt: past() });
  const editMessage = captureEditMessage();
  const mgr = createApprovalManager({ db, editMessage });

  await mgr.expireStale();

  assert.equal(editMessage.calls.length, 0);
});

// ─── resetDailyCounts() ───────────────────────────────────────────────────────

test('resetDailyCounts(): sets daily_count=0 for all members', () => {
  const db = makeDb();
  seedMember(db, 'reset-u1');
  seedMember(db, 'reset-u2');

  // Confirm counts are non-zero before reset
  const before = db.prepare('SELECT daily_count FROM notification_state').all();
  assert.ok(before.every(r => r.daily_count === 3));

  resetDailyCounts(db);

  const after = db.prepare('SELECT daily_count FROM notification_state').all();
  assert.ok(after.every(r => r.daily_count === 0));
});

test('resetDailyCounts(): updates daily_reset_date to today', () => {
  const db = makeDb();
  seedMember(db, 'reset-u3');

  resetDailyCounts(db);

  const today = new Date().toISOString().split('T')[0];
  const row = db.prepare('SELECT daily_reset_date FROM notification_state').get();
  assert.equal(row.daily_reset_date, today);
});

test('resetDailyCounts(): no members → no-op, no error', () => {
  const db = makeDb();
  assert.doesNotThrow(() => resetDailyCounts(db));
});
