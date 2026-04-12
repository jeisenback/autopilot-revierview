// Briefing engine — generates and posts the daily morning briefing.
// See: GitHub issues #9, #32, #39

import Anthropic from '@anthropic-ai/sdk';
import db_singleton from '../db/db.mjs';
import * as haAdapter from './haAdapter.mjs';
import { createSpaceManager } from './spaceManager.mjs';

const BRIEFING_SYSTEM = `You are a household chief of staff writing a morning briefing.
3-5 bullets. Direct, practical. Include: overdue or due-today tasks, any HA alerts,
one proactive suggestion if the data supports it. Max 150 words. Plain text only.`;

async function defaultCallClaude(contextText) {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: BRIEFING_SYSTEM,
    messages: [{ role: 'user', content: contextText }],
  });
  return msg.content[0].text.trim();
}

async function defaultPostMessage(channelId, text) {
  const url = process.env.RESPONSE_SERVER_URL;
  if (!url) { process.stdout.write(`briefing: no RESPONSE_SERVER_URL set, text:\n${text}\n`); return; }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, content: text }),
  });
  if (!res.ok) throw new Error(`response server returned ${res.status}`);
}

// createBriefingEngine: factory for dependency injection in tests.
export function createBriefingEngine({
  db = db_singleton,
  callClaude = defaultCallClaude,
  getStates = haAdapter.getStates,
  postMessage = defaultPostMessage,
  channelId = process.env.BRIEFING_CHANNEL_ID || '',
  monitoredEntities = (process.env.HA_MONITORED_ENTITIES || '').split(',').map(s => s.trim()).filter(Boolean),
  spaceManager = null,
} = {}) {
  // Lazy: only create if not injected, to avoid real-DB access during tests
  let _sm = spaceManager;
  function getSm() { if (!_sm) _sm = createSpaceManager({ db }); return _sm; }

  // ── buildDigest ──────────────────────────────────────────────────────────────
  // Returns structured digest data for one member. Pure read, no side effects.
  //
  // digest shape:
  //   member:    { id, name, role, discord_dm_channel_id }
  //   myTasks:   [{ id, title, status, due_date, priority, project_title }]  — sorted overdue first
  //   overdue:   subset of myTasks where due_date < date
  //   dueToday:  subset of myTasks where due_date === date
  //   blocking:  [{ id, title, blocked_member_name }]  — tasks I own that others are waiting on
  //   unblocked: [{ id, title, project_title }]  — tasks newly unblocked for me (all deps done)
  //   formatted: plain-text string ready to DM
  function buildDigest(memberId, date) {
    const member = db.prepare(`SELECT id, name, role, discord_dm_channel_id FROM members WHERE id = ?`).get(memberId);
    if (!member) throw new Error(`buildDigest: member ${memberId} not found`);

    // 1. My open tasks, priority + due_date sort (NULLs last)
    const myTasks = db.prepare(`
      SELECT t.id, t.title, t.status, t.due_date, t.priority, p.title AS project_title
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = ?
        AND t.status IN ('todo','in_progress','blocked')
      ORDER BY
        t.priority ASC,
        CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END ASC,
        t.due_date ASC
    `).all(memberId);

    const overdue   = myTasks.filter(t => t.due_date && t.due_date < date);
    const dueToday  = myTasks.filter(t => t.due_date === date);

    // 2. Tasks I'm blocking: other members' tasks that depend on a task I own
    //    task_dependencies(task_id, depends_on_task_id)
    //    "task_id is blocked until depends_on_task_id is done"
    const blocking = db.prepare(`
      SELECT dep_task.id, dep_task.title,
             m.name AS blocked_member_name
      FROM task_dependencies td
      JOIN tasks my_task    ON my_task.id = td.depends_on_task_id
      JOIN tasks dep_task   ON dep_task.id = td.task_id
      JOIN members m        ON m.id = dep_task.assigned_to
      WHERE my_task.assigned_to = ?
        AND my_task.status NOT IN ('done','skipped')
        AND dep_task.status NOT IN ('done','skipped')
        AND (dep_task.assigned_to IS NULL OR dep_task.assigned_to != ?)
    `).all(memberId, memberId);

    // 3. Tasks newly unblocked for me: assigned to me, all deps done, task still todo
    const unblocked = db.prepare(`
      SELECT t.id, t.title, p.title AS project_title
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_to = ?
        AND t.status = 'todo'
        AND EXISTS (
          SELECT 1 FROM task_dependencies td WHERE td.task_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON dep.id = td.depends_on_task_id
          WHERE td.task_id = t.id
            AND dep.status NOT IN ('done','skipped')
        )
    `).all(memberId);

    // 4. Spaces needing attention: assigned to this member or any not-ready space
    //    (future: filter to spaces blocking a process template the member is involved in)
    const allNotReady = getSm().getNotReady();
    const mySpaces = allNotReady.filter(s => s.assigned_to === memberId);
    // Include unassigned not-ready spaces for adults (house-wide awareness)
    const sharedSpaces = member.role === 'adult'
      ? allNotReady.filter(s => s.assigned_to == null)
      : [];
    const notReadySpaces = [...new Map([...mySpaces, ...sharedSpaces].map(s => [s.id, s])).values()];

    const formatted = formatDigest(member, { myTasks, overdue, dueToday, blocking, unblocked, notReadySpaces }, date);

    return { member, myTasks, overdue, dueToday, blocking, unblocked, notReadySpaces, formatted };
  }

  // ── formatDigest ─────────────────────────────────────────────────────────────
  // Renders the digest as a plain-text string suitable for Discord DM.
  // Upgrade path: swap for embed builder once discord_router supports /push.
  function formatDigest(member, { myTasks, overdue, dueToday, blocking, unblocked, notReadySpaces = [] }, date) {
    const lines = [];
    const greeting = member.role === 'kid' ? `Hey ${member.name}!` : `Good morning, ${member.name}.`;
    lines.push(`**${greeting}** Here's your day (${date}):\n`);

    if (myTasks.length === 0) {
      lines.push('No open tasks assigned to you.');
    } else {
      if (overdue.length > 0) {
        lines.push(`🔴 **Overdue (${overdue.length}):**`);
        for (const t of overdue) lines.push(`  • ${t.title} [${t.project_title}] — due ${t.due_date}`);
      }
      if (dueToday.length > 0) {
        lines.push(`🟡 **Due today (${dueToday.length}):**`);
        for (const t of dueToday) lines.push(`  • ${t.title} [${t.project_title}]`);
      }
      const upcoming = myTasks.filter(t => !t.due_date || t.due_date > date);
      if (upcoming.length > 0) {
        const shown = upcoming.slice(0, 5);
        lines.push(`⚪ **Up next (${upcoming.length}):**`);
        for (const t of shown) lines.push(`  • ${t.title} [${t.project_title}]`);
        if (upcoming.length > 5) lines.push(`  …and ${upcoming.length - 5} more`);
      }
    }

    if (blocking.length > 0) {
      lines.push('');
      lines.push(`⛔ **Blocking ${blocking.length} task${blocking.length !== 1 ? 's' : ''}:**`);
      for (const b of blocking) lines.push(`  • ${b.title} (waiting on ${b.blocked_member_name})`);
    }

    if (unblocked.length > 0) {
      lines.push('');
      lines.push(`✅ **Now unblocked for you:**`);
      for (const u of unblocked) lines.push(`  • ${u.title} [${u.project_title}]`);
    }

    if (notReadySpaces.length > 0) {
      lines.push('');
      lines.push(`🏠 **Spaces needing attention (${notReadySpaces.length}):**`);
      for (const s of notReadySpaces) {
        const owner = s.assigned_to_name ? ` — ${s.assigned_to_name}` : '';
        lines.push(`  • ${s.name}${owner}: ${s.ready_state}`);
      }
    }

    return lines.join('\n');
  }

  // ── sendAllDigests ────────────────────────────────────────────────────────────
  // Sends personalized digest to every member who has a DM channel configured.
  // Called by the daily cron. Errors per-member are logged, never propagated.
  async function sendAllDigests(date) {
    const today = date || new Date().toISOString().split('T')[0];
    const members = db.prepare(`
      SELECT id, discord_dm_channel_id FROM members WHERE discord_dm_channel_id IS NOT NULL
    `).all();

    for (const m of members) {
      try {
        const digest = buildDigest(m.id, today);
        await postMessage(m.discord_dm_channel_id, digest.formatted);
      } catch (err) {
        process.stderr.write(`briefing: digest failed for member ${m.id}: ${err.message}\n`);
      }
    }
  }

  // ── sendMorningBriefing (legacy channel broadcast) ────────────────────────────
  async function sendMorningBriefing() {
    try {
      // 1. Query open/overdue tasks sorted by priority then due_date
      const today = new Date().toISOString().split('T')[0];
      const tasks = db.prepare(`
        SELECT t.title, t.status, t.due_date, t.priority, p.title as project_title
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.status IN ('todo','in_progress','blocked')
        ORDER BY t.priority ASC, t.due_date ASC NULLS LAST
        LIMIT 20
      `).all();

      const overdue   = tasks.filter(t => t.due_date && t.due_date < today);
      const dueToday  = tasks.filter(t => t.due_date === today);
      const upcoming  = tasks.filter(t => !t.due_date || t.due_date > today);

      // 2. Poll HA — omit silently on failure or empty entity list
      let haSection = '';
      if (monitoredEntities.length > 0) {
        try {
          const states = await getStates(monitoredEntities);
          if (states && states.length > 0) {
            haSection = '\n\nHome Assistant:\n' + states.map(s =>
              `- ${s.entity_id}: ${s.state}`
            ).join('\n');
          }
        } catch {
          // HA unreachable — omit section, continue with briefing
        }
      }

      // 3. Build context string for Claude
      const taskLines = [
        overdue.length  ? `Overdue (${overdue.length}): ${overdue.map(t => t.title).join(', ')}` : null,
        dueToday.length ? `Due today (${dueToday.length}): ${dueToday.map(t => t.title).join(', ')}` : null,
        upcoming.length ? `Upcoming (${upcoming.length}): ${upcoming.slice(0, 5).map(t => t.title).join(', ')}` : null,
      ].filter(Boolean);

      const context = taskLines.length
        ? `Tasks:\n${taskLines.join('\n')}${haSection}`
        : `No open tasks.${haSection}`;

      // 4. Generate briefing via Claude — fallback on error
      let text;
      try {
        text = await callClaude(context);
      } catch (err) {
        text = 'Morning briefing unavailable — check tasks manually.';
        process.stderr.write(`briefing: Claude error: ${err.message}\n`);
      }

      // 5. Post to briefing channel — log on error, never crash
      try {
        await postMessage(channelId, text);
      } catch (err) {
        process.stderr.write(`briefing: postMessage failed: ${err.message}\n`);
      }

    } catch (err) {
      process.stderr.write(`briefing: unexpected error: ${err.message}\n`);
    }
  }

  return { buildDigest, sendAllDigests, sendMorningBriefing };
}

// ─── singleton for production use ────────────────────────────────────────────

const engine = createBriefingEngine();
export function buildDigest(memberId, date) { return engine.buildDigest(memberId, date); }
export async function sendAllDigests(date) { return engine.sendAllDigests(date); }
export async function sendMorningBriefing() { return engine.sendMorningBriefing(); }

// ─── cron registration ────────────────────────────────────────────────────────

export function registerCron(cron) {
  const schedule = process.env.BRIEFING_CRON || '0 8 * * *';
  cron.schedule(schedule, () => {
    sendMorningBriefing().catch(err => {
      process.stderr.write(`briefing cron failed: ${err.message}\n`);
    });
  });
}
