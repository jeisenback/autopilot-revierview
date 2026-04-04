# Changelog

All notable changes to autopilot-riverview are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [0.2.0.0] - 2026-04-04

### Added
- Project manager (`orchestrator/projectManager.mjs`): `create()` uses Claude
  to decompose a project title into 3-6 tasks, with JSON parse fallback to a
  single task if Claude returns non-array output. `requires_approval` is set
  by app code when `estimated_cost >= threshold`. `complete()` enforces kid role
  assignment guard, handles recurrence (daily/weekly/monthly) with dependency
  copy in a single transaction, and unblocks dependent tasks on completion.
  `listOpen()` returns open/active/blocked projects sorted by priority.
- Response formatter (`orchestrator/responseFormatter.mjs`): selects adult or
  kid voice system prompt. Adults get concise PM tone with cost/approval context;
  kids get friendly/encouraging tone with those topics explicitly banned.
- Command router (`orchestrator/commandRouter.mjs`): dispatches 6 commands to
  the correct handler. Kids are blocked from admin-only commands (`add_project`,
  `assign_task`) with a clear "ask a parent" message.
- Orchestrator entry point (`orchestrator/index.mjs`): looks up the Discord
  member, parses intent, and dispatches — the single function the webhook calls.
- Webhook updated to use orchestrator with async dispatch pattern: HTTP response
  sent immediately, Claude runs in the background, result posted to callback URL.
  Added `/ha-events` stub route for Home Assistant integration (issue #13).

## [0.1.0.0] - 2026-04-04

### Added
- Suppression model (`orchestrator/suppressionModel.mjs`): priority tiers,
  quiet hours, snooze, daily caps. `increment()` persists to SQLite.
- Intent parser (`orchestrator/intentParser.mjs`): fast-path regex for 6 slash
  commands, Claude Haiku fallback for natural language.
