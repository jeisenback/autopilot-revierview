// Tests for proactive DM notifier — issue #18
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProactiveNotifier } from '../orchestrator/proactiveNotifier.mjs';
import { createOrchestrator } from '../orchestrator/index.mjs';

const SCHEMA = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/schema.sql'), 'utf8'
);

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function seedMember(db, { discordId = 'u1', channelId = null, role = 'adult' } = {}) {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO members (name, discord_user_id, discord_dm_channel_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
     VALUES ('Alice', ?, ?, ?, '23:00', '05:00', 'UTC', 5)`
  ).run(discordId, channelId, role);
  db.prepare(`INSERT INTO notification_state (member_id) VALUES (?)`).run(lastInsertRowid);
  return db.prepare('SELECT * FROM members WHERE id=?').get(lastInsertRowid);
}

// ─── syncDmChannel() ─────────────────────────────────────────────────────────

test('syncDmChannel(): persists discovered channel ID to DB', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u1', channelId: null });
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => 'dm-channel-123',
    postToResponseServer: async () => ({ ok: true }),
    increment: () => {},
  });

  await notifier.syncDmChannel(member);

  const updated = db.prepare('SELECT discord_dm_channel_id FROM members WHERE id=?').get(member.id);
  assert.equal(updated.discord_dm_channel_id, 'dm-channel-123');
});

test('syncDmChannel(): updates in-memory member object', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u2', channelId: null });
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => 'dm-channel-456',
    postToResponseServer: async () => ({ ok: true }),
    increment: () => {},
  });

  await notifier.syncDmChannel(member);

  assert.equal(member.discord_dm_channel_id, 'dm-channel-456');
});

test('syncDmChannel(): no-ops if channel already set', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u3', channelId: 'existing-channel' });
  let createDmCalled = false;
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => { createDmCalled = true; return 'new-channel'; },
    postToResponseServer: async () => ({ ok: true }),
    increment: () => {},
  });

  const result = await notifier.syncDmChannel(member);

  assert.equal(createDmCalled, false, 'createDm should not be called when channel already set');
  assert.equal(result, 'existing-channel');
});

test('syncDmChannel(): returns null when createDm fails', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u4', channelId: null });
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => null,
    postToResponseServer: async () => ({ ok: true }),
    increment: () => {},
  });

  const result = await notifier.syncDmChannel(member);
  assert.equal(result, null);
  const row = db.prepare('SELECT discord_dm_channel_id FROM members WHERE id=?').get(member.id);
  assert.equal(row.discord_dm_channel_id, null);
});

// ─── sendProactive() ─────────────────────────────────────────────────────────

test('sendProactive(): sends to member DM channel', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u5', channelId: 'dm-ch-1' });
  const calls = [];
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => null,
    postToResponseServer: async (channelId, text) => { calls.push({ channelId, text }); return { ok: true }; },
    increment: () => {},
  });

  await notifier.sendProactive(member, 'You have tasks due today.');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channelId, 'dm-ch-1');
  assert.equal(calls[0].text, 'You have tasks due today.');
});

test('sendProactive(): falls back to BRIEFING_CHANNEL_ID when no DM channel', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u6', channelId: null });
  process.env.BRIEFING_CHANNEL_ID = 'family-channel';
  const calls = [];
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => null,
    postToResponseServer: async (channelId, text) => { calls.push({ channelId, text }); return { ok: true }; },
    increment: () => {},
  });

  await notifier.sendProactive(member, 'Morning briefing.');

  assert.equal(calls[0].channelId, 'family-channel');
  delete process.env.BRIEFING_CHANNEL_ID;
});

test('sendProactive(): increments daily_count on success', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u7', channelId: 'dm-ch-2' });
  const incremented = [];
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => null,
    postToResponseServer: async () => ({ ok: true }),
    increment: (memberId) => { incremented.push(memberId); },
  });

  await notifier.sendProactive(member, 'Task reminder.');

  assert.deepEqual(incremented, [member.id]);
});

test('sendProactive(): does not increment on server error', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u8', channelId: 'dm-ch-3' });
  const incremented = [];
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => null,
    postToResponseServer: async () => ({ ok: false, status: 500 }),
    increment: (memberId) => { incremented.push(memberId); },
  });

  const result = await notifier.sendProactive(member, 'Task reminder.');

  assert.equal(result, false);
  assert.equal(incremented.length, 0);
});

test('sendProactive(): returns false when no channel available', async () => {
  const db = makeDb();
  const member = seedMember(db, { discordId: 'u9', channelId: null });
  delete process.env.BRIEFING_CHANNEL_ID;
  const notifier = createProactiveNotifier({
    db,
    createDm: async () => null,
    postToResponseServer: async () => ({ ok: true }),
    increment: () => {},
  });

  const result = await notifier.sendProactive(member, 'Hello.');
  assert.equal(result, false);
});

// ─── orchestrator wires syncDmChannel on first message ───────────────────────

test('orchestrator: calls syncDmChannel when discord_dm_channel_id is null', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'sync-u1', channelId: null });

  const synced = [];
  const orch = createOrchestrator({
    db,
    syncDmChannel: async (member) => { synced.push(member.discord_user_id); },
    dispatch: async () => 'ok',
  });

  await orch.handle({
    author: { discord_user_id: 'sync-u1' },
    content: '/status',
  });

  // syncDmChannel is fire-and-forget — give the microtask queue a tick
  await new Promise(r => setImmediate(r));
  assert.ok(synced.includes('sync-u1'), 'syncDmChannel should have been called');
});

test('orchestrator: skips syncDmChannel when dm channel already set', async () => {
  const db = makeDb();
  seedMember(db, { discordId: 'sync-u2', channelId: 'already-set' });

  const synced = [];
  const orch = createOrchestrator({
    db,
    syncDmChannel: async (member) => { synced.push(member.discord_user_id); },
    dispatch: async () => 'ok',
  });

  await orch.handle({
    author: { discord_user_id: 'sync-u2' },
    content: '/status',
  });

  await new Promise(r => setImmediate(r));
  assert.equal(synced.length, 0, 'syncDmChannel should not be called when channel already set');
});
