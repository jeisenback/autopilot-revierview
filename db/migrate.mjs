#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(SCRIPT_DIR, 'schema.sql');

const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

// Execute all statements in the schema file as a single transaction.
// CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS make this idempotent.
db.exec(schema);

console.log('migrate: schema applied successfully');
console.log(`migrate: database at ${db.name}`);

// Report table counts for verification
const tables = ['members','projects','tasks','task_dependencies','events','notification_state','approvals','spaces','space_items'];
for (const t of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get();
  console.log(`  ${t}: ${n} rows`);
}
