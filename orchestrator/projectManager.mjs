// Project and task CRUD — create (with Claude decompose), complete (with recurrence), list.
// See: GitHub issue #6

import Anthropic from '@anthropic-ai/sdk';
import db_singleton from '../db/db.mjs';

const APPROVAL_THRESHOLD_USD = Number(process.env.APPROVAL_THRESHOLD_USD) || 25;

const DECOMPOSE_SYSTEM = `You are a household project manager.
Given a project title, return 3-6 concrete tasks as a JSON array.
Each task: { "title": string, "estimated_cost": number, "notes": string }
estimated_cost is USD materials estimate (0 if no materials needed). Labor not included.
JSON only. No explanation.`;

async function defaultCallClaude(prompt) {
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: DECOMPOSE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text.trim();
}

// createManager: factory for dependency injection (tests pass fake db + Claude stub).
// Production callers use the default export instead.
export function createManager({ db = db_singleton, callClaude = defaultCallClaude, threshold = APPROVAL_THRESHOLD_USD } = {}) {

  async function create(title, requestedBy) {
    const raw = await callClaude(title);

    let tasks;
    try {
      const parsed = JSON.parse(raw);
      tasks = Array.isArray(parsed) ? parsed : null;
    } catch {
      tasks = null;
    }

    // Fallback: single task matching project title
    if (!tasks) {
      tasks = [{ title, estimated_cost: 0, notes: '' }];
    }

    const insertProject = db.prepare(
      `INSERT INTO projects (title, status, owner_id) VALUES (?, 'active', ?)`
    );
    const insertTask = db.prepare(
      `INSERT INTO tasks (project_id, title, estimated_cost, requires_approval, status, created_from)
       VALUES (?, ?, ?, ?, ?, 'claude')`
    );

    const doCreate = db.transaction(() => {
      const { lastInsertRowid: projectId } = insertProject.run(title, requestedBy.id);
      const created = [];
      for (const t of tasks) {
        const cost = Number(t.estimated_cost) || 0;
        const needsApproval = cost >= threshold ? 1 : 0;
        const status = needsApproval ? 'awaiting_approval' : 'todo';
        const { lastInsertRowid: taskId } = insertTask.run(projectId, t.title, cost, needsApproval, status);
        created.push({ id: taskId, title: t.title, status });
      }
      return { projectId, tasks: created };
    });

    const { projectId, tasks: created } = doCreate();

    const lines = created.map(t =>
      t.status === 'awaiting_approval'
        ? `- [ ] ${t.title} *(pending approval)*`
        : `- [ ] ${t.title}`
    );
    return `**${title}** (project #${projectId})\n${lines.join('\n')}`;
  }

  async function complete(taskId, member) {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) return `Task #${taskId} not found.`;

    if (member.role === 'kid' && task.assigned_to !== member.id) {
      return "That task isn't assigned to you — ask a parent.";
    }

    const now = new Date().toISOString();

    const doComplete = db.transaction(() => {
      // Mark done
      db.prepare(`UPDATE tasks SET status='done', updated_at=? WHERE id=?`).run(now, taskId);

      // Unblock dependents
      db.prepare(`
        UPDATE tasks SET status='todo', updated_at=?
        WHERE status='blocked'
          AND id IN (
            SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?
          )
      `).run(now, taskId);

      // Recurrence: create next instance
      if (task.recurrence) {
        const dueDate = nextDueDate(task.due_date, task.recurrence);
        const { lastInsertRowid: newTaskId } = db.prepare(`
          INSERT INTO tasks (project_id, title, description, status, assigned_to, estimated_cost,
                             requires_approval, due_date, priority, recurrence, created_from)
          VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.project_id, task.title, task.description, task.assigned_to,
          task.estimated_cost, task.requires_approval, dueDate,
          task.priority, task.recurrence, task.created_from
        );

        // Copy dependencies to new instance
        const deps = db.prepare('SELECT * FROM task_dependencies WHERE task_id = ?').all(taskId);
        for (const dep of deps) {
          db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(newTaskId, dep.depends_on_task_id);
        }
      }
    });

    doComplete();
    return `✓ Marked task #${taskId} as done.`;
  }

  function listOpen() {
    const projects = db.prepare(`
      SELECT p.*, COUNT(t.id) as task_count,
             SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) as done_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      WHERE p.status IN ('open','active','blocked')
      GROUP BY p.id
      ORDER BY p.priority ASC, p.due_date ASC NULLS LAST
    `).all();

    if (projects.length === 0) return 'No open projects.';

    return projects.map(p => {
      const progress = p.task_count ? ` (${p.done_count}/${p.task_count} tasks)` : '';
      const flag = p.status === 'blocked' ? ' 🚫' : '';
      return `**${p.title}**${flag} — #${p.id}${progress}`;
    }).join('\n');
  }

  return { create, complete, listOpen };
}

// ─── singleton for production use ────────────────────────────────────────────

const manager = createManager();

export async function create(title, requestedBy) { return manager.create(title, requestedBy); }
export async function complete(taskId, member) { return manager.complete(taskId, member); }
export function listOpen() { return manager.listOpen(); }
export async function assign() { throw new Error('not implemented'); }

// ─── helpers ─────────────────────────────────────────────────────────────────

function nextDueDate(currentDue, recurrence) {
  const base = currentDue ? new Date(currentDue) : new Date();
  switch (recurrence) {
    case 'daily':   base.setDate(base.getDate() + 1); break;
    case 'weekly':  base.setDate(base.getDate() + 7); break;
    case 'monthly': base.setMonth(base.getMonth() + 1); break;
  }
  return base.toISOString().split('T')[0];
}
