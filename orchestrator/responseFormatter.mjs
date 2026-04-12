// Response formatter — selects adult vs kid voice based on member role.
// See: GitHub issue #7

import Anthropic from '@anthropic-ai/sdk';

const ADULT_SYSTEM = 'Respond concisely, project-management tone. Include cost estimates and approval flags when relevant. Address the recipient by name.';
const KID_SYSTEM = 'Respond in a friendly, encouraging tone. One or two short sentences. Say exactly what to do. Never mention cost or approvals. Celebrate completions with a short positive acknowledgment.';

function systemFor(member) {
  return member?.role === 'kid' ? KID_SYSTEM : ADULT_SYSTEM;
}

// format: wrap a pre-built text string in role-appropriate framing (no Claude call).
export function format(text, member) {
  if (member?.role === 'kid') {
    // Strip any cost/approval language for kid recipients
    return text
      .replace(/~?\$\d+(\.\d+)?/g, '')
      .replace(/\b(approval|approve|approvals|awaiting approval)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return text;
}

async function defaultCallClaude(system, userMessage) {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: userMessage }],
  });
  return msg.content[0].text.trim();
}

export function createResponseFormatter({ callClaude = defaultCallClaude } = {}) {
  async function formatWithClaude(userMessage, context, member) {
    const system = systemFor(member);
    const prompt = context ? `Context:\n${context}\n\nMessage: ${userMessage}` : userMessage;
    return callClaude(system, prompt);
  }

  return { formatWithClaude };
}

// singleton
const formatter = createResponseFormatter();
export async function formatWithClaude(userMessage, context, member) {
  return formatter.formatWithClaude(userMessage, context, member);
}
