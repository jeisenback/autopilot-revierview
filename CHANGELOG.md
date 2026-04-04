# Changelog

All notable changes to autopilot-riverview are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## [0.1.0.0] - 2026-04-04

### Added
- Suppression model (`orchestrator/suppressionModel.mjs`): `canNotify()` enforces
  priority tiers (CRITICAL always sends, NORMAL uses full daily cap, LOW uses 50%),
  quiet hours with midnight-crossing window support, snooze expiry, and daily send
  caps. `increment()` persists the daily count to SQLite. 12 tests, 100% path coverage.
- Intent parser (`orchestrator/intentParser.mjs`): `parseIntent()` handles 6 slash
  commands via fast-path regex (/project add, /project list, /task done, /assign,
  /ask, /snooze) with no Claude call. Natural language and unrecognized commands fall
  through to Claude (Haiku) for classification. `callClaude` is injectable for tests.
  12 tests, 100% path coverage.
