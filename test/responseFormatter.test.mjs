import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format, createResponseFormatter } from '../orchestrator/responseFormatter.mjs';

const adultMember = { role: 'adult', name: 'Alice', timezone: 'America/Chicago' };
const kidMember   = { role: 'kid',   name: 'Max',   timezone: 'America/Chicago' };

// ─── format() ────────────────────────────────────────────────────────────────

test('format(): adult member → text unchanged', () => {
  const text = 'Task created. Cost ~$50. Awaiting approval.';
  assert.equal(format(text, adultMember), text);
});

test('format(): kid member → cost stripped', () => {
  const result = format('Buy paint ~$30 from the store.', kidMember);
  assert.ok(!result.includes('$30'), 'cost should be removed');
});

test('format(): kid member → approval language stripped', () => {
  const result = format('Task is awaiting approval before start.', kidMember);
  assert.ok(!/approval/i.test(result), 'approval word should be removed');
});

test('format(): null member → text returned as-is', () => {
  const text = 'Hello world';
  assert.equal(format(text, null), text);
});

// ─── formatWithClaude() ──────────────────────────────────────────────────────

test('formatWithClaude(): adult member → adult system prompt used', async () => {
  const usedSystems = [];
  const { formatWithClaude } = createResponseFormatter({
    callClaude: async (system, prompt) => { usedSystems.push(system); return 'ok'; },
  });

  await formatWithClaude('list tasks', null, adultMember);

  assert.ok(usedSystems[0].includes('project-management'), 'adult system prompt should mention project-management');
});

test('formatWithClaude(): kid member → kid system prompt used', async () => {
  const usedSystems = [];
  const { formatWithClaude } = createResponseFormatter({
    callClaude: async (system, prompt) => { usedSystems.push(system); return 'ok'; },
  });

  await formatWithClaude('what do I need to do?', null, kidMember);

  assert.ok(usedSystems[0].includes('friendly'), 'kid system prompt should mention friendly');
  assert.ok(usedSystems[0].includes('Never mention cost'), 'kid system prompt should forbid cost');
});

test('formatWithClaude(): kid completion reply uses kid prompt (celebrate)', async () => {
  const usedSystems = [];
  const { formatWithClaude } = createResponseFormatter({
    callClaude: async (system, prompt) => { usedSystems.push(system); return 'Great job!'; },
  });

  const result = await formatWithClaude('I finished cleaning my room.', null, kidMember);

  assert.ok(usedSystems[0].includes('Celebrate'), 'kid prompt should mention celebration');
  assert.equal(result, 'Great job!');
});

test('formatWithClaude(): context is prepended to the prompt', async () => {
  const prompts = [];
  const { formatWithClaude } = createResponseFormatter({
    callClaude: async (system, prompt) => { prompts.push(prompt); return 'ok'; },
  });

  await formatWithClaude('any tasks?', 'Tasks: Fix roof', adultMember);

  assert.ok(prompts[0].includes('Fix roof'), 'context should appear in the prompt');
  assert.ok(prompts[0].includes('any tasks?'), 'user message should appear in the prompt');
});
