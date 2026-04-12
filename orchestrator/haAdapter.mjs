// Home Assistant adapter — REST poll for entity states, inbound event handler.
// See: GitHub issues #10, #12

const HA_BASE_URL = process.env.HA_BASE_URL || 'http://homeassistant.local:8123';
const HA_ACCESS_TOKEN = process.env.HA_ACCESS_TOKEN || '';
const DEFAULT_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 10000;

// createHaAdapter: factory for dependency injection in tests.
export function createHaAdapter({
  fetch: fetchFn = fetch,
  baseUrl = HA_BASE_URL,
  token = HA_ACCESS_TOKEN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {

  // getStates: returns array of matching entity state objects.
  // Returns [] on any error (network, auth, timeout) — never throws.
  async function getStates(entityIds) {
    if (!entityIds || entityIds.length === 0) return [];

    try {
      const res = await fetchFn(`${baseUrl}/api/states`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        process.stderr.write(`haAdapter: HA returned ${res.status}\n`);
        return [];
      }

      const all = await res.json();
      const ids = new Set(entityIds);
      return all.filter(e => ids.has(e.entity_id));
    } catch (err) {
      process.stderr.write(`haAdapter: getStates failed: ${err.message}\n`);
      return [];
    }
  }

  async function handleEvent(payload) {
    // Implemented in issue #12
    throw new Error('not implemented');
  }

  return { getStates, handleEvent };
}

// ─── auth helper ─────────────────────────────────────────────────────────────

// checkHaAuth: pure, no DB. Returns { status } where:
//   503 = secret not configured, 401 = wrong/missing header, 200 = ok
export function checkHaAuth(secret, authHeader) {
  if (!secret) return { status: 503 };
  if (authHeader !== `Bearer ${secret}`) return { status: 401 };
  return { status: 200 };
}

// ─── inbound event handler ────────────────────────────────────────────────────

export function createHaEventHandler({ db }) {
  function getOrCreateHaProject() {
    let project = db.prepare(`SELECT id FROM projects WHERE title='Home Assistant' LIMIT 1`).get();
    if (!project) {
      const { lastInsertRowid } = db.prepare(
        `INSERT INTO projects (title, status) VALUES ('Home Assistant', 'active')`
      ).run();
      project = { id: lastInsertRowid };
    }
    return project.id;
  }

  return async function handler({ entity_id, state }) {
    const { lastInsertRowid: eventId } = db.prepare(
      `INSERT INTO events (source, event_type, payload, processed) VALUES ('ha', 'state_change', ?, 0)`
    ).run(JSON.stringify({ entity_id, state }));

    try {
      if (entity_id.includes('water_leak') && state === 'wet') {
        const projectId = getOrCreateHaProject();
        const { lastInsertRowid: taskId } = db.prepare(
          `INSERT INTO tasks (project_id, title, priority, status, created_from)
           VALUES (?, ?, 1, 'todo', 'ha_event')`
        ).run(projectId, `Water leak detected: ${entity_id}`);
        db.prepare(`UPDATE events SET processed=1, task_created_id=? WHERE id=?`).run(taskId, eventId);
        return;
      }

      if (entity_id.includes('battery') && state === 'low') {
        const projectId = getOrCreateHaProject();
        const adult = db.prepare(`SELECT id FROM members WHERE role='adult' LIMIT 1`).get();
        const { lastInsertRowid: taskId } = db.prepare(
          `INSERT INTO tasks (project_id, title, priority, status, assigned_to, created_from)
           VALUES (?, ?, 2, 'todo', ?, 'ha_event')`
        ).run(projectId, `Battery low: ${entity_id}`, adult ? adult.id : null);
        db.prepare(`UPDATE events SET processed=1, task_created_id=? WHERE id=?`).run(taskId, eventId);
        return;
      }

      // No rule matched — skip
      db.prepare(`UPDATE events SET processed=2 WHERE id=?`).run(eventId);
    } catch (err) {
      process.stderr.write(`haEventHandler: ${err.message}\n`);
      db.prepare(`UPDATE events SET processed=2 WHERE id=?`).run(eventId);
    }
  };
}

// ─── singletons for production use ───────────────────────────────────────────

const adapter = createHaAdapter();
export async function getStates(entityIds) { return adapter.getStates(entityIds); }
export async function handleEvent(payload) { return adapter.handleEvent(payload); }
