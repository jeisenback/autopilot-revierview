#!/usr/bin/env node
// boot.mjs — startup sequence for autopilot-riverview.
// Run once at process start (called by channels/webhook/index.mjs or pm2 directly).
// See: GitHub issue #17

import db from './db/db.mjs';
import { registerAll } from './orchestrator/crons.mjs';

// ── 1. Run migrations (idempotent) ────────────────────────────────────────────
const schema = (await import('fs')).readFileSync(
  new URL('./db/schema.sql', import.meta.url),
  'utf8'
);
db.exec(schema);

// ── 2. Abandon stale unprocessed events (>24h old) ───────────────────────────
const abandoned = db.prepare(`
  UPDATE events SET processed = 3
  WHERE processed = 0 AND created_at < datetime('now', '-24 hours')
`).run();
if (abandoned.changes > 0) {
  process.stderr.write(`boot: abandoned ${abandoned.changes} stale event(s)\n`);
}

// ── 3. Start cron jobs ────────────────────────────────────────────────────────
// Lazy-import node-cron so the boot module can be required in tests without
// spinning up real timers.
let cron;
try {
  cron = (await import('node-cron')).default;
} catch {
  process.stderr.write('boot: node-cron not available — skipping cron registration\n');
  cron = null;
}
if (cron) {
  registerAll(cron, db);
}

// ── 4. Log ready state ────────────────────────────────────────────────────────
const memberCount   = db.prepare(`SELECT COUNT(*) as n FROM members`).get().n;
const openProjects  = db.prepare(`SELECT COUNT(*) as n FROM projects WHERE status != 'done'`).get().n;
const pendingEvents = db.prepare(`SELECT COUNT(*) as n FROM events WHERE processed = 0`).get().n;

console.log(
  `autopilot-riverview ready. Members: ${memberCount}, Open projects: ${openProjects}, Pending events: ${pendingEvents}`
);
