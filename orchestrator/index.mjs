// Orchestrator entry point — called by the webhook listener for every inbound message.
// See: GitHub issue #8

import db_singleton from '../db/db.mjs';
import { parseIntent as parseIntent_default } from './intentParser.mjs';
import { dispatch as dispatch_default } from './commandRouter.mjs';

// createHandle: factory for dependency injection in tests.
export function createHandle({
  db = db_singleton,
  parseIntent = parseIntent_default,
  dispatch = dispatch_default,
} = {}) {
  const findMember = db.prepare('SELECT * FROM members WHERE discord_user_id = ?');

  return async function handle(body) {
    const discordUserId = body?.author?.discord_user_id;
    const member = discordUserId ? findMember.get(discordUserId) : null;
    if (!member) return "You're not registered. Ask a parent to add you.";

    const intent = await parseIntent(body.content || '');
    return dispatch(intent, member, body);
  };
}

// Singleton for production use
const handle_singleton = createHandle();
export async function handle(body) {
  return handle_singleton(body);
}
