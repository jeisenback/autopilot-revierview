import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTemplateEngine, mapsUrl } from '../orchestrator/templateEngine.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.pragma('busy_timeout = 3000');
  return db;
}

// calendar=null disables all Calendar push (no credentials needed in tests)
function makeEngine(db, opts = {}) {
  return createTemplateEngine({ db, calendar: null, ...opts });
}

function seedMember(db, { name = 'Alice', discordId = 'u1', role = 'adult', channelId = 'dm-1', tz = 'UTC' } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES (?, ?, ?, ?, '23:00', '05:00', ?, 10)`
  ).run(name, discordId, channelId, role, tz);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

function seedTemplate(db, {
  title = 'Test Template',
  recurrence = 'weekly',
  recurrenceDay = 4,
  departTime = '17:30',
  locationName = null,
  locationAddress = null,
  ownerId = null,
  reward = null,
  driverNotes = null,
  // alias
  owner_id = null,
} = {}) {
  ownerId = ownerId ?? owner_id;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO process_templates
      (title, owner_id, recurrence, recurrence_day, depart_time, location_name, location_address, reward, driver_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, ownerId, recurrence, recurrenceDay, departTime, locationName, locationAddress, reward, driverNotes);
  return lastInsertRowid;
}

function addItem(db, templateId, { label = 'Item', itemType = 'stage', quantity = 1, category = null, sortOrder = 0 } = {}) {
  return db.prepare(
    `INSERT INTO template_items (template_id, label, item_type, quantity, category, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(templateId, label, itemType, quantity, category, sortOrder).lastInsertRowid;
}

// ── mapsUrl() ─────────────────────────────────────────────────────────────────

test('mapsUrl(): generates correct Google Maps directions URL', () => {
  const url = mapsUrl('123 Main St, Springfield IL');
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?api=1&destination='));
  assert.ok(url.includes('Springfield'));
});

test('mapsUrl(): returns null for null address', () => {
  assert.equal(mapsUrl(null), null);
  assert.equal(mapsUrl(''), null);
});

// ── createRun() ───────────────────────────────────────────────────────────────

test('createRun(): creates run row with correct date and depart_at', async () => {
  const db = makeDb();
  const tid = seedTemplate(db, { departTime: '17:30' });
  const engine = makeEngine(db);

  const runId = await engine.createRun(tid, '2026-04-17');

  const run = db.prepare('SELECT * FROM template_runs WHERE id=?').get(runId);
  assert.equal(run.template_id, tid);
  assert.equal(run.scheduled_for, '2026-04-17');
  assert.equal(run.depart_at, '17:30');
  assert.equal(run.status, 'pending');
  assert.equal(run.reminder_sent, 0);
});

test('createRun(): auto-populates run_item_completions for every template item', async () => {
  const db = makeDb();
  const tid = seedTemplate(db);
  addItem(db, tid, { label: 'Cleats' });
  addItem(db, tid, { label: 'Shin guards' });
  addItem(db, tid, { label: 'Water bottle' });
  const engine = makeEngine(db);

  const runId = await engine.createRun(tid, '2026-04-17');

  const completions = db.prepare('SELECT * FROM run_item_completions WHERE run_id=?').all(runId);
  assert.equal(completions.length, 3);
  assert.ok(completions.every(c => c.completed === 0));
});

test('createRun(): idempotent — returns same run id if called twice for same date', async () => {
  const db = makeDb();
  const tid = seedTemplate(db);
  const engine = makeEngine(db);

  const id1 = await engine.createRun(tid, '2026-04-17');
  const id2 = await engine.createRun(tid, '2026-04-17');

  assert.equal(id1, id2);
  const count = db.prepare('SELECT COUNT(*) as n FROM template_runs').get().n;
  assert.equal(count, 1);
});

// ── completeItem() ────────────────────────────────────────────────────────────

test('completeItem(): marks item completed with timestamp', async () => {
  const db = makeDb();
  const tid = seedTemplate(db);
  const itemId = addItem(db, tid, { label: 'Ball' });
  const engine = makeEngine(db);
  const runId = await engine.createRun(tid, '2026-04-17');

  engine.completeItem(runId, itemId);

  const c = db.prepare('SELECT * FROM run_item_completions WHERE run_id=? AND item_id=?').get(runId, itemId);
  assert.equal(c.completed, 1);
  assert.ok(c.completed_at, 'completed_at should be set');
});

// ── getRun() ──────────────────────────────────────────────────────────────────

test('getRun(): returns run with template and items', async () => {
  const db = makeDb();
  const tid = seedTemplate(db, { title: 'Soccer Practice', locationAddress: '123 Field Rd' });
  addItem(db, tid, { label: 'Cleats', category: 'Kit' });
  addItem(db, tid, { label: 'Ball', category: 'Kit' });
  const engine = makeEngine(db);
  const runId = await engine.createRun(tid, '2026-04-17');

  const run = engine.getRun(runId);

  assert.equal(run.template.title, 'Soccer Practice');
  assert.equal(run.items.length, 2);
  assert.ok(run.template.location_url, 'should have generated Maps URL');
  assert.ok(run.template.location_url.includes('123%20Field'));
  assert.equal(run.completedCount, 0);
  assert.equal(run.totalCount, 2);
});

test('getRun(): completedCount updates after completeItem', async () => {
  const db = makeDb();
  const tid = seedTemplate(db);
  const i1 = addItem(db, tid, { label: 'A' });
  const i2 = addItem(db, tid, { label: 'B' });
  const engine = makeEngine(db);
  const runId = await engine.createRun(tid, '2026-04-17');

  engine.completeItem(runId, i1);
  const run = engine.getRun(runId);

  assert.equal(run.completedCount, 1);
  assert.equal(run.totalCount, 2);
});

// ── scheduleRunsForDate() ─────────────────────────────────────────────────────

test('scheduleRunsForDate(): creates runs for weekly templates matching day-of-week', async () => {
  const db = makeDb();
  // 2026-04-16 is a Thursday (dow=4)
  seedTemplate(db, { title: 'Thu Practice', recurrence: 'weekly', recurrenceDay: 4 });
  seedTemplate(db, { title: 'Fri Game', recurrence: 'weekly', recurrenceDay: 5 });
  const engine = makeEngine(db);

  const created = await engine.scheduleRunsForDate('2026-04-16');

  assert.equal(created.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) as n FROM template_runs').get().n, 1);
});

test('scheduleRunsForDate(): creates runs for daily templates every day', async () => {
  const db = makeDb();
  seedTemplate(db, { title: 'Daily Check', recurrence: 'daily', recurrenceDay: null });
  const engine = makeEngine(db);

  await engine.scheduleRunsForDate('2026-04-14');
  await engine.scheduleRunsForDate('2026-04-15');

  assert.equal(db.prepare('SELECT COUNT(*) as n FROM template_runs').get().n, 2);
});

test('scheduleRunsForDate(): inactive templates are skipped', async () => {
  const db = makeDb();
  const tid = seedTemplate(db, { recurrence: 'daily' });
  db.prepare(`UPDATE process_templates SET active=0 WHERE id=?`).run(tid);
  const engine = makeEngine(db);

  const created = await engine.scheduleRunsForDate('2026-04-14');

  assert.equal(created.length, 0);
});

// ── sendDepartureReminders() ──────────────────────────────────────────────────

test('sendDepartureReminders(): DMs all adults when run departs within lead time', async () => {
  const db = makeDb();
  const owner = seedMember(db, { name: 'Jordan', discordId: 'u1', role: 'adult', channelId: 'dm-jordan', tz: 'UTC' });
  seedMember(db, { name: 'Katherine', discordId: 'u2', role: 'adult', channelId: 'dm-katherine', tz: 'UTC' });

  const tid = seedTemplate(db, { title: 'Soccer Practice', recurrence: 'daily', ownerId: owner.id });
  addItem(db, tid, { label: 'Cleats' });

  const engine = makeEngine(db, { reminderLeadMinutes: 60 });
  const today = new Date().toISOString().split('T')[0];
  const runId = await engine.createRun(tid, today);

  // Set depart_at to 30 minutes from now in UTC
  const soon = new Date(Date.now() + 30 * 60000);
  const departAt = `${String(soon.getUTCHours()).padStart(2, '0')}:${String(soon.getUTCMinutes()).padStart(2, '0')}`;
  db.prepare(`UPDATE template_runs SET depart_at=? WHERE id=?`).run(departAt, runId);

  const sent = [];
  const testEngine = makeEngine(db, {
    postMessage: async (channelId, text) => { sent.push({ channelId, text }); },
    reminderLeadMinutes: 60,
  });

  await testEngine.sendDepartureReminders();

  assert.equal(sent.length, 2, 'both adults should be DM\'d');
  assert.ok(sent.some(s => s.channelId === 'dm-jordan'));
  assert.ok(sent.some(s => s.channelId === 'dm-katherine'));
  assert.ok(sent[0].text.includes('Soccer Practice'));
});

test('sendDepartureReminders(): marks reminder_sent=1 after sending', async () => {
  const db = makeDb();
  const owner = seedMember(db, { discordId: 'u1', role: 'adult', channelId: 'dm-1', tz: 'UTC' });

  const tid = seedTemplate(db, { recurrence: 'daily', ownerId: owner.id });
  const today = new Date().toISOString().split('T')[0];
  const runId = engine_create(db, tid, today);

  const soon = new Date(Date.now() + 10 * 60000);
  const departAt = `${String(soon.getUTCHours()).padStart(2, '0')}:${String(soon.getUTCMinutes()).padStart(2, '0')}`;
  db.prepare(`UPDATE template_runs SET depart_at=? WHERE id=?`).run(departAt, runId);

  const testEngine = makeEngine(db, { postMessage: async () => {}, reminderLeadMinutes: 30 });
  await testEngine.sendDepartureReminders();
  await testEngine.sendDepartureReminders(); // second call should not re-send

  const run = db.prepare('SELECT reminder_sent FROM template_runs WHERE id=?').get(runId);
  assert.equal(run.reminder_sent, 1);
});

function engine_create(db, tid, date) {
  const t = db.prepare('SELECT * FROM process_templates WHERE id=?').get(tid);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO template_runs (template_id, scheduled_for, depart_at) VALUES (?, ?, ?)`
  ).run(tid, date, t.depart_time);
  const items = db.prepare('SELECT id FROM template_items WHERE template_id=?').all(tid);
  for (const item of items) {
    db.prepare('INSERT INTO run_item_completions (run_id, item_id) VALUES (?, ?)').run(lastInsertRowid, item.id);
  }
  return lastInsertRowid;
}

test('sendDepartureReminders(): does not DM when departure is too far out', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'u1', role: 'adult', channelId: 'dm-1', tz: 'UTC' });

  const tid = seedTemplate(db, { recurrence: 'daily' });
  const today = new Date().toISOString().split('T')[0];
  const runId = engine_create(db, tid, today);

  // 3 hours from now — outside 30-min lead
  const later = new Date(Date.now() + 3 * 60 * 60000);
  const departAt = `${String(later.getUTCHours()).padStart(2, '0')}:${String(later.getUTCMinutes()).padStart(2, '0')}`;
  db.prepare(`UPDATE template_runs SET depart_at=? WHERE id=?`).run(departAt, runId);

  const sent = [];
  const testEngine = makeEngine(db, { postMessage: async (ch, t) => { sent.push(t); }, reminderLeadMinutes: 30 });
  await testEngine.sendDepartureReminders();

  assert.equal(sent.length, 0);
});

// ── formatRunChecklist() ──────────────────────────────────────────────────────

test('formatRunChecklist(): includes title, depart time, unchecked items', async () => {
  const db = makeDb();
  const tid = seedTemplate(db, { title: 'Soccer Practice', departTime: '17:30', locationName: 'Riverview Field', locationAddress: '1 Field Way' });
  addItem(db, tid, { label: 'Cleats', category: 'Kit', sortOrder: 0 });
  addItem(db, tid, { label: 'Shin guards', category: 'Kit', sortOrder: 1 });
  const engine = makeEngine(db);
  const runId = await engine.createRun(tid, '2026-04-17');

  const result = engine.formatRunChecklist(runId);

  assert.ok(result.includes('Soccer Practice'));
  assert.ok(result.includes('17:30'));
  assert.ok(result.includes('Riverview Field'));
  assert.ok(result.includes('google.com/maps'));
  assert.ok(result.includes('☐ Cleats'));
  assert.ok(result.includes('0/2 items checked'));
});

test('formatRunChecklist(): checked items show ☑', async () => {
  const db = makeDb();
  const tid = seedTemplate(db);
  const itemId = addItem(db, tid, { label: 'Ball' });
  const engine = makeEngine(db);
  const runId = await engine.createRun(tid, '2026-04-17');

  engine.completeItem(runId, itemId);
  const result = engine.formatRunChecklist(runId);

  assert.ok(result.includes('☑ Ball'));
  assert.ok(result.includes('1/1 items checked'));
});
