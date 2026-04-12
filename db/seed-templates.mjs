#!/usr/bin/env node
// Seed process templates from the family process document.
// Run once: node db/seed-templates.mjs
// Idempotent: skips templates that already exist by title.

import db from './db.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCHEMA = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
db.exec(SCHEMA);

function memberByName(name) {
  return db.prepare(`SELECT id FROM members WHERE name LIKE ?`).get(`${name}%`)?.id ?? null;
}

function upsertTemplate({ title, ownerName, recurrence, recurrenceDay, departTime, locationName, locationAddress, reward, driverNotes }) {
  const existing = db.prepare(`SELECT id FROM process_templates WHERE title=?`).get(title);
  if (existing) {
    console.log(`  skip (exists): ${title}`);
    return existing.id;
  }
  const ownerId = ownerName ? memberByName(ownerName) : null;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO process_templates
      (title, owner_id, recurrence, recurrence_day, depart_time, location_name, location_address, reward, driver_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, ownerId, recurrence, recurrenceDay ?? null, departTime ?? null, locationName ?? null, locationAddress ?? null, reward ?? null, driverNotes ?? null);
  console.log(`  created: ${title} (id=${lastInsertRowid})`);
  return lastInsertRowid;
}

function addItems(templateId, items) {
  const existing = db.prepare(`SELECT COUNT(*) as n FROM template_items WHERE template_id=?`).get(templateId).n;
  if (existing > 0) {
    console.log(`    skip items (already seeded)`);
    return;
  }
  items.forEach(({ label, itemType = 'stage', quantity = 1, category = null, notes = null }, idx) => {
    db.prepare(`
      INSERT INTO template_items (template_id, label, item_type, quantity, category, sort_order, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(templateId, label, itemType, quantity, category, idx, notes);
  });
  console.log(`    ${items.length} items seeded`);
}

console.log('\n── Process Templates ──────────────────────────────────────\n');

// ── Thursday Soccer Practice ─────────────────────────────────────────────────
{
  const id = upsertTemplate({
    title: 'Thursday Soccer Practice',
    ownerName: 'Jordan',
    recurrence: 'weekly',
    recurrenceDay: 4, // Thursday
    departTime: '17:30',
    locationName: 'Soccer Practice Field',
    driverNotes: 'Sub if Jordan unavailable. Check ball air, pump if low.',
    reward: null,
  });
  addItems(id, [
    { label: 'T-shirt', itemType: 'stage', category: 'Kit' },
    { label: 'Shorts', itemType: 'stage', category: 'Kit' },
    { label: 'Ball', itemType: 'stage', category: 'Kit' },
    { label: 'Socks', itemType: 'stage', category: 'Kit' },
    { label: 'Cleats', itemType: 'stage', category: 'Kit' },
    { label: 'Shin guards', itemType: 'stage', category: 'Kit' },
    { label: 'Water bottle', itemType: 'stage', category: 'Kit' },
    { label: 'Check ball air — pump if low', itemType: 'check', category: 'Pre-departure' },
    { label: 'Stage all kit by door', itemType: 'action', category: 'Pre-departure' },
  ]);
}

// ── Friday Soccer Game ───────────────────────────────────────────────────────
{
  const id = upsertTemplate({
    title: 'Friday Soccer Game',
    ownerName: 'Jordan',
    recurrence: 'weekly',
    recurrenceDay: 5, // Friday
    departTime: '17:30',
    locationName: 'Soccer Game Field',
    driverNotes: 'Sub if Jordan unavailable. Check ball air, pump if low.',
    reward: null,
  });
  addItems(id, [
    { label: 'Game shirt', itemType: 'stage', category: 'Kit' },
    { label: 'Shorts', itemType: 'stage', category: 'Kit' },
    { label: 'Ball', itemType: 'stage', category: 'Kit' },
    { label: 'Black socks', itemType: 'stage', category: 'Kit' },
    { label: 'Cleats', itemType: 'stage', category: 'Kit' },
    { label: 'Shin guards', itemType: 'stage', category: 'Kit' },
    { label: 'Water bottle', itemType: 'stage', category: 'Kit' },
    { label: 'Check ball air — pump if low', itemType: 'check', category: 'Pre-departure' },
    { label: 'Stage all kit by door', itemType: 'action', category: 'Pre-departure' },
  ]);
}

// ── Thursday Bass Lesson (Sloan) ─────────────────────────────────────────────
{
  const id = upsertTemplate({
    title: 'Thursday Bass Lesson',
    ownerName: 'Katherine',
    recurrence: 'weekly',
    recurrenceDay: 4, // Thursday
    departTime: '16:30',
    driverNotes: 'Pick up Sloan.',
    reward: null,
  });
  addItems(id, [
    { label: 'Pick up Sloan', itemType: 'action', category: 'Pickup' },
    { label: 'Bass guitar', itemType: 'stage', category: 'Gear' },
    { label: 'Bass bag / case', itemType: 'stage', category: 'Gear' },
  ]);
}

// ── Beta Pickup ───────────────────────────────────────────────────────────────
{
  const id = upsertTemplate({
    title: 'Beta Pickup',
    ownerName: 'Katherine',
    recurrence: 'weekly',
    recurrenceDay: null, // update once day is known
    departTime: '16:30',
    driverNotes: 'Pick up at 4:30.',
    reward: null,
  });
  addItems(id, [
    { label: 'Pick up Beta', itemType: 'action', category: 'Pickup' },
  ]);
}

// ── Weekly Reset (Sunday) ────────────────────────────────────────────────────
{
  const id = upsertTemplate({
    title: 'Weekly Reset',
    ownerName: null,
    recurrence: 'weekly',
    recurrenceDay: 0, // Sunday
    departTime: null,
    driverNotes: null,
    reward: null,
  });
  addItems(id, [
    // Meal plan
    { label: 'Plan meals for the week', itemType: 'action', category: 'Meal Plan' },
    { label: 'Breakfasts planned (×5)', itemType: 'prep', quantity: 5, category: 'Meal Plan' },
    { label: 'Adult lunches planned (×10)', itemType: 'prep', quantity: 10, category: 'Meal Plan' },
    { label: 'Kid lunches planned (×5)', itemType: 'prep', quantity: 5, category: 'Meal Plan' },
    { label: 'Dinners planned (×4)', itemType: 'prep', quantity: 4, category: 'Meal Plan' },
    { label: 'Saturday dinner', itemType: 'prep', category: 'Meal Plan' },
    { label: 'Sunday dinner', itemType: 'prep', category: 'Meal Plan' },
    // Grocery & prep
    { label: 'Grocery shopping done', itemType: 'action', category: 'Grocery & Prep' },
    { label: 'Breakfasts prepped', itemType: 'prep', quantity: 5, category: 'Grocery & Prep' },
    { label: 'Lunches prepped', itemType: 'prep', quantity: 10, category: 'Grocery & Prep' },
    // Jordan's clothes
    { label: 'Underwear', itemType: 'prep', quantity: 5, category: "Jordan's Clothes" },
    { label: 'Socks', itemType: 'prep', quantity: 10, category: "Jordan's Clothes" },
    { label: 'Dress shirts', itemType: 'prep', quantity: 5, category: "Jordan's Clothes" },
    { label: 'Pants', itemType: 'prep', quantity: 4, category: "Jordan's Clothes" },
    { label: 'Jeans', itemType: 'prep', quantity: 1, category: "Jordan's Clothes" },
    { label: 'Shoes', itemType: 'prep', quantity: 1, category: "Jordan's Clothes" },
    // Sloan's clothes
    { label: 'Pants', itemType: 'prep', quantity: 5, category: "Sloan's Clothes" },
    { label: 'Underwear', itemType: 'prep', quantity: 5, category: "Sloan's Clothes" },
    { label: 'Bras', itemType: 'prep', quantity: 5, category: "Sloan's Clothes" },
    { label: 'Shirts', itemType: 'prep', quantity: 5, category: "Sloan's Clothes" },
    { label: 'Jackets', itemType: 'prep', quantity: 5, category: "Sloan's Clothes" },
    { label: 'Socks', itemType: 'prep', quantity: 5, category: "Sloan's Clothes" },
    // Hawke's clothes
    { label: 'Pants', itemType: 'prep', quantity: 5, category: "Hawke's Clothes" },
    { label: 'Underwear', itemType: 'prep', quantity: 5, category: "Hawke's Clothes" },
    { label: 'Shirts', itemType: 'prep', quantity: 5, category: "Hawke's Clothes" },
    { label: 'Jackets', itemType: 'prep', quantity: 5, category: "Hawke's Clothes" },
    { label: 'Socks', itemType: 'prep', quantity: 5, category: "Hawke's Clothes" },
    { label: 'Pajamas', itemType: 'prep', quantity: 1, category: "Hawke's Clothes" },
    // Katherine's clothes
    { label: 'Pants', itemType: 'prep', quantity: 5, category: "Katherine's Clothes" },
    { label: 'Underwear', itemType: 'prep', quantity: 5, category: "Katherine's Clothes" },
    { label: 'Bras', itemType: 'prep', quantity: 5, category: "Katherine's Clothes" },
    { label: 'Shirts', itemType: 'prep', quantity: 5, category: "Katherine's Clothes" },
    { label: 'Socks', itemType: 'prep', quantity: 5, category: "Katherine's Clothes" },
  ]);
}

console.log('\n── Home Improvement Projects ───────────────────────────────\n');

const homeProjects = [
  "Jordan's Desk",
  'Backyard Fire Pit',
  'Backyard Fire Pit Lighting',
  'Plans for the swamp',
  'French drains — front',
  'French drains — master bedroom',
  'French drain — living room',
  'Oak tree garden',
  'Kitchen',
  'Rehab back',
];

for (const title of homeProjects) {
  const existing = db.prepare(`SELECT id FROM projects WHERE title=?`).get(title);
  if (existing) {
    console.log(`  skip (exists): ${title}`);
  } else {
    db.prepare(`INSERT INTO projects (title, status) VALUES (?, 'open')`).run(title);
    console.log(`  created: ${title}`);
  }
}

console.log('\nDone.\n');
