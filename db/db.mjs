import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(SCRIPT_DIR, 'autopilot.db');

const db = new Database(DB_PATH);

// WAL mode: allows concurrent reads while the bot is writing.
db.pragma('journal_mode = WAL');

// busy_timeout: block up to 3s on a locked write before failing.
// Prevents SQLITE_BUSY errors when Discord bot and UI API write concurrently.
db.pragma('busy_timeout = 3000');

// Foreign key enforcement is off by default in SQLite; must be enabled per connection.
db.pragma('foreign_keys = ON');

export default db;
