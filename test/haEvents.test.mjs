import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHaEventHandler } from '../orchestrator/haAdapter.mjs';

// ─── in-memory DB ─────────────────────────────────────────────────────────────

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedProject(db, title = 'Outdoor project') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO projects (title, status) VALUES (?, 'active')`
  ).run(title);
  return lastInsertRowid;
}

function seedAdult(db, discordId = 'ha-adult') {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, 'adult', '23:00', '05:00', 'America/Chicago', 5)`
  ).run(discordId);
  db.prepare(`INSERT INTO notification_state (member_id, daily_count, daily_reset_date) VALUES (?, 0, date('now'))`).run(lastInsertRowid);
  return lastInsertRowid;
}

// ─── webhook auth tests (pure HTTP logic, no DB needed) ───────────────────────

import http from 'http';

function makeRequest({ method = 'POST', url = '/ha-events', headers = {}, body = '{}' } = {}) {
  return { method, url, headers, body };
}

import { checkHaAuth } from '../orchestrator/haAdapter.mjs';

test('auth: missing HA_WEBHOOK_SECRET → 503', () => {
  const result = checkHaAuth('', 'Bearer anything');
  assert.equal(result.status, 503);
});

test('auth: correct secret → 200 (pass)', () => {
  const result = checkHaAuth('mysecret', 'Bearer mysecret');
  assert.equal(result.status, 200);
});

test('auth: wrong secret → 401', () => {
  const result = checkHaAuth('mysecret', 'Bearer wrongsecret');
  assert.equal(result.status, 401);
});

test('auth: no auth header → 401', () => {
  const result = checkHaAuth('mysecret', '');
  assert.equal(result.status, 401);
});

// ─── pre-filter handler tests ─────────────────────────────────────────────────

test('water_leak state=wet → CRITICAL task created, priority=1', async () => {
  const db = makeDb();
  const handler = createHaEventHandler({ db });

  await handler({ entity_id: 'sensor.water_leak_kitchen', state: 'wet' });

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].priority, 1);
  assert.ok(tasks[0].title.toLowerCase().includes('water') || tasks[0].title.toLowerCase().includes('leak'));
});

test('water_leak task logged in events table with processed=1', async () => {
  const db = makeDb();
  const handler = createHaEventHandler({ db });

  await handler({ entity_id: 'sensor.water_leak_bathroom', state: 'wet' });

  const event = db.prepare('SELECT * FROM events WHERE source=?').get('ha');
  assert.ok(event, 'event should be logged');
  assert.equal(event.processed, 1);
});

test('battery low → NORMAL task (priority=2), assigned to first adult', async () => {
  const db = makeDb();
  const adultId = seedAdult(db);
  const handler = createHaEventHandler({ db });

  await handler({ entity_id: 'sensor.smoke_detector_battery_level', state: 'low' });

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].priority, 2);
  assert.equal(tasks[0].assigned_to, adultId);
});

test('battery not low → no task created, logged as skipped', async () => {
  const db = makeDb();
  const handler = createHaEventHandler({ db });

  await handler({ entity_id: 'sensor.smoke_detector_battery_level', state: '85' });

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 0);
  const event = db.prepare('SELECT * FROM events').get();
  assert.equal(event.processed, 2); // skipped
});

test('unknown entity → processed=2 (skipped), no task created', async () => {
  const db = makeDb();
  const handler = createHaEventHandler({ db });

  await handler({ entity_id: 'sensor.totally_unknown_thing', state: 'on' });

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 0);
  const event = db.prepare('SELECT * FROM events').get();
  assert.equal(event.processed, 2);
});

test('water_leak state=dry → no task (only wet triggers)', async () => {
  const db = makeDb();
  const handler = createHaEventHandler({ db });

  await handler({ entity_id: 'sensor.water_leak_kitchen', state: 'dry' });

  const tasks = db.prepare('SELECT * FROM tasks').all();
  assert.equal(tasks.length, 0);
});
