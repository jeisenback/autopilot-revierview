import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format, formatWithClaude } from '../orchestrator/responseFormatter.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────────

function adult(name = 'Alice') {
  return { role: 'adult', name };
}

function kid(name = 'Sam') {
  return { role: 'kid', name };
}

function stubClaude({ systemCapture = null } = {}) {
  let capturedSystem = null;
  const fn = async ({ system, userMessage }) => {
    capturedSystem = system;
    return `Response to: ${userMessage}`;
  };
  fn.capturedSystem = () => capturedSystem;
  return fn;
}

// ─── format() — no Claude ────────────────────────────────────────────────────

test('format(): passes text through for adult member', () => {
  const result = format('Project created successfully.', adult());
  assert.equal(result, 'Project created successfully.');
});

test('format(): passes text through for kid member', () => {
  const result = format('Task done!', kid());
  assert.equal(result, 'Task done!');
});

// ─── formatWithClaude() — adult voice ────────────────────────────────────────

test('formatWithClaude(): adult member → adult system prompt used', async () => {
  const spy = stubClaude();
  await formatWithClaude('List my projects', {}, adult(), { callClaude: spy });
  const sys = spy.capturedSystem();
  assert.ok(sys, 'system prompt should be set');
  assert.ok(sys.toLowerCase().includes('concis') || sys.toLowerCase().includes('project'), `expected adult system prompt, got: ${sys}`);
});

test('formatWithClaude(): adult system prompt mentions cost', async () => {
  const spy = stubClaude();
  await formatWithClaude('any message', {}, adult(), { callClaude: spy });
  const sys = spy.capturedSystem();
  assert.ok(sys.toLowerCase().includes('cost'), `adult prompt should mention cost, got: ${sys}`);
});

// ─── formatWithClaude() — kid voice ──────────────────────────────────────────

test('formatWithClaude(): kid member → kid system prompt used', async () => {
  const spy = stubClaude();
  await formatWithClaude('What should I do?', {}, kid(), { callClaude: spy });
  const sys = spy.capturedSystem();
  assert.ok(sys, 'system prompt should be set');
  assert.ok(
    sys.toLowerCase().includes('friendly') || sys.toLowerCase().includes('encouraging'),
    `expected kid system prompt, got: ${sys}`
  );
});

test('formatWithClaude(): kid system prompt forbids cost/approval language', async () => {
  const spy = stubClaude();
  await formatWithClaude('any message', {}, kid(), { callClaude: spy });
  const sys = spy.capturedSystem();
  assert.ok(sys.toLowerCase().includes('never mention'), `kid prompt should forbid cost/approvals, got: ${sys}`);
});

test('formatWithClaude(): kid completion → system prompt celebrates', async () => {
  const spy = stubClaude();
  await formatWithClaude('I finished cleaning my room!', { completion: true }, kid(), { callClaude: spy });
  const sys = spy.capturedSystem();
  assert.ok(
    sys.toLowerCase().includes('celebrat') || sys.toLowerCase().includes('positive'),
    `kid completion prompt should celebrate, got: ${sys}`
  );
});

test('formatWithClaude(): recipient name passed in user message or system', async () => {
  const spy = stubClaude();
  await formatWithClaude('Hello', {}, adult('Bob'), { callClaude: spy });
  const sys = spy.capturedSystem();
  // adult system prompt addresses recipient by name
  assert.ok(sys.toLowerCase().includes('name') || sys.includes('Bob'), `should address by name, got: ${sys}`);
});
