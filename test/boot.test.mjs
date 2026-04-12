// Tests for startup recovery in boot.mjs — issue #17
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
    `INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', 'u1', 'adult', '23:00', '05:00', 'UTC', 5)`
  ).run();
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return lastInsertRowid;
}

// Extracted boot logic for testing without real cron or module side-effects.
function runBoot(db) {
  const abandoned = db.prepare(`
    UPDATE events SET processed = 3
    WHERE processed = 0 AND created_at < datetime('now', '-24 hours')
  `).run();

  const memberCount  = db.prepare(`SELECT COUNT(*) as n FROM members`).get().n;
  const openProjects = db.prepare(`SELECT COUNT(*) as n FROM projects WHERE status != 'done'`).get().n;
  const pendingEvents = db.prepare(`SELECT COUNT(*) as n FROM events WHERE processed = 0`).get().n;

  return { abandoned: abandoned.changes, memberCount, openProjects, pendingEvents };
}

// ── stale event abandonment ───────────────────────────────────────────────────

test('boot: stale unprocessed events (>24h) are marked processed=3', () => {
  const db = makeDb();
  seedMember(db);

  // Insert a stale event (2 days ago)
  db.prepare(`
    INSERT INTO events (source, event_type, payload, processed, created_at)
    VALUES ('ha', 'state_changed', '{}', 0, datetime('now', '-2 days'))
  `).run();

  const { abandoned } = runBoot(db);

  assert.equal(abandoned, 1);
  const ev = db.prepare(`SELECT processed FROM events`).get();
  assert.equal(ev.processed, 3);
});

test('boot: recent unprocessed events (<24h) are not abandoned', () => {
  const db = makeDb();
  seedMember(db);

  db.prepare(`
    INSERT INTO events (source, event_type, payload, processed, created_at)
    VALUES ('ha', 'state_changed', '{}', 0, datetime('now', '-1 hour'))
  `).run();

  const { abandoned } = runBoot(db);

  assert.equal(abandoned, 0);
  const ev = db.prepare(`SELECT processed FROM events`).get();
  assert.equal(ev.processed, 0);
});

test('boot: already-processed events are not touched', () => {
  const db = makeDb();
  seedMember(db);

  db.prepare(`
    INSERT INTO events (source, event_type, payload, processed, created_at)
    VALUES ('ha', 'state_changed', '{}', 1, datetime('now', '-2 days'))
  `).run();

  const { abandoned } = runBoot(db);

  assert.equal(abandoned, 0);
  const ev = db.prepare(`SELECT processed FROM events`).get();
  assert.equal(ev.processed, 1);
});

test('boot: mixed events — only stale unprocessed ones are abandoned', () => {
  const db = makeDb();
  seedMember(db);

  db.prepare(`INSERT INTO events (source, event_type, payload, processed, created_at) VALUES ('ha', 'x', '{}', 0, datetime('now', '-2 days'))`).run();
  db.prepare(`INSERT INTO events (source, event_type, payload, processed, created_at) VALUES ('ha', 'x', '{}', 0, datetime('now', '-30 minutes'))`).run();
  db.prepare(`INSERT INTO events (source, event_type, payload, processed, created_at) VALUES ('ha', 'x', '{}', 1, datetime('now', '-2 days'))`).run();

  const { abandoned } = runBoot(db);

  assert.equal(abandoned, 1);
  const rows = db.prepare(`SELECT processed FROM events ORDER BY id`).all();
  assert.equal(rows[0].processed, 3); // stale unprocessed → abandoned
  assert.equal(rows[1].processed, 0); // recent unprocessed → untouched
  assert.equal(rows[2].processed, 1); // already done → untouched
});

// ── ready state reporting ─────────────────────────────────────────────────────

test('boot: reports correct member count', () => {
  const db = makeDb();
  seedMember(db);
  const { memberCount } = runBoot(db);
  assert.equal(memberCount, 1);
});

test('boot: reports open project count (excludes done)', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('P1', 'active')`).run();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('P2', 'open')`).run();
  db.prepare(`INSERT INTO projects (title, status) VALUES ('P3', 'done')`).run();
  const { openProjects } = runBoot(db);
  assert.equal(openProjects, 2);
});

test('boot: reports pending event count after abandonment', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO events (source, event_type, payload, processed, created_at) VALUES ('ha', 'x', '{}', 0, datetime('now', '-2 days'))`).run();
  db.prepare(`INSERT INTO events (source, event_type, payload, processed, created_at) VALUES ('ha', 'x', '{}', 0, datetime('now', '-10 minutes'))`).run();

  const { pendingEvents } = runBoot(db);

  // stale one was abandoned, recent one remains
  assert.equal(pendingEvents, 1);
});
