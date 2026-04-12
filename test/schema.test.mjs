// Schema tests — verify all tables, columns, and constraints apply cleanly.
// See: GitHub issue #35
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
  return db;
}

function cols(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}

function tables(db) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r => r.name);
}

// ─── schema applies cleanly ───────────────────────────────────────────────────

test('schema: applies without error on fresh in-memory DB', () => {
  assert.doesNotThrow(() => makeDb());
});

test('schema: idempotent — applying twice does not throw', () => {
  const db = makeDb();
  assert.doesNotThrow(() => db.exec(SCHEMA));
});

// ─── spaces table ─────────────────────────────────────────────────────────────

test('schema: spaces table exists', () => {
  const db = makeDb();
  assert.ok(tables(db).includes('spaces'));
});

test('schema: spaces has required columns', () => {
  const db = makeDb();
  const c = cols(db, 'spaces');
  for (const col of ['id', 'name', 'location', 'ready_state', 'is_ready', 'assigned_to', 'created_at']) {
    assert.ok(c.includes(col), `spaces should have column: ${col}`);
  }
});

test('schema: spaces.is_ready defaults to 1', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO spaces (name, ready_state) VALUES ('Mudroom', 'hooks clear')`).run();
  const row = db.prepare(`SELECT is_ready FROM spaces`).get();
  assert.equal(row.is_ready, 1);
});

test('schema: spaces can be inserted and retrieved', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO spaces (name, location, ready_state, is_ready) VALUES (?, ?, ?, ?)`).run('Mudroom', 'entryway', 'hooks clear', 0);
  const row = db.prepare(`SELECT * FROM spaces WHERE name='Mudroom'`).get();
  assert.equal(row.location, 'entryway');
  assert.equal(row.is_ready, 0);
});

test('schema: spaces.assigned_to FK references members', () => {
  const db = makeDb();
  const memberId = db.prepare(`INSERT INTO members (name, discord_user_id, role) VALUES ('Alice', 'u1', 'adult')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(memberId);
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO spaces (name, ready_state, assigned_to) VALUES ('Closet', 'hanging only', ?)`).run(memberId);
  });
});

// ─── space_items table ────────────────────────────────────────────────────────

test('schema: space_items table exists', () => {
  const db = makeDb();
  assert.ok(tables(db).includes('space_items'));
});

test('schema: space_items has required columns', () => {
  const db = makeDb();
  const c = cols(db, 'space_items');
  for (const col of ['id', 'space_id', 'name', 'belongs_here', 'notes']) {
    assert.ok(c.includes(col), `space_items should have column: ${col}`);
  }
});

test('schema: space_items.belongs_here defaults to 1', () => {
  const db = makeDb();
  const spaceId = db.prepare(`INSERT INTO spaces (name, ready_state) VALUES ('Counter', 'clear')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO space_items (space_id, name) VALUES (?, 'Keys')`).run(spaceId);
  const row = db.prepare(`SELECT belongs_here FROM space_items`).get();
  assert.equal(row.belongs_here, 1);
});

test('schema: space_items.space_id FK references spaces', () => {
  const db = makeDb();
  const spaceId = db.prepare(`INSERT INTO spaces (name, ready_state) VALUES ('Mudroom', 'clear')`).run().lastInsertRowid;
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO space_items (space_id, name, belongs_here) VALUES (?, 'Shoe rack', 1)`).run(spaceId);
  });
});

// ─── members.google_tasks_list_id ─────────────────────────────────────────────

test('schema: members has google_tasks_list_id column', () => {
  const db = makeDb();
  assert.ok(cols(db, 'members').includes('google_tasks_list_id'));
});

test('schema: members.google_tasks_list_id is nullable', () => {
  const db = makeDb();
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO members (name, discord_user_id, role) VALUES ('Bob', 'u-bob', 'adult')`).run();
  });
  const row = db.prepare(`SELECT google_tasks_list_id FROM members WHERE discord_user_id='u-bob'`).get();
  assert.equal(row.google_tasks_list_id, null);
});

// ─── tasks.google_task_id ─────────────────────────────────────────────────────

test('schema: tasks has google_task_id column', () => {
  const db = makeDb();
  assert.ok(cols(db, 'tasks').includes('google_task_id'));
});

test('schema: tasks.google_task_id is nullable', () => {
  const db = makeDb();
  const pid = db.prepare(`INSERT INTO projects (title) VALUES ('P')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO tasks (project_id, title) VALUES (?, 'T')`).run(pid);
  const row = db.prepare(`SELECT google_task_id FROM tasks`).get();
  assert.equal(row.google_task_id, null);
});

// ─── template_items.requires_space_ready ──────────────────────────────────────

test('schema: template_items has requires_space_ready column', () => {
  const db = makeDb();
  assert.ok(cols(db, 'template_items').includes('requires_space_ready'));
});

test('schema: template_items.requires_space_ready defaults to null', () => {
  const db = makeDb();
  const templateId = db.prepare(
    `INSERT INTO process_templates (title, recurrence) VALUES ('Morning', 'daily')`
  ).run().lastInsertRowid;
  db.prepare(`INSERT INTO template_items (template_id, label) VALUES (?, 'Pack bag')`).run(templateId);
  const row = db.prepare(`SELECT requires_space_ready FROM template_items`).get();
  assert.equal(row.requires_space_ready, null);
});

test('schema: template_items.requires_space_ready FK references spaces', () => {
  const db = makeDb();
  const spaceId = db.prepare(
    `INSERT INTO spaces (name, ready_state) VALUES ('Mudroom', 'hooks clear')`
  ).run().lastInsertRowid;
  const templateId = db.prepare(
    `INSERT INTO process_templates (title, recurrence) VALUES ('School run', 'daily')`
  ).run().lastInsertRowid;
  assert.doesNotThrow(() => {
    db.prepare(
      `INSERT INTO template_items (template_id, label, requires_space_ready) VALUES (?, 'Leave', ?)`
    ).run(templateId, spaceId);
  });
});
