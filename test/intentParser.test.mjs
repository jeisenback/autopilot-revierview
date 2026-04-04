import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../orchestrator/intentParser.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

// Fails loudly if Claude is called — fast-path commands must not invoke it
const noClaudeAllowed = async () => { throw new Error('Claude should not be called for fast-path commands'); };

// Fixed Claude stub for fallback tests
function stubClaude(result) {
  let called = false;
  const fn = async () => { called = true; return result; };
  fn.wasCalled = () => called;
  return fn;
}

// ─── slash command fast paths ─────────────────────────────────────────────────

test('/project add parses title', async () => {
  const r = await parseIntent('/project add Buy groceries', { callClaude: noClaudeAllowed });
  assert.deepEqual(r, { intent: 'command', command: 'add_project', args: { title: 'Buy groceries' } });
});

test('/project list parses correctly', async () => {
  const r = await parseIntent('/project list', { callClaude: noClaudeAllowed });
  assert.deepEqual(r, { intent: 'command', command: 'list_projects' });
});

test('/task done parses taskId as number', async () => {
  const r = await parseIntent('/task done 42', { callClaude: noClaudeAllowed });
  assert.deepEqual(r, { intent: 'command', command: 'complete_task', args: { taskId: 42 } });
});

test('/assign parses taskId and mention', async () => {
  const r = await parseIntent('/assign 7 @alice', { callClaude: noClaudeAllowed });
  assert.deepEqual(r, { intent: 'command', command: 'assign_task', args: { taskId: 7, mention: '@alice' } });
});

test('/ask parses question text', async () => {
  const r = await parseIntent('/ask what is the status?', { callClaude: noClaudeAllowed });
  assert.deepEqual(r, { intent: 'question', command: 'ask', args: { question: 'what is the status?' } });
});

test('/snooze parses hours as number', async () => {
  const r = await parseIntent('/snooze 2', { callClaude: noClaudeAllowed });
  assert.deepEqual(r, { intent: 'command', command: 'snooze', args: { hours: 2 } });
});

// ─── whitespace and casing ────────────────────────────────────────────────────

test('leading/trailing whitespace is trimmed before matching', async () => {
  const r = await parseIntent('  /project add   Mow lawn  ', { callClaude: noClaudeAllowed });
  assert.equal(r.command, 'add_project');
  assert.equal(r.args.title, 'Mow lawn');
});

test('slash command prefix is case-insensitive', async () => {
  const r = await parseIntent('/PROJECT LIST', { callClaude: noClaudeAllowed });
  assert.deepEqual(r, { intent: 'command', command: 'list_projects' });
});

test('/TASK DONE is case-insensitive', async () => {
  const r = await parseIntent('/TASK DONE 5', { callClaude: noClaudeAllowed });
  assert.deepEqual(r, { intent: 'command', command: 'complete_task', args: { taskId: 5 } });
});

// ─── Claude fallback ──────────────────────────────────────────────────────────

test('natural language falls through to Claude', async () => {
  const spy = stubClaude({ intent: 'question', command: 'ask', confidence: 0.9 });
  await parseIntent('what tasks are left?', { callClaude: spy });
  assert.ok(spy.wasCalled(), 'Claude should be called for natural language');
});

test('unknown slash command falls through to Claude', async () => {
  const spy = stubClaude({ intent: 'unknown', command: null, confidence: 0.5 });
  await parseIntent('/unknown stuff', { callClaude: spy });
  assert.ok(spy.wasCalled(), 'Claude should be called for unrecognized slash commands');
});

test('Claude return value is forwarded as-is', async () => {
  const payload = { intent: 'acknowledgment', command: null, confidence: 0.95 };
  const spy = stubClaude(payload);
  const r = await parseIntent('ok thanks', { callClaude: spy });
  assert.deepEqual(r, payload);
});
