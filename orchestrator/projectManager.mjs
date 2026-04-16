// Project and task CRUD — create (with Claude decompose), complete (with recurrence), list, assign.
// See: GitHub issues #6, #15, #21

import Anthropic from '@anthropic-ai/sdk';
import { CronExpressionParser } from 'cron-parser';
import db_singleton from '../db/db.mjs';
import { createCalendarAdapter } from './calendarAdapter.mjs';
import { createTasksAdapter } from './tasksAdapter.mjs';

const APPROVAL_THRESHOLD_USD = Number(process.env.APPROVAL_THRESHOLD_USD || 25);

const DECOMPOSE_SYSTEM = `You are a household project manager.
Given a project title, return 3-6 concrete tasks as a JSON array.
Each task: { "title": string, "estimated_cost": number, "notes": string }
estimated_cost is USD materials estimate (0 if no materials needed). Labor not included.
JSON only. No explanation.`;

async function defaultCallClaude(projectTitle) {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: DECOMPOSE_SYSTEM,
    messages: [{ role: 'user', content: projectTitle }],
  });
  return msg.content[0].text.trim();
}

async function defaultPostMessage(channelId, text) {
  const url = process.env.RESPONSE_SERVER_URL;
  if (!url) { process.stderr.write(`projectManager: no RESPONSE_SERVER_URL, skip DM\n`); return; }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, content: text }),
  });
}

function parseDecompose(raw, fallbackTitle) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // fall through
  }
  return [{ title: fallbackTitle, estimated_cost: 0, notes: '' }];
}

