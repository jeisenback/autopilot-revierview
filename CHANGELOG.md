# Changelog

All notable changes to autopilot-riverview are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.5.0.0] - 2026-04-12

### Added
- **`template_items.requires_space_ready`** — nullable FK column linking a checklist item
  to a space that must be ready before departure (#43)
- **Departure blockers in daily digest** — `buildDigest` now queries today's pending template
  runs; if any item's required space is not ready, a `⚠️ Departure blocked` section appears
  in the formatted output. Adults see all blocked runs; kids see only runs they own (#44)
- **Completion broadcasts** — after `complete()` marks a task done, any tasks that are
  now fully unblocked (all dependencies done/skipped) have their assignees DM'd
  `"[task] is now unblocked — ready to start."` (fire-and-forget, per-task error isolation) (#45)
- 11 new tests (schema ×3, briefingEngine ×5, projectManager ×4 — 262 total suite-wide)

### Fixed
- `complete()` unblock query: previously set dependents to `todo` even when they had
  other remaining blockers; now only unblocks when ALL dependencies are done/skipped

## [0.4.0.0] - 2026-04-12

### Added
- **Spaces schema** — `spaces` and `space_items` tables with testable binary ready-states;
  `google_task_id` on tasks and `google_tasks_list_id` on members (Phase 3 prep columns)
- **`spaceManager.mjs`** — CRUD module for spaces: `getAll`, `getById`, `setReady`,
  `getNotReady`, `getBlockingSpaces`, `getItems`, `formatList`; `setReady(id, false, {createTask})`
  auto-creates a "Tidy [space]" task for the assigned member
- **`/space` Discord commands** — `/space list`, `/space set-ready <name>`,
  `/space set-not-ready <name>`; name matching is exact-first, then partial, case-insensitive
- **Spaces in daily digest** — `buildDigest` now includes a "Spaces needing attention" section:
  spaces assigned to the member, plus unassigned not-ready spaces for adult members
- **Sample Riverview spaces** in `db/seed.mjs` — Mudroom, Kitchen Counter, Master Closet,
  Kids' Backpack Zone; idempotent by name
- 55 new tests across `schema.test.mjs`, `spaceManager.test.mjs`, `spaceCommands.test.mjs`,
  and `briefingEngine.test.mjs` (250 total in suite)

### Changed
- `commandRouter.mjs` singleton and `spaceManager` initialization are now lazy to avoid
  DB access at import time (allows in-memory test DBs without production schema)

## [0.3.0.0] - 2026-04-12

### Added
- **Per-person daily digest** (`briefingEngine.buildDigest`) — personalized morning briefing
  per family member: overdue tasks, due-today tasks, up-next queue, tasks they are blocking
  for others (via `task_dependencies`), and tasks newly unblocked for them
- **`sendAllDigests(date)`** — sends each member's digest to their DM channel; per-member
  errors are isolated and never crash the cron
- **Digest formatter** — plain-text Discord output with 🔴/🟡/⚪/⛔/✅ section icons,
  tailored greeting by member role (adult vs. kid)
- 11 new tests for `buildDigest` and `sendAllDigests` (19 total in briefingEngine suite)

## [0.2.0.0] - 2026-04-11

### Added
- **Cron-expression recurrence** (`recurrence_cron` column on `tasks`) — arbitrary schedules
  like `0 9 * * 1,3,5` (Mon+Wed+Fri 9am) alongside the existing `daily`/`weekly`/`monthly` enum
- `nextDueDate(dueDate, recurrence, recurrenceCron)` exported from `projectManager.mjs`;
  cron takes precedence over legacy enum when both are set; powered by `cron-parser` v5
- `complete()` propagates `recurrence_cron` to the next task instance
- **13 new tests** in `test/recurrence.test.mjs` — unit-tests `nextDueDate` and integration
  tests `complete()` with cron + legacy recurrence (181 total, all pass)

### Changed
- Schema: `tasks.recurrence_cron TEXT` added (nullable, no migration required for existing rows)
- `cron-parser ^5.5.0` added as dependency

## [0.1.0.0] - 2026-04-12

### Added
- **Process templates** — recurring checklists (soccer practice, weekly reset, pickups, etc.)
  with per-run item completion state, departure reminders, and Discord-formatted checklist output
- **Template engine** (`orchestrator/templateEngine.mjs`) — `createRun`, `completeItem`,
  `getRun`, `scheduleRunsForDate`, `sendDepartureReminders`, `formatRunChecklist`
- **Google Calendar integration** (`orchestrator/calendarAdapter.mjs`) — OAuth device-flow auth,
  push-first sync: template runs and tasks with due dates create/update/delete Calendar events
- **Seed script** (`db/seed-templates.mjs`) — seeds Thu/Fri soccer, Thu bass lesson,
  Beta pickup, Weekly Reset (35 items across 4 clothing + meal plan + grocery categories),
  and 10 home improvement projects
- **Cron jobs** (`orchestrator/crons.mjs`) — approval expiry (hourly), daily notification reset
  (midnight), nightly run generation (11pm), departure reminders (every 5 min)
- **Boot sequence** (`boot.mjs`) — schema migration, stale event abandonment, cron registration,
  startup summary
- **Proactive notifier** (`orchestrator/proactiveNotifier.mjs`) — DM channel sync,
  quiet hours + daily count enforcement, `sendProactive`
- **Project manager** (`orchestrator/projectManager.mjs`) — Claude-powered task decomposition,
  approval gating, recurrence, dependency unblocking, `setDueDate` with Calendar sync
- **Approval manager** — `countPending`, `listPending` with expiry countdown
- **Briefing engine** — morning briefing cron with HA sensor context
- **Webhook server** (`channels/webhook/index.mjs`) — async dispatch, 10 REST API routes,
  HA event ingestion
- **React UI** (`ui/`) — Kanban project board (dnd-kit), project detail with task management,
  approvals page, members page; Vite 5 + Tailwind v4 + shadcn/ui (New York/Zinc)
- **pm2 config** (`ecosystem.config.cjs`) — autorestart, log rotation, env vars
- **Test suite** (`test/`) — 168 tests covering all orchestrator modules

### Changed
- Schema expanded: `tasks.google_calendar_event_id`, process template tables
  (`process_templates`, `template_items`, `template_runs`, `run_item_completions`)
- `googleapis` added as dependency for Calendar push sync
