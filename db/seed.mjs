#!/usr/bin/env node
// db/seed.mjs — interactive family member onboarding
// Run: node db/seed.mjs
// Idempotent: skips members whose discord_user_id already exists.

import readline from 'readline';
import db from './db.mjs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const insertMember = db.prepare(`
  INSERT INTO members (name, discord_user_id, role, quiet_start, quiet_end, timezone, max_daily_notifications)
  VALUES (@name, @discord_user_id, @role, @quiet_start, @quiet_end, @timezone, @max_daily_notifications)
`);

const insertNotificationState = db.prepare(`
  INSERT INTO notification_state (member_id, daily_count, daily_reset_date)
  VALUES (?, 0, date('now'))
`);

const findByDiscordId = db.prepare(`
  SELECT id, name FROM members WHERE discord_user_id = ?
`);

async function seedMember(index, total) {
  console.log(`\nMember ${index} of ${total}`);
  console.log('─'.repeat(30));

  const name = (await ask('  Name: ')).trim();
  if (!name) { console.log('  Skipped (no name).'); return; }

  const discordId = (await ask('  Discord user ID: ')).trim();
  if (!discordId) { console.log('  Skipped (no Discord ID).'); return; }

  const existing = findByDiscordId.get(discordId);
  if (existing) {
    console.log(`  Skipped — ${existing.name} (${discordId}) already exists.`);
    return;
  }

  const roleInput = (await ask('  Role (adult/kid) [adult]: ')).trim().toLowerCase();
  const role = roleInput === 'kid' ? 'kid' : 'adult';

  const quietStart = (await ask('  Quiet hours start (HH:MM) [21:00]: ')).trim() || '21:00';
  const quietEnd   = (await ask('  Quiet hours end   (HH:MM) [07:00]: ')).trim() || '07:00';
  const timezone   = (await ask('  Timezone [America/Chicago]: ')).trim() || 'America/Chicago';

  const maxNotifications = role === 'kid' ? 3 : 5;

  const seedOne = db.transaction(() => {
    const { lastInsertRowid } = insertMember.run({
      name,
      discord_user_id: discordId,
      role,
      quiet_start: quietStart,
      quiet_end: quietEnd,
      timezone,
      max_daily_notifications: maxNotifications,
    });
    insertNotificationState.run(lastInsertRowid);
    return lastInsertRowid;
  });

  const id = seedOne();
  console.log(`  ✓ Added ${name} (${role}, id=${id}, max_notifications=${maxNotifications}/day)`);
}

async function main() {
  console.log('autopilot-riverview — family member setup');
  console.log('==========================================');
  console.log('Tip: get Discord user IDs via Settings → Advanced → Developer Mode → right-click username → Copy User ID\n');

  const countInput = (await ask('How many members to add? [4]: ')).trim();
  const count = Number(countInput) || 4;

  for (let i = 1; i <= count; i++) {
    await seedMember(i, count);
  }

  console.log('\n── Summary ──────────────────────────────');
  const members = db.prepare('SELECT id, name, role, max_daily_notifications FROM members ORDER BY id').all();
  if (members.length === 0) {
    console.log('No members in database.');
  } else {
    for (const m of members) {
      console.log(`  [${m.id}] ${m.name.padEnd(15)} ${m.role.padEnd(6)} max=${m.max_daily_notifications} notifications/day`);
    }
  }

  seedSpaces();

  rl.close();
}

// ─── Sample spaces ────────────────────────────────────────────────────────────

const SAMPLE_SPACES = [
  {
    name: 'Mudroom',
    location: 'entryway',
    ready_state: 'shoes on rack, bag hooks clear, keys on hook',
  },
  {
    name: 'Kitchen Counter',
    location: 'kitchen',
    ready_state: 'clear of dishes, no mail pile, surfaces wiped',
  },
  {
    name: 'Master Closet',
    location: 'master bedroom',
    ready_state: 'floor clear, clothes hung or in hamper, no pile on chair',
  },
  {
    name: "Kids' Backpack Zone",
    location: 'hallway',
    ready_state: 'backpacks hung on hooks, shoes in cubby, no gear on floor',
  },
];

const findSpace = db.prepare(`SELECT id FROM spaces WHERE name = ?`);
const insertSpace = db.prepare(`
  INSERT INTO spaces (name, location, ready_state, is_ready)
  VALUES (@name, @location, @ready_state, 1)
`);

function seedSpaces() {
  console.log('\n── Spaces ───────────────────────────────');
  let added = 0;
  let skipped = 0;
  for (const space of SAMPLE_SPACES) {
    if (findSpace.get(space.name)) {
      console.log(`  Skipped — "${space.name}" already exists.`);
      skipped++;
    } else {
      const { lastInsertRowid } = insertSpace.run(space);
      console.log(`  ✓ Added "${space.name}" (id=${lastInsertRowid})`);
      added++;
    }
  }
  console.log(`  ${added} added, ${skipped} skipped.`);
}

main().catch(err => {
  console.error('seed failed:', err);
  rl.close();
  process.exit(1);
});
