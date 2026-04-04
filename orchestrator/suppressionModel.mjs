// Suppression model — governs proactive (bot-initiated) messages only.
// canNotify() is read-only. increment() is called by the proactive send path after delivery.
// See: GitHub issue #4

import db from '../db/db.mjs';

// canNotify: pure read-only check — does not mutate state.
// priority: 1=CRITICAL (always), 2=NORMAL (full cap), 3=LOW (50% cap)
export function canNotify(member, priority, state) {
  if (priority === 1) return true;

  if (state.snooze_until && new Date(state.snooze_until) > new Date()) {
    return false;
  }

  if (isQuietHours(member)) {
    return false;
  }

  const cap = priority === 3
    ? Math.floor(member.max_daily_notifications * 0.5)
    : member.max_daily_notifications;

  if (state.daily_count >= cap) {
    return false;
  }

  return true;
}

function isQuietHours(member) {
  const { quiet_start, quiet_end, timezone } = member;

  // Zero-width window: quiet_start === quiet_end means never quiet
  if (quiet_start === quiet_end) return false;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = timeStr.split(':');
  const h = Number(parts[0]) % 24; // guard against locale returning "24:00" for midnight
  const m = Number(parts[1]);
  const current = h * 60 + m;

  const [sh, sm] = quiet_start.split(':').map(Number);
  const [eh, em] = quiet_end.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;

  if (start < end) {
    // Same-day window e.g. 09:00–17:00
    return current >= start && current < end;
  } else {
    // Midnight-crossing window e.g. 23:00–05:00
    return current >= start || current < end;
  }
}

export function increment(memberId) {
  db.prepare('UPDATE notification_state SET daily_count = daily_count + 1 WHERE member_id = ?').run(memberId);
}
