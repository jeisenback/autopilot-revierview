// Cron job registration — approval expiry and daily notification reset.
// See: GitHub issue #11
// Call registerAll(cron, db) once at process start from the webhook server.

import db_singleton from '../db/db.mjs';
import { expireStale } from './approvalManager.mjs';
import { registerCron as registerBriefingCron } from './briefingEngine.mjs';
import { scheduleTomorrow, sendDepartureReminders } from './templateEngine.mjs';

// resetDailyCounts: exported for direct testing without cron machinery.
export function resetDailyCounts(db = db_singleton) {
  db.prepare(`
    UPDATE notification_state
    SET daily_count = 0, daily_reset_date = date('now')
  `).run();
}

export function registerAll(cron, db = db_singleton) {
  // Morning briefing — 8am daily (configurable via BRIEFING_CRON)
  registerBriefingCron(cron);

  // Approval expiry — every hour
  cron.schedule('0 * * * *', () => {
    expireStale().catch(err => {
      process.stderr.write(`cron: expireStale failed: ${err.message}\n`);
    });
  });

  // Daily notification count reset — midnight
  cron.schedule('0 0 * * *', () => {
    try {
      resetDailyCounts(db);
    } catch (err) {
      process.stderr.write(`cron: resetDailyCounts failed: ${err.message}\n`);
    }
  });

  // Schedule template runs for tomorrow — nightly at 11pm
  cron.schedule('0 23 * * *', () => {
    try {
      scheduleTomorrow();
    } catch (err) {
      process.stderr.write(`cron: scheduleTomorrow failed: ${err.message}\n`);
    }
  });

  // Departure reminders — every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    sendDepartureReminders().catch(err => {
      process.stderr.write(`cron: sendDepartureReminders failed: ${err.message}\n`);
    });
  });
}
