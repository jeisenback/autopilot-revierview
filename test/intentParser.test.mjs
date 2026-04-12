import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentParser } from '../orchestrator/intentParser.mjs';

// No real Claude calls in tests — stub it
function noopClaude() { return async () => '{"intent":"unknown","command":null,"confidence":0}'; }

function parser(claudeResponse) {
  return createIntentParser({ callClaude: async () => claudeResponse ?? '{"intent":"unknown","command":null,"confidence":0}' });
}

// ─── /project add ────────────────────────────────────────────────────────────

test('/project add <title> → add_project', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/project add Paint the fence');
  assert.equal(r.intent, 'command');
  assert.equal(r.command, 'add_project');
  assert.equal(r.args.title, 'Paint the fence');
});

test('/project add trims extra whitespace', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('  /project add   Fix the roof  ');
  assert.equal(r.command, 'add_project');
  assert.equal(r.args.title, 'Fix the roof');
});

test('/PROJECT ADD is case-insensitive', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/PROJECT ADD Buy groceries');
  assert.equal(r.command, 'add_project');
});

// ─── /project list ───────────────────────────────────────────────────────────

test('/project list → list_projects', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/project list');
  assert.equal(r.intent, 'command');
  assert.equal(r.command, 'list_projects');
  assert.equal(r.args, undefined);
});

test('/Project List case-insensitive', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/Project List');
  assert.equal(r.command, 'list_projects');
});

// ─── /task done ──────────────────────────────────────────────────────────────

test('/task done <id> → complete_task', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/task done 42');
  assert.equal(r.intent, 'command');
  assert.equal(r.command, 'complete_task');
  assert.equal(r.args.taskId, 42);
});

test('/task done taskId is a number', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/task done 7');
  assert.equal(typeof r.args.taskId, 'number');
});

// ─── /assign ─────────────────────────────────────────────────────────────────

test('/assign <id> @user → assign_task', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/assign 5 <@123456>');
  assert.equal(r.intent, 'command');
  assert.equal(r.command, 'assign_task');
  assert.equal(r.args.taskId, 5);
  assert.equal(r.args.mention, '<@123456>');
});

// ─── /ask ────────────────────────────────────────────────────────────────────

test('/ask <question> → intent=question, command=ask', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/ask What tasks are overdue?');
  assert.equal(r.intent, 'question');
  assert.equal(r.command, 'ask');
  assert.equal(r.args.question, 'What tasks are overdue?');
});

// ─── /snooze ─────────────────────────────────────────────────────────────────

test('/snooze <hours> → snooze with numeric hours', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/snooze 2');
  assert.equal(r.intent, 'command');
  assert.equal(r.command, 'snooze');
  assert.equal(r.args.hours, 2);
});

test('/snooze accepts decimal hours', async () => {
  const { parseIntent } = parser();
  const r = await parseIntent('/snooze 0.5');
  assert.equal(r.args.hours, 0.5);
});

// ─── Claude fallback ─────────────────────────────────────────────────────────

test('unknown slash command falls through to Claude', async () => {
  const calls = [];
  const { parseIntent } = createIntentParser({
    callClaude: async text => { calls.push(text); return '{"intent":"unknown","command":null,"confidence":0}'; },
  });
  await parseIntent('/unknown-command foo');
  assert.equal(calls.length, 1);
});

test('natural language falls through to Claude', async () => {
  const calls = [];
  const { parseIntent } = createIntentParser({
    callClaude: async text => { calls.push(text); return '{"intent":"acknowledgment","command":null,"confidence":0.9}'; },
  });
  const r = await parseIntent('sounds good!');
  assert.equal(calls.length, 1);
  assert.equal(r.intent, 'acknowledgment');
});

test('Claude returning bad JSON → returns unknown intent, no crash', async () => {
  const { parseIntent } = createIntentParser({ callClaude: async () => 'not json' });
  const r = await parseIntent('something weird');
  assert.equal(r.intent, 'unknown');
  assert.equal(r.command, null);
});
