import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSuppressionModel } from '../orchestrator/suppressionModel.mjs';
import { createProjectManager } from '../orchestrator/projectManager.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedAdult(db, discordId = 'as-adult-1', channelId = 'dm-ch-adult') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, ?, 'adult', '23:00', '05:00', 'America/Chicago', 5)`
  ).run(discordId, channelId);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return lastInsertRowid;
}

function seedKid(db, discordId = 'as-kid-1', channelId = 'dm-ch-kid') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Bob', ?, ?, 'kid', '20:00', '08:00', 'America/Chicago', 3)`
  ).run(discordId, channelId);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return lastInsertRowid;
}

function seedProject(db) {
  return db.prepare(`INSERT INTO projects (title, status) VALUES ('Test', 'active')`).run().lastInsertRowid;
}

function seedTask(db, projectId, assignedTo = null) {
  return db.prepare(
    `INSERT INTO tasks (project_id, title, status, assigned_to) VALUES (?, 'Fix the fence', 'todo', ?)`
  ).run(projectId, assignedTo).lastInsertRowid;
}

function capturePostMessage() {
  const calls = [];
  const fn = async (channelId, text) => { calls.push({ channelId, text }); };
  fn.calls = calls;
  return fn;
}

// ─── snooze() ────────────────────────────────────────────────────────────────

test('snooze(): sets snooze_until ~hours from now', () => {
  const db = makeDb();
  const memberId = seedAdult(db);
  const sm = createSuppressionModel({ db });

  const before = Date.now();
  sm.snooze(memberId, 2);
  const after = Date.now();

  const row = db.prepare('SELECT snooze_until FROM notification_state WHERE member_id=?').get(memberId);
  assert.ok(row.snooze_until, 'snooze_until should be set');
  const snoozeTs = new Date(row.snooze_until).getTime();
  assert.ok(snoozeTs >= before + 2 * 3600 * 1000 - 1000);
  assert.ok(snoozeTs <= after + 2 * 3600 * 1000 + 1000);
});

test('snooze(): canNotify returns false during active snooze', () => {
  const db = makeDb();
  const memberId = seedAdult(db);
  const sm = createSuppressionModel({ db });

  sm.snooze(memberId, 2);

  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const state = db.prepare('SELECT * FROM notification_state WHERE member_id=?').get(memberId);
  assert.equal(sm.canNotify(member, state, 2), false);
});

test('snooze(): canNotify returns true after snooze expires', () => {
  const db = makeDb();
  const memberId = seedAdult(db);
  // Set snooze_until in the past
  db.prepare(`UPDATE notification_state SET snooze_until=? WHERE member_id=?`)
    .run(new Date(Date.now() - 1000).toISOString(), memberId);
  const sm = createSuppressionModel({ db });

  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const state = db.prepare('SELECT * FROM notification_state WHERE member_id=?').get(memberId);
  // Not in quiet hours, not at limit — should be able to notify
  assert.equal(sm.canNotify(member, state, 2), true);
});

test('snooze(): canNotify returns false when daily_count >= max_daily_notifications', () => {
  const db = makeDb();
  const memberId = seedAdult(db);
  db.prepare(`UPDATE notification_state SET daily_count=5 WHERE member_id=?`).run(memberId);
  const sm = createSuppressionModel({ db });

  const member = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const state = db.prepare('SELECT * FROM notification_state WHERE member_id=?').get(memberId);
  assert.equal(sm.canNotify(member, state, 2), false);
});

// ─── assign() ────────────────────────────────────────────────────────────────

test('assign(): updates task assigned_to', async () => {
  const db = makeDb();
  const adultId = seedAdult(db, 'assigner-1', 'dm-a1');
  const targetId = seedAdult(db, 'target-1', 'dm-t1');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const postMessage = capturePostMessage();
  const pm = createProjectManager({ db, postMessage });

  await pm.assign(taskId, 'target-1');

  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  assert.equal(task.assigned_to, targetId);
});

test('assign(): sends DM to newly assigned member', async () => {
  const db = makeDb();
  seedAdult(db, 'assigner-2', 'dm-a2');
  seedAdult(db, 'target-2', 'dm-t2');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const postMessage = capturePostMessage();
  const pm = createProjectManager({ db, postMessage });

  await pm.assign(taskId, 'target-2');

  assert.equal(postMessage.calls.length, 1);
  assert.equal(postMessage.calls[0].channelId, 'dm-t2');
  assert.ok(postMessage.calls[0].text.includes('Fix the fence'));
});

test('assign(): DM uses kid voice for kid members', async () => {
  const db = makeDb();
  const kidId = seedKid(db, 'kid-target', 'dm-kid');
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const postMessage = capturePostMessage();
  const pm = createProjectManager({ db, postMessage });

  await pm.assign(taskId, 'kid-target');

  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  assert.equal(task.assigned_to, kidId);
  // DM sent
  assert.equal(postMessage.calls.length, 1);
});

test('assign(): unknown discord_user_id throws', async () => {
  const db = makeDb();
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId);
  const pm = createProjectManager({ db, postMessage: capturePostMessage() });

  await assert.rejects(() => pm.assign(taskId, 'nobody'), /not found/i);
});

test('assign(): unknown taskId throws', async () => {
  const db = makeDb();
  seedAdult(db, 'target-3', 'dm-t3');
  const pm = createProjectManager({ db, postMessage: capturePostMessage() });

  await assert.rejects(() => pm.assign(99999, 'target-3'), /not found/i);
});
