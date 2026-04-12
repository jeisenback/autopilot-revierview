// Suppression model — governs proactive (bot-initiated) messages only.
// canNotify() is read-only. increment() updates daily count after delivery.
// See: GitHub issues #4, #15

import db_singleton from '../db/db.mjs';

export function createSuppressionModel({ db = db_singleton } = {}) {

  // canNotify: returns true if the member can receive a proactive notification.
  // member: row from members table
  // state: row from notification_state table (snooze_until, daily_count)
  // priority: 1=CRITICAL, 2=NORMAL, 3=LOW
  function canNotify(member, state, priority) {
    // Active snooze
    if (state.snooze_until && state.snooze_until > new Date().toISOString()) {
      return false;
    }

    // Daily limit (CRITICAL bypasses)
    if (priority > 1 && state.daily_count >= member.max_daily_notifications) {
      return false;
    }

    // Quiet hours (CRITICAL bypasses)
    if (priority > 1) {
      const start = member.quiet_start; // HH:MM
      const end = member.quiet_end;
      if (start && end) {
        const now = new Date().toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: false, timeZone: member.timezone || 'UTC'
        });
        // Normalize to HH:MM (locale may return '24:xx' for midnight)
        const [rawH, rawM] = now.split(':');
        const h = Number(rawH) % 24;
        const cur = `${String(h).padStart(2, '0')}:${rawM}`;

        if (start === end) {
          // zero-width window — never quiet
        } else if (start >= end) {
          // midnight-crossing: quiet if cur >= start OR cur < end
          if (cur >= start || cur < end) return false;
        } else {
          if (cur >= start && cur < end) return false;
        }
      }
    }

    return true;
  }

  function increment(memberId) {
    db.prepare(`UPDATE notification_state SET daily_count = daily_count + 1 WHERE member_id = ?`).run(memberId);
  }

  function snooze(memberId, hours) {
    const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    db.prepare(`UPDATE notification_state SET snooze_until = ? WHERE member_id = ?`).run(until, memberId);
  }

  return { canNotify, increment, snooze };
}

// ─── singletons ───────────────────────────────────────────────────────────────

const model = createSuppressionModel();
export function canNotify(member, state, priority) { return model.canNotify(member, state, priority); }
export function increment(memberId) { return model.increment(memberId); }
export function snooze(memberId, hours) { return model.snooze(memberId, hours); }
