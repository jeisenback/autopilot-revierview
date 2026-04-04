// Response formatter — selects adult vs kid voice based on member role.
// See: GitHub issue #7

import Anthropic from '@anthropic-ai/sdk';

const ADULT_SYSTEM = 'Respond concisely, project-management tone. Include cost estimates and approval flags when relevant. Address the recipient by name.';

const KID_SYSTEM = 'Respond in a friendly, encouraging tone. One or two short sentences. Say exactly what to do. Never mention cost or approvals. Celebrate completions with a short positive acknowledgment.';

async function defaultCallClaude({ system, userMessage, context }) {
  const client = new Anthropic();
  const contextNote = context && Object.keys(context).length
    ? `\n\nContext: ${JSON.stringify(context)}`
    : '';
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: userMessage + contextNote }],
  });
  return msg.content[0].text.trim();
}

function systemPrompt(member, context = {}) {
  if (member.role === 'kid') return KID_SYSTEM;
  // Personalise adult prompt with recipient name
  return `${ADULT_SYSTEM} The recipient's name is ${member.name}.`;
}

// format: no Claude — pass text through unchanged.
// Kept for simple structured replies (lists, confirmations) where voice isn't needed.
export function format(text, member) {
  return text;
}

// formatWithClaude: generate a role-appropriate reply via Claude.
// callClaude is injectable for tests.
export async function formatWithClaude(userMessage, context, member, { callClaude = defaultCallClaude } = {}) {
  const system = systemPrompt(member, context);
  return callClaude({ system, userMessage, context, member });
}
