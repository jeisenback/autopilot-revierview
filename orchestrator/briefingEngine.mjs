// Briefing engine — generates and posts the daily morning briefing.
// See: GitHub issue #9

import Anthropic from '@anthropic-ai/sdk';
import db_singleton from '../db/db.mjs';
import * as haAdapter from './haAdapter.mjs';

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
} = {}) {

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

  return { sendMorningBriefing };
}

// ─── singleton for production use ────────────────────────────────────────────

const engine = createBriefingEngine();
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
