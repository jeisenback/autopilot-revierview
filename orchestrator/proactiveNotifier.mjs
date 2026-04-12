// Proactive DM notifier — discover DM channel on first interaction, send proactive messages.
// See: GitHub issue #18

import db_singleton from '../db/db.mjs';
import { increment as nsIncrement } from './suppressionModel.mjs';

const RESPONSE_SERVER_PORT = Number(process.env.RESPONSE_SERVER_PORT || 8789);

// discoverDmChannel: call Discord's createDM endpoint to get/create the DM channel ID.
// Returns the channel ID string, or null on failure.
async function defaultCreateDm(discordUserId) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${token}`,
      },
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

async function defaultPostToResponseServer(channelId, text) {
  const url = `http://127.0.0.1:${RESPONSE_SERVER_PORT}/response`;
  const requestId = `proactive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, response: text, channelId }),
  });
  return { ok: res.ok, status: res.status };
}

export function createProactiveNotifier({
  db = db_singleton,
  createDm = defaultCreateDm,
  postToResponseServer = defaultPostToResponseServer,
  increment = nsIncrement,
} = {}) {

  // syncDmChannel: if member.discord_dm_channel_id is not set, discover and persist it.
  // Safe to call on every inbound message — no-ops when already populated.
  async function syncDmChannel(member) {
    if (member.discord_dm_channel_id) return member.discord_dm_channel_id;

    const channelId = await createDm(member.discord_user_id);
    if (!channelId) return null;

    db.prepare(`UPDATE members SET discord_dm_channel_id = ? WHERE id = ?`).run(channelId, member.id);
    member.discord_dm_channel_id = channelId; // update in-memory row
    return channelId;
  }

  // sendProactive: deliver a message to a member, respecting DM channel / briefing fallback.
  // Increments daily_count after successful delivery.
  async function sendProactive(member, text) {
    const channelId = member.discord_dm_channel_id || process.env.BRIEFING_CHANNEL_ID;
    if (!channelId) {
      process.stderr.write(`proactiveNotifier: no channel for member ${member.id} — skipping\n`);
      return false;
    }

    try {
      const result = await postToResponseServer(channelId, text);
      if (result.ok) {
        increment(member.id);
        return true;
      }
      process.stderr.write(`proactiveNotifier: response server returned ${result.status} for member ${member.id}\n`);
      return false;
    } catch (err) {
      process.stderr.write(`proactiveNotifier: send failed for member ${member.id}: ${err.message}\n`);
      return false;
    }
  }

  return { syncDmChannel, sendProactive };
}

// singleton
const notifier = createProactiveNotifier();
export async function syncDmChannel(member) { return notifier.syncDmChannel(member); }
export async function sendProactive(member, text) { return notifier.sendProactive(member, text); }
