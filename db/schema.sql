-- autopilot-riverview schema
-- All timestamps: TEXT ISO 8601 (2026-04-03T15:00:00Z). Lexicographic sort works.
-- All id fields: INTEGER PRIMARY KEY AUTOINCREMENT.
-- Run via db/migrate.mjs (idempotent — CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  discord_user_id TEXT UNIQUE NOT NULL,
  discord_dm_channel_id TEXT,           -- populated on first DM; used for proactive messages
  role TEXT NOT NULL CHECK(role IN ('adult','kid')),
  quiet_start TEXT DEFAULT '21:00',     -- HH:MM local
  quiet_end TEXT DEFAULT '07:00',       -- HH:MM local
  timezone TEXT DEFAULT 'America/Chicago',
  max_daily_notifications INTEGER NOT NULL DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','active','blocked','done')),
  parent_project_id INTEGER REFERENCES projects(id),
  owner_id INTEGER REFERENCES members(id),
  estimated_cost REAL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1,2,3)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK(status IN ('todo','awaiting_approval','in_progress','blocked','done','skipped')),
  -- awaiting_approval: task created but must not be acted on until approved.
  -- Set when requires_approval=1 at creation. Cleared to 'todo' on approval.
  -- Set to 'skipped' on denial or expiry.
  assigned_to INTEGER REFERENCES members(id),
  estimated_cost REAL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1,2,3)),
  recurrence TEXT CHECK(recurrence IN ('daily','weekly','monthly')),
  -- NULL = one-time. For simple cadences use recurrence; for arbitrary schedules use recurrence_cron.
  recurrence_cron TEXT,             -- cron expression, e.g. '0 9 * * 1,3' (Mon+Wed 9am)
  -- recurrence_cron takes precedence over recurrence when both are set.
  google_calendar_event_id TEXT,    -- Calendar event ID for push/update/delete
  created_from TEXT DEFAULT 'manual'
    CHECK(created_from IN ('manual','ha_event','claude')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id)
);

-- Inbound event log. Audit trail only — not event sourcing.
-- processed: 0=pending, 1=done, 2=skipped (pre-filter rule), 3=abandoned (stale >24h)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('ha','discord','system')),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,  -- JSON string
  processed INTEGER NOT NULL DEFAULT 0,
  task_created_id INTEGER REFERENCES tasks(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_state (
  member_id INTEGER PRIMARY KEY REFERENCES members(id),
  last_notified_at TEXT,
  snooze_until TEXT,
  daily_count INTEGER NOT NULL DEFAULT 0,
  daily_reset_date TEXT  -- ISO date YYYY-MM-DD; midnight cron resets daily_count when date changes
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  requested_by INTEGER NOT NULL REFERENCES members(id),
  discord_message_id TEXT NOT NULL UNIQUE,  -- UNIQUE: reaction handler matches on this
  discord_channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied','expired')),
  expires_at TEXT NOT NULL,  -- created_at + APPROVAL_TTL_HOURS (default: 24h)
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── Process templates ─────────────────────────────────────────────────────────
-- Reusable recurring checklists: soccer practice, weekly reset, pickups, etc.

CREATE TABLE IF NOT EXISTS process_templates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  owner_id         INTEGER REFERENCES members(id),   -- primary responsible member
  recurrence       TEXT NOT NULL DEFAULT 'weekly'
    CHECK(recurrence IN ('daily','weekly','monthly','once')),
  recurrence_day   INTEGER CHECK(recurrence_day BETWEEN 0 AND 6), -- 0=Sun … 6=Sat
  depart_time      TEXT,          -- HH:MM local, NULL if no departure required
  location_name    TEXT,          -- human label: "Riverview Soccer Complex"
  location_address TEXT,          -- street address → auto-generates Maps URL
  reward           TEXT,          -- "ice cream after", optional incentive note
  driver_notes     TEXT,          -- reminder notes for the driver / organizer
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT DEFAULT (datetime('now'))
);

-- Ordered checklist items inside a template.
-- item_type: stage=physical item to gather, check=verify state,
--            action=do something, prep=prepare in advance
CREATE TABLE IF NOT EXISTS template_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES process_templates(id),
  label       TEXT NOT NULL,
  item_type   TEXT NOT NULL DEFAULT 'stage'
    CHECK(item_type IN ('stage','check','action','prep')),
  quantity    INTEGER NOT NULL DEFAULT 1,
  category    TEXT,         -- groups items: "Jordan", "meal plan", etc.
  sort_order  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT
);

-- One scheduled instance per occurrence of a template.
-- Auto-created by nightly cron; reminder_sent prevents duplicate DMs.
CREATE TABLE IF NOT EXISTS template_runs (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id              INTEGER NOT NULL REFERENCES process_templates(id),
  scheduled_for            TEXT NOT NULL,   -- YYYY-MM-DD
  depart_at                TEXT,            -- HH:MM, copied from template (overridable)
  status                   TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','active','done','skipped')),
  reminder_sent            INTEGER NOT NULL DEFAULT 0,
  google_calendar_event_id TEXT,            -- Calendar event ID for push/update/delete
  started_at               TEXT,
  completed_at             TEXT,
  created_at               TEXT DEFAULT (datetime('now'))
);

-- Per-run completion state for each checklist item.
-- Auto-populated when a run is created.
CREATE TABLE IF NOT EXISTS run_item_completions (
  run_id       INTEGER NOT NULL REFERENCES template_runs(id),
  item_id      INTEGER NOT NULL REFERENCES template_items(id),
  completed    INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  PRIMARY KEY (run_id, item_id)
);

-- Indices for hot query paths
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_status_expires ON approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_template_runs_scheduled ON template_runs(scheduled_for, status);
CREATE INDEX IF NOT EXISTS idx_template_items_template ON template_items(template_id, sort_order);
