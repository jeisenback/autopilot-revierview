// Space CRUD and ready-state transitions.
// See: GitHub issue #37

import db_singleton from '../db/db.mjs';

export function createSpaceManager({ db = db_singleton } = {}) {

  // ─── Queries ───────────────────────────────────────────────────────────────

  const selectAll = db.prepare(`
    SELECT s.*, m.name AS assigned_to_name
    FROM spaces s
    LEFT JOIN members m ON m.id = s.assigned_to
    ORDER BY s.name
  `);

  const selectById = db.prepare(`
    SELECT s.*, m.name AS assigned_to_name
    FROM spaces s
    LEFT JOIN members m ON m.id = s.assigned_to
    WHERE s.id = ?
  `);

  const updateIsReady = db.prepare(`
    UPDATE spaces SET is_ready = ? WHERE id = ?
  `);

  const selectItems = db.prepare(`
    SELECT * FROM space_items WHERE space_id = ? ORDER BY id
  `);

  const selectNotReady = db.prepare(`
    SELECT s.*, m.name AS assigned_to_name
    FROM spaces s
    LEFT JOIN members m ON m.id = s.assigned_to
    WHERE s.is_ready = 0
    ORDER BY s.name
  `);

  const insertTask = db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, assigned_to, created_from)
    VALUES (@project_id, @title, @description, 'todo', @assigned_to, 'manual')
  `);

  const findOrCreateTidyProject = (() => {
    const find = db.prepare(`SELECT id FROM projects WHERE title = 'Household tidying' LIMIT 1`);
    const insert = db.prepare(`INSERT INTO projects (title, status) VALUES ('Household tidying', 'active')`);
    return () => {
      const row = find.get();
      if (row) return row.id;
      return insert.run().lastInsertRowid;
    };
  })();

  // ─── getAll ────────────────────────────────────────────────────────────────
  // Returns all spaces with their current ready state.

  function getAll() {
    return selectAll.all();
  }

  // ─── getById ───────────────────────────────────────────────────────────────

  function getById(spaceId) {
    return selectById.get(spaceId) ?? null;
  }

  // ─── setReady ──────────────────────────────────────────────────────────────
  // Set is_ready on a space. If setting to not-ready (isReady=false) and the
  // space has an assigned_to member, optionally auto-creates a 'tidy' task.
  //
  // Returns { space, taskCreated } where taskCreated is the new task row or null.

  function setReady(spaceId, isReady, { createTask = false } = {}) {
    const space = selectById.get(spaceId);
    if (!space) throw new Error(`spaceManager.setReady: space ${spaceId} not found`);

    updateIsReady.run(isReady ? 1 : 0, spaceId);

    let taskCreated = null;
    if (!isReady && createTask && space.assigned_to) {
      const projectId = findOrCreateTidyProject();
      const result = insertTask.run({
        project_id: projectId,
        title: `Tidy ${space.name}`,
        description: `Ready state: ${space.ready_state}`,
        assigned_to: space.assigned_to,
      });
      taskCreated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    }

    const updated = selectById.get(spaceId);
    return { space: updated, taskCreated };
  }

  // ─── getNotReady ──────────────────────────────────────────────────────────
  // Returns all spaces where is_ready = 0. Used by briefingEngine.

  function getNotReady() {
    return selectNotReady.all();
  }

  // ─── getBlockingSpaces ────────────────────────────────────────────────────
  // Placeholder: returns spaces that must be ready before a process template
  // run can be marked done. Template-to-space associations are future work;
  // for now returns all not-ready spaces as conservative blockers.

  function getBlockingSpaces(_processTemplateId) {
    return getNotReady();
  }

  // ─── getItems ────────────────────────────────────────────────────────────

  function getItems(spaceId) {
    return selectItems.all(spaceId);
  }

  // ─── formatList ───────────────────────────────────────────────────────────
  // Returns a plain-text Discord-ready list of all spaces and their status.

  function formatList() {
    const spaces = getAll();
    if (spaces.length === 0) return 'No spaces defined yet.';
    const lines = spaces.map(s => {
      const icon = s.is_ready ? '✅' : '🔴';
      const owner = s.assigned_to_name ? ` (${s.assigned_to_name})` : '';
      return `${icon} **${s.name}**${owner} — ${s.ready_state}`;
    });
    return lines.join('\n');
  }

  return { getAll, getById, setReady, getNotReady, getBlockingSpaces, getItems, formatList };
}
