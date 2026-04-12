// Google Calendar push adapter (push-first, two-way sync later).
// Auth: device flow, tokens persisted to secrets.json (gitignored).
//
// Shared family calendar: set GOOGLE_CALENDAR_ID in environment.
// Per-person calendars can be added later via members.google_calendar_id.
//
// Exported singletons: pushRunEvent, deleteRunEvent, pushTaskEvent,
//   deleteTaskEvent, authenticate.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const SECRETS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../secrets.json',
);

// ── auth helpers ──────────────────────────────────────────────────────────────

function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSecrets(data) {
  const existing = loadSecrets();
  fs.writeFileSync(SECRETS_PATH, JSON.stringify({ ...existing, ...data }, null, 2));
}

// Build an OAuth2 client from secrets.json.
// Throws if client_id / client_secret are missing.
function buildOAuth2Client() {
  const secrets = loadSecrets();
  const clientId = secrets.google_client_id ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = secrets.google_client_secret ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google credentials not found. Set google_client_id and google_client_secret ' +
      'in secrets.json or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars.',
    );
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  const tokens = secrets.google_tokens;
  if (tokens) oauth2.setCredentials(tokens);

  // Auto-persist refreshed tokens.
  oauth2.on('tokens', updated => {
    const current = loadSecrets().google_tokens ?? {};
    saveSecrets({ google_tokens: { ...current, ...updated } });
  });

  return oauth2;
}

// authenticate: device-flow interactive auth. Run once from CLI.
//   node -e "import('./orchestrator/calendarAdapter.mjs').then(m=>m.authenticate())"
//
// Uses the raw OAuth2 device flow endpoints directly — googleapis' OAuth2Client
// does not expose a device-flow helper.
export async function authenticate() {
  const secrets = loadSecrets();
  const clientId     = secrets.google_client_id     ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = secrets.google_client_secret ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Set google_client_id and google_client_secret in secrets.json first.');
  }

  // Step 1 — request device + user codes
  const codeRes = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES.join(' ') }),
  });
  const { device_code, user_code, verification_url, expires_in, interval = 5 } = await codeRes.json();

  process.stdout.write(
    `\nVisit:  ${verification_url}\nCode:   ${user_code}\n` +
    `(expires in ${Math.floor(expires_in / 60)} minutes)\n\nWaiting for approval...\n`,
  );

  // Step 2 — poll until approved or expired
  const deadline = Date.now() + expires_in * 1000;
  let pollMs = interval * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await tokenRes.json();

    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { pollMs += 5000; continue; }
    if (data.error) throw new Error(`Auth failed: ${data.error} — ${data.error_description}`);

    // Success
    saveSecrets({ google_tokens: data });
    process.stdout.write('Authenticated. Tokens saved to secrets.json.\n');
    return;
  }

  throw new Error('Device flow timed out — run authenticate() again.');
}

// ── factory ───────────────────────────────────────────────────────────────────

