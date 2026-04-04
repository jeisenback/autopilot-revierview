// Intent parser — fast-path regex for slash commands, Claude fallback for natural language.
// See: GitHub issue #5

import Anthropic from '@anthropic-ai/sdk';

const INTENT_SYSTEM = `Classify the message as command, question, acknowledgment, or unknown.
Return JSON: { "intent": string, "command": string|null, "confidence": number }
command values: add_project, list_projects, complete_task, assign_task, ask, snooze, null
JSON only.`;

// Ordered list of fast-path patterns. First match wins.
const FAST_PATHS = [
  {
    pattern: /^\/project\s+add\s+(.+)$/i,
    result: (m) => ({ intent: 'command', command: 'add_project', args: { title: m[1].trim() } }),
  },
  {
    pattern: /^\/project\s+list$/i,
    result: () => ({ intent: 'command', command: 'list_projects' }),
  },
  {
    pattern: /^\/task\s+done\s+(\d+)$/i,
    result: (m) => ({ intent: 'command', command: 'complete_task', args: { taskId: Number(m[1]) } }),
  },
  {
    pattern: /^\/assign\s+(\d+)\s+(@\S+)$/i,
    result: (m) => ({ intent: 'command', command: 'assign_task', args: { taskId: Number(m[1]), mention: m[2] } }),
  },
  {
    pattern: /^\/ask\s+(.+)$/i,
    result: (m) => ({ intent: 'question', command: 'ask', args: { question: m[1].trim() } }),
  },
  {
    pattern: /^\/snooze\s+(\d+)$/i,
    result: (m) => ({ intent: 'command', command: 'snooze', args: { hours: Number(m[1]) } }),
  },
];

async function defaultCallClaude(text) {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: INTENT_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  return JSON.parse(msg.content[0].text.trim());
}

// parseIntent(text, { callClaude }) — callClaude is injectable for tests.
export async function parseIntent(text, { callClaude = defaultCallClaude } = {}) {
  const trimmed = text.trim();

  for (const { pattern, result } of FAST_PATHS) {
    const m = trimmed.match(pattern);
    if (m) return result(m);
  }

  return callClaude(trimmed);
}
