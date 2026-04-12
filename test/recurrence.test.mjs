// Tests for advanced recurrence — cron expression support (issue #21)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nextDueDate, createProjectManager } from '../orchestrator/projectManager.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.pragma('busy_timeout = 3000');
  return db;
}

function seedMember(db) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', 'u1', 'dm-1', 'adult', '23:00', '05:00', 'America/Chicago', 10)`
  ).run();
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

// ── nextDueDate() ─────────────────────────────────────────────────────────────

test('nextDueDate: daily recurrence advances by 1 day', () => {
  assert.equal(nextDueDate('2026-04-12', 'daily', null), '2026-04-13');
});

test('nextDueDate: weekly recurrence advances by 7 days', () => {
  assert.equal(nextDueDate('2026-04-12', 'weekly', null), '2026-04-19');
});

test('nextDueDate: monthly recurrence advances by 1 month', () => {
  assert.equal(nextDueDate('2026-04-12', 'monthly', null), '2026-05-12');
});

test('nextDueDate: returns null when no recurrence and no cron', () => {
  assert.equal(nextDueDate('2026-04-12', null, null), null);
});

test('nextDueDate: returns null when no due_date and no cron', () => {
  assert.equal(nextDueDate(null, 'weekly', null), null);
});

test('nextDueDate: cron expression — every Monday (0 9 * * 1)', () => {
  // 2026-04-12 is a Sunday. Next Monday is 2026-04-13.
  const result = nextDueDate('2026-04-12', null, '0 9 * * 1');
  assert.equal(result, '2026-04-13');
});

test('nextDueDate: cron expression — every other day (0 0 */2 * *)', () => {
  // From 2026-04-12, next hit of */2 should be 2026-04-14
  const result = nextDueDate('2026-04-12', null, '0 0 */2 * *');
  assert.ok(result > '2026-04-12', 'next date should be after start date');
});

test('nextDueDate: cron expression — Mon+Wed+Fri (0 8 * * 1,3,5)', () => {
  // 2026-04-12 is Sunday. Next match is Monday 2026-04-13.
  const result = nextDueDate('2026-04-12', null, '0 8 * * 1,3,5');
  assert.equal(result, '2026-04-13');
});

test('nextDueDate: recurrence_cron takes precedence over recurrence', () => {
  // 2026-04-13 is Monday. With weekly recurrence it would advance to 2026-04-20 (next Monday).
  // With cron '0 9 * * 1' (every Monday) from 2026-04-13 it should land on 2026-04-20 too —
  // but from 2026-04-14 (Tuesday), cron lands on 2026-04-20 while weekly would give 2026-04-21.
  const cronResult  = nextDueDate('2026-04-14', 'weekly', '0 9 * * 1'); // every Monday
  const legacyResult = nextDueDate('2026-04-14', 'weekly', null);        // +7 days = 2026-04-21
  assert.equal(cronResult, '2026-04-20', 'cron should give next Monday');
  assert.equal(legacyResult, '2026-04-21', 'legacy weekly gives +7 days');
  assert.notEqual(cronResult, legacyResult, 'cron overrides legacy recurrence');
});

test('nextDueDate: invalid cron expression throws', () => {
  assert.throws(
    () => nextDueDate('2026-04-12', null, 'not a cron'),
    /Error/,
  );
});

// ── complete() with recurrence_cron ───────────────────────────────────────────

function makeTask(db, { projectId, recurrence = null, recurrenceCron = null, dueDate = '2026-04-12' } = {}) {
  return db.prepare(`
    INSERT INTO tasks (project_id, title, status, recurrence, recurrence_cron, due_date, created_from)
    VALUES (?, 'Test task', 'todo', ?, ?, ?, 'manual')
  `).run(projectId, recurrence, recurrenceCron, dueDate).lastInsertRowid;
}

test('complete(): cron recurrence creates next task with correct due date', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('Test', 'active')`).run().lastInsertRowid;
  const taskId = makeTask(db, { projectId, recurrenceCron: '0 9 * * 1' }); // every Monday

  const mgr = createProjectManager({ db, postMessage: async () => {}, callClaude: async () => '[]', calendar: null });
  await mgr.complete(taskId, member);

  const next = db.prepare(`SELECT * FROM tasks WHERE id != ? AND project_id = ?`).get(taskId, projectId);
  assert.ok(next, 'next recurrence task should be created');
  assert.equal(next.recurrence_cron, '0 9 * * 1', 'next task inherits cron expression');
  assert.ok(next.due_date > '2026-04-12', 'next due date is in the future');
});

test('complete(): cron recurrence task preserves recurrence_cron on new instance', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('Test', 'active')`).run().lastInsertRowid;
  const taskId = makeTask(db, { projectId, recurrenceCron: '0 8 * * 1,3,5' }); // Mon+Wed+Fri

  const mgr = createProjectManager({ db, postMessage: async () => {}, callClaude: async () => '[]', calendar: null });
  await mgr.complete(taskId, member);

  const next = db.prepare(`SELECT * FROM tasks WHERE id != ? AND project_id = ?`).get(taskId, projectId);
  assert.equal(next.recurrence_cron, '0 8 * * 1,3,5');
  assert.equal(next.recurrence, null, 'legacy recurrence should remain null');
});

test('complete(): legacy recurrence still works alongside cron column', async () => {
  const db = makeDb();
  const member = seedMember(db);
  const projectId = db.prepare(`INSERT INTO projects (title, status) VALUES ('Test', 'active')`).run().lastInsertRowid;
  const taskId = makeTask(db, { projectId, recurrence: 'weekly' });

  const mgr = createProjectManager({ db, postMessage: async () => {}, callClaude: async () => '[]', calendar: null });
  await mgr.complete(taskId, member);

  const next = db.prepare(`SELECT * FROM tasks WHERE id != ? AND project_id = ?`).get(taskId, projectId);
  assert.ok(next, 'next recurrence task created');
  assert.equal(next.recurrence, 'weekly');
  assert.equal(next.recurrence_cron, null);
  assert.equal(next.due_date, '2026-04-19');
});