export function createCalendarAdapter({
  calendarId = process.env.GOOGLE_CALENDAR_ID,
  _oauth2 = null, // injectable for tests
} = {}) {

  function getCalendar() {
    const auth = _oauth2 ?? buildOAuth2Client();
    return google.calendar({ version: 'v3', auth });
  }

  // ── template run events ────────────────────────────────────────────────────

  // pushRunEvent: creates or updates a Calendar event for a template_run.
  // run shape: { id, template_id, scheduled_for, depart_at, google_calendar_event_id,
  //              title (template title), location_name, location_address,
  //              driver_notes, reward }
  // Returns the Google Calendar event id.
  async function pushRunEvent(run) {
    if (!calendarId) throw new Error('GOOGLE_CALENDAR_ID not set');

    const cal = getCalendar();
    const event = buildRunEvent(run);

    if (run.google_calendar_event_id) {
      const res = await cal.events.update({
        calendarId,
        eventId: run.google_calendar_event_id,
        requestBody: event,
      });
      return res.data.id;
    } else {
      const res = await cal.events.insert({ calendarId, requestBody: event });
      return res.data.id;
    }
  }

  // deleteRunEvent: removes a Calendar event for a template_run.
  async function deleteRunEvent(googleEventId) {
    if (!calendarId || !googleEventId) return;
    const cal = getCalendar();
    await cal.events.delete({ calendarId, eventId: googleEventId }).catch(err => {
      // 410 Gone = already deleted; ignore.
      if (err?.code !== 410) throw err;
    });
  }

  // ── task events ────────────────────────────────────────────────────────────

  // pushTaskEvent: creates or updates an all-day Calendar event for a task with a due_date.
  // task shape: { id, title, description, due_date (YYYY-MM-DD), google_calendar_event_id,
  //               assignee_name (optional) }
  // Returns the Google Calendar event id.
  async function pushTaskEvent(task) {
    if (!calendarId) throw new Error('GOOGLE_CALENDAR_ID not set');
    if (!task.due_date) throw new Error(`Task ${task.id} has no due_date`);

    const cal = getCalendar();
    const event = buildTaskEvent(task);

    if (task.google_calendar_event_id) {
      const res = await cal.events.update({
        calendarId,
        eventId: task.google_calendar_event_id,
        requestBody: event,
      });
      return res.data.id;
    } else {
      const res = await cal.events.insert({ calendarId, requestBody: event });
      return res.data.id;
    }
  }

  // deleteTaskEvent: removes a Calendar event for a task.
  async function deleteTaskEvent(googleEventId) {
    if (!calendarId || !googleEventId) return;
    const cal = getCalendar();
    await cal.events.delete({ calendarId, eventId: googleEventId }).catch(err => {
      if (err?.code !== 410) throw err;
    });
  }

  return { pushRunEvent, deleteRunEvent, pushTaskEvent, deleteTaskEvent };
}

// ── event builders ─────────────────────────────────────────────────────────────

// buildRunEvent: converts a template run into a Google Calendar event object.
// If depart_at is present, creates a 1-hour timed event; otherwise all-day.
function buildRunEvent(run) {
  const { scheduled_for, depart_at, title, location_name, location_address,
          driver_notes, reward } = run;

  const descParts = [];
  if (driver_notes) descParts.push(`📝 ${driver_notes}`);
  if (reward) descParts.push(`🎉 ${reward}`);
  if (location_address) {
    const mUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location_address)}`;
    descParts.push(`📍 Directions: ${mUrl}`);
  }
  const description = descParts.join('\n') || undefined;

  if (depart_at) {
    // Timed event: depart_at → depart_at+1h (adjust if needed later)
    const [h, m] = depart_at.split(':').map(Number);
    const endH = String(h + 1).padStart(2, '0');
    const startDateTime = `${scheduled_for}T${depart_at}:00`;
    const endDateTime = `${scheduled_for}T${endH}:${String(m).padStart(2, '0')}:00`;

    return {
      summary: title,
      description,
      location: location_address ?? location_name ?? undefined,
      start: { dateTime: startDateTime, timeZone: process.env.DEFAULT_TIMEZONE ?? 'America/Chicago' },
      end:   { dateTime: endDateTime,   timeZone: process.env.DEFAULT_TIMEZONE ?? 'America/Chicago' },
    };
  }

  // All-day event (no depart_at — e.g. Weekly Reset)
  return {
    summary: title,
    description,
    start: { date: scheduled_for },
    end:   { date: scheduled_for },
  };
}

// buildTaskEvent: converts a task into an all-day Google Calendar event.
function buildTaskEvent(task) {
  const { title, description, due_date, assignee_name } = task;
  const summaryParts = [title];
  if (assignee_name) summaryParts.push(`(${assignee_name})`);

  return {
    summary: summaryParts.join(' '),
    description: description ?? undefined,
    start: { date: due_date },
    end:   { date: due_date },
  };
}

// ── singletons ────────────────────────────────────────────────────────────────

const _adapter = createCalendarAdapter();
export const pushRunEvent    = run => _adapter.pushRunEvent(run);
export const deleteRunEvent  = id  => _adapter.deleteRunEvent(id);
export const pushTaskEvent   = t   => _adapter.pushTaskEvent(t);
export const deleteTaskEvent = id  => _adapter.deleteTaskEvent(id);
