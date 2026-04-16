// Google Tasks push adapter — syncs autopilot tasks to per-member Google Task lists.
// Auth shares the same OAuth2 client / secrets.json as calendarAdapter.
// Requires members.google_tasks_list_id to be set; silently no-ops otherwise.
//
// See: GitHub issue #40

import { google } from 'googleapis';
import db_singleton from '../db/db.mjs';
import { buildOAuth2Client } from './calendarAdapter.mjs';

// ── factory ───────────────────────────────────────────────────────────────────

export function createTasksAdapter({
  db = db_singleton,
  _tasksClient = null, // injectable for tests: { tasks: { insert, patch, list } }
} = {}) {

  function getClient() {
    if (_tasksClient) return _tasksClient;
    const auth = buildOAuth2Client();
    return google.tasks({ version: 'v1', auth });
  }

  // push: create or update a Google Task for a local task.
  // member must have google_tasks_list_id — returns null otherwise (no-op).
  // Returns the google_task_id string on success.
  async function push(task, member) {
    if (!member?.google_tasks_list_id) return null;
    const client = getClient();

    const body = {
      title: task.title,
      notes: task.description ?? undefined,
      due: task.due_date ? `${task.due_date}T00:00:00.000Z` : undefined,
      status: 'needsAction',
    };

    if (task.google_task_id) {
      // Task already pushed — update in place.
      await client.tasks.patch({
        tasklist: member.google_tasks_list_id,
        task: task.google_task_id,
        requestBody: body,
      });
      return task.google_task_id;
    }

    // First push — create and persist the new google_task_id.
    const res = await client.tasks.insert({
      tasklist: member.google_tasks_list_id,
      requestBody: body,
    });
    const googleTaskId = res.data.id;
    db.prepare(`UPDATE tasks SET google_task_id=? WHERE id=?`).run(googleTaskId, task.id);
    return googleTaskId;
  }

  // completeRemote: mark a Google Task as completed.
  // Looks up the assignee's list; no-op if task has no google_task_id or member has no list.
  async function completeRemote(task, member) {
    if (!task?.google_task_id || !member?.google_tasks_list_id) return;
    const client = getClient();
    await client.tasks.patch({
      tasklist: member.google_tasks_list_id,
      task: task.google_task_id,
      requestBody: { status: 'completed' },
    }).catch(err => {
      // 404 = task already deleted in Google Tasks; nothing to do.
      if (err?.code !== 404) throw err;
    });
  }

  // syncAll: pull completed Google Tasks back to local DB for every member
  // who has google_tasks_list_id configured.
  // Called from cron; per-member errors are isolated and never propagated.
  //
  // onComplete(taskId): optional async callback invoked for each newly-completed task.
  // When provided, the callback is responsible for marking the task done (e.g. by calling
  // projectManager.complete()) — which runs recurrence, unblocking, and DM broadcasts.
  // When omitted, _syncMember falls back to a direct DB status update (no side effects).
  async function syncAll({ onComplete } = {}) {
    const members = db.prepare(`
      SELECT id, google_tasks_list_id FROM members
      WHERE google_tasks_list_id IS NOT NULL
    `).all();

    for (const member of members) {
      try {
        await _syncMember(member, onComplete);
      } catch (err) {
        process.stderr.write(`tasksAdapter: sync failed for member ${member.id}: ${err.message}\n`);
      }
    }
  }

  async function _syncMember(member, onComplete) {
    const client = getClient();
    // Look back 48h so we catch any completions made while the server was down.
    const updatedMin = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    let pageToken;
    do {
      const res = await client.tasks.list({
        tasklist: member.google_tasks_list_id,
        showCompleted: true,
        showHidden: true,
        updatedMin,
        maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      });

      for (const gt of (res.data.items ?? [])) {
        if (gt.status !== 'completed') continue;
        // Guard against cross-member contamination: verify the task belongs to this member.
        const local = db.prepare(`
          SELECT id FROM tasks
          WHERE google_task_id = ?
            AND assigned_to = ?
            AND status NOT IN ('done','skipped')
        `).get(gt.id, member.id);
        if (local) {
          if (onComplete) {
            await onComplete(local.id).catch(err =>
              process.stderr.write(`tasksAdapter: onComplete failed for task ${local.id}: ${err.message}\n`)
            );
          } else {
            db.prepare(`
              UPDATE tasks SET status='done', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?
            `).run(local.id);
          }
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  return { push, completeRemote, syncAll };
}

// ── singletons ────────────────────────────────────────────────────────────────

const _adapter = createTasksAdapter();
export const push           = (task, member) => _adapter.push(task, member);
export const completeRemote = (task, member) => _adapter.completeRemote(task, member);
export const syncAll        = () => _adapter.syncAll();
