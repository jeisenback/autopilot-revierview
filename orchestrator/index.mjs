// Orchestrator entry point — called by the webhook listener for every inbound message.
// See: GitHub issue #8

import db_singleton from '../db/db.mjs';
import { parseIntent } from './intentParser.mjs';
import { dispatch } from './commandRouter.mjs';
import { syncDmChannel as defaultSyncDmChannel } from './proactiveNotifier.mjs';

export function createOrchestrator({
  db = db_singleton,
  syncDmChannel = defaultSyncDmChannel,
} = {}) {
  async function handle(body) {
    // 1. Look up member by discord_user_id
    const discordUserId = body?.author?.discord_user_id ?? body?.author;
    if (!discordUserId) return "I don't know who you are — contact an admin to register.";

    const member = db.prepare(`SELECT * FROM members WHERE discord_user_id = ?`).get(discordUserId);
    if (!member) return "You're not registered.";

    // 2. Populate DM channel on first interaction (fire-and-forget, non-blocking)
    if (!member.discord_dm_channel_id && body?.event_type !== 'reaction') {
      syncDmChannel(member).catch(err =>
        process.stderr.write(`orchestrator: syncDmChannel failed: ${err.message}\n`)
      );
    }

    // 3. Reactions bypass intent parsing — route directly
    if (body?.event_type === 'reaction') {
      return dispatch({ intent: 'reaction', command: null }, member, body);
    }

    // 4. Parse intent from message content
    const intent = await parseIntent(body?.content ?? '');

    // 5. Dispatch → formatted response string
    return dispatch(intent, member, body);
  }

  return { handle };
}

// singleton
const orchestrator = createOrchestrator();
export async function handle(body) { return orchestrator.handle(body); }
