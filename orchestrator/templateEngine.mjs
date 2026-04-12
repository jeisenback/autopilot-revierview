// Template engine — recurring process checklists (soccer, weekly reset, pickups, etc.)
// Handles run creation, item completion, departure reminders, and Calendar push sync.

import db_singleton from '../db/db.mjs';
import { createCalendarAdapter } from './calendarAdapter.mjs';

// Auto-generate Google Maps directions URL from a street address.
export function mapsUrl(address) {
  if (!address) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

// Day-of-week number for a YYYY-MM-DD date string (0=Sun … 6=Sat).
function dowForDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

// Tomorrow's date as YYYY-MM-DD.
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// Today's date as YYYY-MM-DD.
function today() {
  return new Date().toISOString().split('T')[0];
}

// Current local HH:MM in a given IANA timezone.
function localTimeHHMM(timezone = 'UTC') {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
  }).replace(/^24:/, '00:');
}

async function defaultPostMessage(channelId, text) {
  const url = process.env.RESPONSE_SERVER_URL;
  if (!url) { process.stderr.write(`templateEngine: no RESPONSE_SERVER_URL\n`); return; }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, content: text }),
  });
}

export function createTemplateEngine({
  db = db_singleton,
  postMessage = defaultPostMessage,
  reminderLeadMinutes = 30,
  calendar = null, // createCalendarAdapter() instance; null disables Calendar push
} = {}) {

  // Lazy-init calendar adapter (skipped if explicitly passed null or if creds absent).
  function getCalendar() {
    if (calendar === null) return null;
    if (calendar) return calendar;
    try {
      return createCalendarAdapter();
    } catch {
      return null; // no credentials — skip silently
    }
  }

  // ── run lifecycle ──────────────────────────────────────────────────────────

  // createRun: instantiate a template for a specific date.
  // Auto-populates run_item_completions and pushes a Google Calendar event.
  // Returns the run id (idempotent — returns existing id if already created).
  async function createRun(templateId, scheduledFor) {
    const existing = db.prepare(
      `SELECT id FROM template_runs WHERE template_id=? AND scheduled_for=?`
    ).get(templateId, scheduledFor);
    if (existing) return existing.id;

    const template = db.prepare(`SELECT * FROM process_templates WHERE id=?`).get(templateId);
    if (!template) throw new Error(`Template not found: ${templateId}`);

    const runId = db.transaction(() => {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO template_runs (template_id, scheduled_for, depart_at)
        VALUES (?, ?, ?)
      `).run(templateId, scheduledFor, template.depart_time ?? null);

      const items = db.prepare(`SELECT id FROM template_items WHERE template_id=?`).all(templateId);
      for (const item of items) {
        db.prepare(`INSERT INTO run_item_completions (run_id, item_id) VALUES (?, ?)`).run(lastInsertRowid, item.id);
      }
      return lastInsertRowid;
    })();

    // Push Calendar event (non-blocking; failure doesn't abort run creation).
    const cal = getCalendar();
    if (cal) {
      try {
        const run = db.prepare(`SELECT * FROM template_runs WHERE id=?`).get(runId);
        const eventId = await cal.pushRunEvent({ ...run, title: template.title,
          location_name: template.location_name, location_address: template.location_address,
          driver_notes: template.driver_notes, reward: template.reward });
        db.prepare(`UPDATE template_runs SET google_calendar_event_id=? WHERE id=?`).run(eventId, runId);
      } catch (err) {
        process.stderr.write(`templateEngine: Calendar push failed for run ${runId}: ${err.message}\n`);
      }
    }

    return runId;
  }

  // completeItem: mark a single checklist item as done within a run.
  function completeItem(runId, itemId) {
    db.prepare(`
      UPDATE run_item_completions
      SET completed=1, completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE run_id=? AND item_id=?
    `).run(runId, itemId);
  }

  // completeRun: mark the whole run done (auto-called when all items checked off).
  function completeRun(runId) {
    db.prepare(`
      UPDATE template_runs
      SET status='done', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id=?
    `).run(runId);
    // Calendar event stays — it's useful history. Update title to show done? No-op for now.
  }

  // skipRun: mark run skipped and delete its Calendar event.
  async function skipRun(runId) {
    const run = db.prepare(`SELECT google_calendar_event_id FROM template_runs WHERE id=?`).get(runId);
    db.prepare(`UPDATE template_runs SET status='skipped' WHERE id=?`).run(runId);
    const cal = getCalendar();
    if (cal && run?.google_calendar_event_id) {
      try {
        await cal.deleteRunEvent(run.google_calendar_event_id);
        db.prepare(`UPDATE template_runs SET google_calendar_event_id=NULL WHERE id=?`).run(runId);
      } catch (err) {
        process.stderr.write(`templateEngine: Calendar delete failed for run ${runId}: ${err.message}\n`);
      }
    }
  }

  // getRun: returns a run with its template, items, and per-item completion state.
  function getRun(runId) {
    const run = db.prepare(`SELECT * FROM template_runs WHERE id=?`).get(runId);
    if (!run) return null;
    const template = db.prepare(`SELECT * FROM process_templates WHERE id=?`).get(run.template_id);
    const items = db.prepare(`
      SELECT ti.*, ric.completed, ric.completed_at
      FROM template_items ti
      JOIN run_item_completions ric ON ric.item_id=ti.id AND ric.run_id=?
      ORDER BY ti.sort_order ASC
    `).all(runId);
    return {
      ...run,
      template: { ...template, location_url: mapsUrl(template.location_address) },
      items,
      completedCount: items.filter(i => i.completed).length,
      totalCount: items.length,
    };
  }

  // getTodayRuns: all pending/active runs for today with their templates.
  function getTodayRuns() {
    const runs = db.prepare(`
      SELECT tr.*, pt.title AS template_title, pt.depart_time, pt.location_name,
             pt.location_address, pt.driver_notes, pt.reward, pt.owner_id
      FROM template_runs tr
      JOIN process_templates pt ON pt.id = tr.template_id
      WHERE tr.scheduled_for = ? AND tr.status IN ('pending','active')
      ORDER BY tr.depart_at ASC NULLS LAST
    `).all(today());
    return runs.map(r => ({ ...r, location_url: mapsUrl(r.location_address) }));
  }

  // ── nightly run generation ─────────────────────────────────────────────────

  // scheduleRunsForDate: creates runs for all active templates whose recurrence
  // matches the given date. Safe to call multiple times (idempotent).
  async function scheduleRunsForDate(dateStr) {
    const dow = dowForDate(dateStr);
    const templates = db.prepare(`SELECT * FROM process_templates WHERE active=1`).all();
    const created = [];

    for (const t of templates) {
      let matches = false;
      if (t.recurrence === 'daily') matches = true;
      if (t.recurrence === 'weekly' && t.recurrence_day === dow) matches = true;
      // monthly/once handled separately (not yet implemented)
      if (!matches) continue;

      const runId = await createRun(t.id, dateStr);
      created.push({ templateId: t.id, runId, date: dateStr });
    }

    return created;
  }

  // scheduleTomorrow: called by nightly cron.
  async function scheduleTomorrow() {
    return scheduleRunsForDate(tomorrow());
  }

  // ── departure reminders ────────────────────────────────────────────────────

  // sendDepartureReminders: DMs all adults for any run departing within
  // `reminderLeadMinutes` that hasn't been reminded yet.
  async function sendDepartureReminders() {
    const now = today();
    const runs = db.prepare(`
      SELECT tr.*, pt.title, pt.location_name, pt.location_address,
             pt.driver_notes, pt.reward, pt.owner_id
      FROM template_runs tr
      JOIN process_templates pt ON pt.id = tr.template_id
      WHERE tr.scheduled_for = ?
        AND tr.reminder_sent = 0
        AND tr.status IN ('pending','active')
        AND tr.depart_at IS NOT NULL
    `).all(now);

    const adults = db.prepare(`
      SELECT * FROM members WHERE role='adult' AND discord_dm_channel_id IS NOT NULL
    `).all();

    for (const run of runs) {
      // Get owner's timezone for time comparison
      const owner = run.owner_id
        ? db.prepare(`SELECT timezone FROM members WHERE id=?`).get(run.owner_id)
        : null;
      const tz = owner?.timezone ?? process.env.DEFAULT_TIMEZONE ?? 'America/Chicago';
      const localNow = localTimeHHMM(tz);

      const [dh, dm] = run.depart_at.split(':').map(Number);
      const [nh, nm] = localNow.split(':').map(Number);
      const departMins = dh * 60 + dm;
      const nowMins = nh * 60 + nm;
      const minsUntil = departMins - nowMins;

      if (minsUntil < 0 || minsUntil > reminderLeadMinutes) continue;

      const items = db.prepare(`
        SELECT ti.*, ric.completed
        FROM template_items ti
        JOIN run_item_completions ric ON ric.item_id=ti.id AND ric.run_id=?
        ORDER BY ti.sort_order ASC
      `).all(run.id);

      const unchecked = items.filter(i => !i.completed);
      const locationLine = run.location_name
        ? `\n📍 ${run.location_name}${run.location_address ? ` — ${mapsUrl(run.location_address)}` : ''}`
        : '';
      const rewardLine = run.reward ? `\n🎉 ${run.reward}` : '';
      const notesLine = run.driver_notes ? `\n📝 ${run.driver_notes}` : '';

      const uncheckedList = unchecked.length > 0
        ? `\nStill needed:\n${unchecked.map(i => `  • ${i.label}`).join('\n')}`
        : '\n✅ All items checked off!';

      const text = [
        `⏰ **${run.title}** departs in ${minsUntil}m (${run.depart_at})`,
        locationLine,
        uncheckedList,
        notesLine,
        rewardLine,
      ].filter(Boolean).join('');

      // DM all adults
      for (const adult of adults) {
        try {
          await postMessage(adult.discord_dm_channel_id, text);
        } catch (err) {
          process.stderr.write(`templateEngine: DM failed for ${adult.id}: ${err.message}\n`);
        }
      }

      db.prepare(`UPDATE template_runs SET reminder_sent=1 WHERE id=?`).run(run.id);
    }
  }

  // ── formatted checklist ────────────────────────────────────────────────────

  // formatRunChecklist: returns a Discord-ready string for a run.
  function formatRunChecklist(runId) {
    const run = getRun(runId);
    if (!run) return 'Run not found.';

    const { template, items } = run;
    const lines = [`**${template.title}** — ${run.scheduled_for}`];
    if (template.depart_time) lines.push(`🕐 Depart: ${template.depart_time}`);
    if (template.location_name) {
      const url = mapsUrl(template.location_address);
      lines.push(`📍 ${template.location_name}${url ? ` — ${url}` : ''}`);
    }
    if (template.driver_notes) lines.push(`📝 ${template.driver_notes}`);
    lines.push('');

    // Group by category
    const categories = [...new Set(items.map(i => i.category ?? ''))];
    for (const cat of categories) {
      if (cat) lines.push(`**${cat}**`);
      for (const item of items.filter(i => (i.category ?? '') === cat)) {
        const check = item.completed ? '☑' : '☐';
        const qty = item.quantity > 1 ? ` ×${item.quantity}` : '';
        lines.push(`${check} ${item.label}${qty}`);
      }
    }

    if (template.reward) lines.push(`\n🎉 ${template.reward}`);
    lines.push(`\n${run.completedCount}/${run.totalCount} items checked`);
    return lines.join('\n');
  }

  return {
    createRun,
    completeItem,
    completeRun,
    skipRun,
    getRun,
    getTodayRuns,
    scheduleRunsForDate,
    scheduleTomorrow,
    sendDepartureReminders,
    formatRunChecklist,
    mapsUrl,
  };
}

// ── singletons ────────────────────────────────────────────────────────────────

const engine = createTemplateEngine();
export async function createRun(templateId, date) { return engine.createRun(templateId, date); }
export function completeItem(runId, itemId) { return engine.completeItem(runId, itemId); }
export function completeRun(runId) { return engine.completeRun(runId); }
export async function skipRun(runId) { return engine.skipRun(runId); }
export function getRun(runId) { return engine.getRun(runId); }
export function getTodayRuns() { return engine.getTodayRuns(); }
export async function scheduleRunsForDate(date) { return engine.scheduleRunsForDate(date); }
export async function scheduleTomorrow() { return engine.scheduleTomorrow(); }
export async function sendDepartureReminders() { return engine.sendDepartureReminders(); }
export function formatRunChecklist(runId) { return engine.formatRunChecklist(runId); }
