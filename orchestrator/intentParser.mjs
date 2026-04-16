// Intent parser — fast-path regex for slash commands, Claude fallback for natural language.
// See: GitHub issue #5

import Anthropic from '@anthropic-ai/sdk';

const INTENT_SYSTEM = `Classify the message as command, question, acknowledgment, or unknown.
Return JSON: { "intent": string, "command": string|null, "confidence": number }
command values: add_project, list_projects, complete_task, assign_task, ask, snooze, null
JSON only.`;

// Fast-path regex table — ordered most-specific first.
const FAST_PATHS = [
  {
    re: /^\/project\s+add\s+(.+)/i,
    parse: m => ({ intent: 'command', command: 'add_project', args: { title: m[1].trim() } }),
  },
  {
    re: /^\/project\s+list\b/i,
    parse: () => ({ intent: 'command', command: 'list_projects' }),
  },
  {
    re: /^\/task\s+done\s+(\d+)/i,
    parse: m => ({ intent: 'command', command: 'complete_task', args: { taskId: Number(m[1]) } }),
  },
  {
    re: /^\/assign\s+(\d+)\s+(<@[^>]+>|\S+)/i,
    parse: m => ({ intent: 'command', command: 'assign_task', args: { taskId: Number(m[1]), mention: m[2].trim() } }),
  },
  {
    re: /^\/ask\s+(.+)/i,
    parse: m => ({ intent: 'question', command: 'ask', args: { question: m[1].trim() } }),
  },
  {
    re: /^\/snooze\s+(\d+(?:\.\d+)?)/i,
    parse: m => ({ intent: 'command', command: 'snooze', args: { hours: Number(m[1]) } }),
  },
  {
    re: /^\/approvals?\s+list\b/i,
    parse: () => ({ intent: 'command', command: 'list_approvals' }),
  },
  {
    re: /^\/status\b/i,
    parse: () => ({ intent: 'command', command: 'status' }),
  },
  {
    re: /^\/space\s+list\b/i,
    parse: () => ({ intent: 'command', command: 'space_list' }),
  },
  {
    re: /^\/space\s+set-ready\s+(.+)/i,
    parse: m => ({ intent: 'command', command: 'space_set_ready', args: { name: m[1].trim() } }),
  },
  {
    re: /^\/space\s+set-not-ready\s+(.+)/i,
    parse: m => ({ intent: 'command', command: 'space_set_not_ready', args: { name: m[1].trim() } }),
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
  return msg.content[0].text.trim();
}

export function createIntentParser({ callClaude = defaultCallClaude } = {}) {
  async function parseIntent(text) {
    const s = (text || '').trim();

    for (const { re, parse } of FAST_PATHS) {
      const m = s.match(re);
      if (m) return parse(m);
    }

    // Unknown slash command → Claude fallback
    // Natural language → Claude fallback
    let raw;
    try { raw = await callClaude(s); } catch { raw = ''; }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.intent === 'string') return parsed;
    } catch { /* fall through */ }
    return { intent: 'unknown', command: null, confidence: 0 };
  }

  return { parseIntent };
}

// singleton
const parser = createIntentParser();
export async function parseIntent(text) { return parser.parseIntent(text); }