// nextDueDate: compute the next occurrence for a task's recurrence.
// recurrenceCron takes precedence when present (cron-parser).
// Falls back to simple +1/+7/+30 for the legacy recurrence enum.
// Returns YYYY-MM-DD string, or null if neither field is set.
export function nextDueDate(dueDate, recurrence, recurrenceCron) {
  if (recurrenceCron) {
    // Parse from the due date + 1 second so we get the NEXT occurrence after it.
    const from = dueDate ? new Date(`${dueDate}T00:00:01Z`) : new Date();
    const interval = CronExpressionParser.parse(recurrenceCron, { currentDate: from, tz: 'UTC' });
    return interval.next().toISOString().split('T')[0];
  }
  if (!dueDate || !recurrence) return null;
  const d = new Date(`${dueDate}T12:00:00Z`);
  if (recurrence === 'daily')   d.setUTCDate(d.getUTCDate() + 1);
  if (recurrence === 'weekly')  d.setUTCDate(d.getUTCDate() + 7);
  if (recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().split('T')[0];
}

export function createProjectManager({
  db = db_singleton,
  postMessage = defaultPostMessage,
  callClaude = defaultCallClaude,
  approvalThreshold = APPROVAL_THRESHOLD_USD,
  calendar = null,     // createCalendarAdapter() instance; null disables Calendar push
  tasksAdapter = null, // createTasksAdapter() instance; null disables Google Tasks sync
} = {}) {

  function getCalendar() {
    if (calendar === null) return null;
    if (calendar) return calendar;
    try { return createCalendarAdapter(); } catch { return null; }
  }

  function getTa() {
    if (tasksAdapter === null) return null;
    if (tasksAdapter) return tasksAdapter;
    try { return createTasksAdapter(); } catch { return null; }
  }

  // pushTaskCalendar: push/update a task's Calendar event. No-op if no due_date.
  async function pushTaskCalendar(taskId) {
    const cal = getCalendar();
    if (!cal) return;
    const task = db.prepare(`
      SELECT t.*, m.name AS assignee_name
      FROM tasks t LEFT JOIN members m ON m.id = t.assigned_to
      WHERE t.id = ?
    `).get(taskId);
    if (!task?.due_date) return;
    try {
      const eventId = await cal.pushTaskEvent(task);
      if (eventId && eventId !== task.google_calendar_event_id) {
        db.prepare(`UPDATE tasks SET google_calendar_event_id=? WHERE id=?`).run(eventId, taskId);
      }
    } catch (err) {
      process.stderr.write(`projectManager: Calendar push failed for task ${taskId}: ${err.message}\n`);
    }
  }

  // deleteTaskCalendar: remove a task's Calendar event. No-op if no event id.
  async function deleteTaskCalendar(taskId) {
    const cal = getCalendar();
    if (!cal) return;
    const task = db.prepare(`SELECT google_calendar_event_id FROM tasks WHERE id=?`).get(taskId);
    if (!task?.google_calendar_event_id) return;
    try {
      await cal.deleteTaskEvent(task.google_calendar_event_id);
      db.prepare(`UPDATE tasks SET google_calendar_event_id=NULL WHERE id=?`).run(taskId);
    } catch (err) {
      process.stderr.write(`projectManager: Calendar delete failed for task ${taskId}: ${err.message}\n`);
    }
  }

  async function create(title, requestedBy) {
    // 1. Insert project row
    const projectId = db.prepare(
      `INSERT INTO projects (title, status, owner_id) VALUES (?, 'active', ?)`
    ).run(title, requestedBy?.id ?? null).lastInsertRowid;

    // 2. Decompose via Claude with fallback
    let raw;
    try { raw = await callClaude(title); } catch { raw = ''; }
    const taskDefs = parseDecompose(raw, title);

    // 3. Insert tasks; queue approvals for high-cost items
    const createdTasks = [];
    for (const def of taskDefs) {
      const cost = Number(def.estimated_cost) || 0;
      const needsApproval = cost >= approvalThreshold ? 1 : 0;
      const status = needsApproval ? 'awaiting_approval' : 'todo';

      const taskId = db.prepare(`
        INSERT INTO tasks (project_id, title, description, estimated_cost, requires_approval, status, created_from)
        VALUES (?, ?, ?, ?, ?, ?, 'claude')
      `).run(projectId, def.title, def.notes || null, cost, needsApproval, status).lastInsertRowid;

      createdTasks.push({ id: taskId, title: def.title, cost, needsApproval, status });
    }

    // 4. Request approvals where needed (fire-and-forget; don't block the response)
    if (requestedBy) {
      for (const t of createdTasks.filter(t => t.needsApproval)) {
        postMessage(
          requestedBy.discord_dm_channel_id,
          `Task '${t.title}' (~$${t.cost}) needs approval before it can start.`
        ).catch(err => process.stderr.write(`projectManager: approval DM failed: ${err.message}\n`));
      }
    }

    // 6. Push tasks to requester's Google Tasks list (fire-and-forget).
    const ta = getTa();
    if (ta && requestedBy?.google_tasks_list_id) {
      for (const t of createdTasks) {
        const fullTask = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(t.id);
        ta.push(fullTask, requestedBy).catch(err =>
          process.stderr.write(`projectManager: Tasks push failed for task ${t.id}: ${err.message}\n`)
        );
      }
    }

    // 7. Return checklist string
    const lines = createdTasks.map(t => {
      const flag = t.needsApproval ? ' ⏳ awaiting approval' : '';
      return `- [ ] ${t.title}${flag}`;
    });
    return `**${title}**\n${lines.join('\n')}`;
  }

  async function complete(taskId, member) {
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    if (!task) return `Task ${taskId} not found.`;

    if (member?.role === 'kid' && task.assigned_to !== member.id) {
      return `That task isn't assigned to you — ask a parent.`;
    }

    let newTaskId = null;
    // Capture broadcast candidates BEFORE the transaction: status='blocked' tasks that
    // will become fully unblocked. Must run before the UPDATE so we don't pick up tasks
    // that were always 'todo', or the new recurring instance which starts 'todo'.
    const broadcastCandidates = db.prepare(`
      SELECT t.id, t.title, m.discord_dm_channel_id
      FROM task_dependencies td
      JOIN tasks t  ON t.id  = td.task_id
      JOIN members m ON m.id = t.assigned_to
      WHERE td.depends_on_task_id = ?
        AND t.status = 'blocked'
        AND m.discord_dm_channel_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td2
          JOIN tasks dep2 ON dep2.id = td2.depends_on_task_id
          WHERE td2.task_id = t.id
            AND dep2.id != ?
            AND dep2.status NOT IN ('done','skipped')
        )
    `).all(taskId, taskId);

    db.transaction(() => {
      // Mark done
      db.prepare(`UPDATE tasks SET status='done', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(taskId);

      // Unblock dependents: tasks that depended only on this task (all their deps are now done/skipped)
      db.prepare(`
        UPDATE tasks SET status='todo'
        WHERE status='blocked'
          AND id IN (SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies td2
            JOIN tasks dep2 ON dep2.id = td2.depends_on_task_id
            WHERE td2.task_id = tasks.id
              AND dep2.id != ?
              AND dep2.status NOT IN ('done','skipped')
          )
      `).run(taskId, taskId);

      // Recurrence: create next instance (supports both legacy enum and cron expressions)
      if (task.recurrence || task.recurrence_cron) {
        const newDue = nextDueDate(task.due_date, task.recurrence, task.recurrence_cron);
        newTaskId = db.prepare(`
          INSERT INTO tasks (project_id, title, description, estimated_cost, requires_approval,
                             assigned_to, due_date, priority, recurrence, recurrence_cron, created_from)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude')
        `).run(
          task.project_id, task.title, task.description, task.estimated_cost,
          task.requires_approval, task.assigned_to, newDue, task.priority,
          task.recurrence, task.recurrence_cron
        ).lastInsertRowid;

        // Copy dependencies to new instance
        const deps = db.prepare(`SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?`).all(taskId);
        for (const dep of deps) {
          db.prepare(`INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`).run(newTaskId, dep.depends_on_task_id);
        }
      }
    })();

    // Calendar: delete completed task's event; push next recurrence event (non-blocking).
    deleteTaskCalendar(taskId).catch(() => {});
    if (newTaskId) pushTaskCalendar(newTaskId).catch(() => {});

    // Google Tasks: mark the completed task done in the assignee's list (fire-and-forget).
    const ta = getTa();
    if (ta && task.google_task_id && task.assigned_to) {
      const assignee = db.prepare(`SELECT * FROM members WHERE id=?`).get(task.assigned_to);
      if (assignee?.google_tasks_list_id) {
        ta.completeRemote(task, assignee).catch(err =>
          process.stderr.write(`projectManager: Tasks completeRemote failed for task ${taskId}: ${err.message}\n`)
        );
      }
    }

    // Broadcast to assignees of tasks newly unblocked (fire-and-forget, per-task error isolation).
    for (const ut of broadcastCandidates) {
      postMessage(ut.discord_dm_channel_id,
        `✅ **"${ut.title}"** is now unblocked — ready to start.`
      ).catch(err => process.stderr.write(`projectManager: broadcast failed for task ${ut.id}: ${err.message}\n`));
    }

    return `Task '${task.title}' marked done.`;
  }

  // setDueDate: set or update a task's due date and sync to Calendar.
  async function setDueDate(taskId, dueDate) {
    const task = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    db.prepare(`UPDATE tasks SET due_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
      .run(dueDate, taskId);
    if (dueDate) {
      await pushTaskCalendar(taskId);
    } else {
      await deleteTaskCalendar(taskId);
    }
    return `Task '${task.title}' due date set to ${dueDate ?? 'none'}.`;
  }

  function listOpen() {
    const projects = db.prepare(`
      SELECT p.*, m.name as owner_name
      FROM projects p
      LEFT JOIN members m ON m.id = p.owner_id
      WHERE p.status IN ('open','active','blocked')
      ORDER BY p.priority ASC, p.due_date ASC NULLS LAST
    `).all();

    if (projects.length === 0) return 'No open projects.';

    return projects.map(p => {
      const tasks = db.prepare(`
        SELECT * FROM tasks
        WHERE project_id = ? AND status NOT IN ('done','skipped')
        ORDER BY priority ASC, due_date ASC NULLS LAST
      `).all(p.id);
      const taskLines = tasks.length
        ? tasks.map(t => `  - [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')
        : '  (no open tasks)';
      return `**${p.title}** [${p.status}]\n${taskLines}`;
    }).join('\n\n');
  }

  function statusSummary(pendingApprovalCount = 0) {
    const today = new Date().toISOString().split('T')[0];

    const projectCounts = db.prepare(`
      SELECT status, COUNT(*) as cnt
      FROM projects
      WHERE status IN ('open','active','blocked')
      GROUP BY status
    `).all();

    const overdue = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE status IN ('todo','in_progress','blocked') AND due_date < ?
    `).get(today).cnt;

    const dueToday = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE status IN ('todo','in_progress','blocked') AND due_date = ?
    `).get(today).cnt;

    const schedule = process.env.BRIEFING_CRON || '0 8 * * *';
    const briefingHour = schedule.split(' ')[1] || '8';

    const lines = [];
    if (projectCounts.length === 0) {
      lines.push('Projects: none open');
    } else {
      const parts = projectCounts.map(r => `${r.cnt} ${r.status}`).join(', ');
      lines.push(`Projects: ${parts}`);
    }
    lines.push(`Tasks overdue: ${overdue} | due today: ${dueToday}`);
    lines.push(`Pending approvals: ${pendingApprovalCount}`);
    lines.push(`Next briefing: ${briefingHour}:00`);
    return lines.join('\n');
  }

  async function assign(taskId, targetDiscordId) {
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const target = db.prepare(`SELECT * FROM members WHERE discord_user_id = ?`).get(targetDiscordId);
    if (!target) throw new Error(`Member not found: ${targetDiscordId}`);

    db.prepare(`UPDATE tasks SET assigned_to = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(target.id, taskId);

    if (target.discord_dm_channel_id) {
      const voice = target.role === 'kid'
        ? `Hey! You've been assigned a new task: "${task.title}". You got this!`
        : `You've been assigned a task: "${task.title}".`;
      await postMessage(target.discord_dm_channel_id, voice);
    }
  }

  return { create, complete, setDueDate, listOpen, statusSummary, assign };
}

// ─── singletons ───────────────────────────────────────────────────────────────

const manager = createProjectManager();
export async function create(title, requestedBy) { return manager.create(title, requestedBy); }
export async function complete(taskId, member) { return manager.complete(taskId, member); }
export async function setDueDate(taskId, dueDate) { return manager.setDueDate(taskId, dueDate); }
export function listOpen() { return manager.listOpen(); }
export function statusSummary(pendingApprovalCount) { return manager.statusSummary(pendingApprovalCount); }
export async function assign(taskId, targetDiscordId) { return manager.assign(taskId, targetDiscordId); }
