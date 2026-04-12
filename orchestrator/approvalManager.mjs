// Approval manager — request, resolve (via Discord reaction), expire stale approvals.
// See: GitHub issues #11, #13

import db_singleton from '../db/db.mjs';

const APPROVAL_TTL_HOURS = Number(process.env.APPROVAL_TTL_HOURS || 24);

async function defaultPostMessage(channelId, text) {
  const url = process.env.RESPONSE_SERVER_URL;
  if (!url) { process.stderr.write(`approvalManager: no RESPONSE_SERVER_URL, skip post\n`); return { message_id: null }; }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, content: text }),
  });
  return res.json();
}

async function defaultEditMessage(channelId, messageId, text) {
  const url = process.env.RESPONSE_SERVER_URL;
  if (!url) { process.stderr.write(`approvalManager: no RESPONSE_SERVER_URL, skip edit\n`); return; }
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, messageId, content: text }),
  });
}

// createApprovalManager: factory for dependency injection in tests.
export function createApprovalManager({
  db = db_singleton,
  postMessage = defaultPostMessage,
  editMessage = defaultEditMessage,
} = {}) {

  async function expireStale() {
    const stale = db.prepare(`
      SELECT a.*, t.id as task_id
      FROM approvals a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'pending' AND a.expires_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).all();

    for (const approval of stale) {
      db.transaction(() => {
        db.prepare(`UPDATE approvals SET status='expired' WHERE id=?`).run(approval.id);
        db.prepare(`UPDATE tasks SET status='skipped', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(approval.task_id);
      })();

      try {
        await editMessage(
          approval.discord_channel_id,
          approval.discord_message_id,
          'Approval expired — task skipped. Re-add with /project add.'
        );
      } catch (err) {
        process.stderr.write(`approvalManager: editMessage failed: ${err.message}\n`);
      }
    }
  }

  async function request(task, requestedBy) {
    const cost = task.estimated_cost != null ? `$${task.estimated_cost}` : 'no estimate';
    const text = `Approve task: '${task.title}' (~${cost})? React 👍 to approve, 👎 to deny. Expires in ${APPROVAL_TTL_HOURS}h.`;
    const channelId = requestedBy.discord_dm_channel_id;

    const result = await postMessage(channelId, text);
    const messageId = result?.message_id;

    const expiresAt = new Date(Date.now() + APPROVAL_TTL_HOURS * 3600 * 1000).toISOString();
    db.prepare(`
      INSERT INTO approvals (task_id, requested_by, discord_message_id, discord_channel_id, status, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(task.id, requestedBy.id, messageId, channelId, expiresAt);
  }

  async function resolve(discordMessageId, emoji) {
    const approval = db.prepare(
      `SELECT * FROM approvals WHERE discord_message_id=? AND status='pending'`
    ).get(discordMessageId);

    if (!approval) {
      process.stderr.write(`approvalManager: no pending approval for message ${discordMessageId}\n`);
      return;
    }

    const approved = emoji === '👍';
    const approvalStatus = approved ? 'approved' : 'denied';
    const taskStatus = approved ? 'todo' : 'skipped';

    db.transaction(() => {
      db.prepare(`UPDATE approvals SET status=? WHERE id=?`).run(approvalStatus, approval.id);
      db.prepare(`UPDATE tasks SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(taskStatus, approval.task_id);
    })();

    const editText = approved
      ? `Task '${approval.task_id}' approved. Good to go!`
      : `Task denied — skipped.`;

    try {
      await editMessage(approval.discord_channel_id, discordMessageId, editText);
    } catch (err) {
      process.stderr.write(`approvalManager: editMessage failed: ${err.message}\n`);
    }
  }

  function countPending() {
    return db.prepare(`SELECT COUNT(*) as cnt FROM approvals WHERE status='pending'`).get().cnt;
  }

  function listPending() {
    const rows = db.prepare(`
      SELECT a.id, a.expires_at, t.title, t.estimated_cost
      FROM approvals a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'pending'
      ORDER BY a.expires_at ASC
    `).all();

    if (rows.length === 0) return 'No pending approvals.';

    const now = Date.now();
    return rows.map((r, i) => {
      const minsLeft = Math.max(0, Math.round((new Date(r.expires_at).getTime() - now) / 60000));
      const cost = r.estimated_cost != null ? ` (~$${r.estimated_cost})` : '';
      return `${i + 1}. ${r.title}${cost} — expires in ${minsLeft}m`;
    }).join('\n');
  }

  return { expireStale, request, resolve, listPending, countPending };
}

// ─── singleton for production use ────────────────────────────────────────────

const manager = createApprovalManager();
export async function expireStale() { return manager.expireStale(); }
export async function request(task, requestedBy) { return manager.request(task, requestedBy); }
export async function resolve(discordMessageId, emoji) { return manager.resolve(discordMessageId, emoji); }
export function listPending() { return manager.listPending(); }
export function countPending() { return manager.countPending(); }
