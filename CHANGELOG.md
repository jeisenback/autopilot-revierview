# Changelog

All notable changes to autopilot-riverview are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
