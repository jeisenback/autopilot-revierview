// Command router — dispatches parsed intents to the correct handler module.
// See: GitHub issues #8, #13, #15, #34, #38

import { resolve as resolveApproval, listPending as amListPending, countPending as amCountPending } from './approvalManager.mjs';
import { assign as pmAssign, create as pmCreate, complete as pmComplete, listOpen as pmListOpen, statusSummary as pmStatus } from './projectManager.mjs';
import { snooze as smSnooze } from './suppressionModel.mjs';
import { formatWithClaude } from './responseFormatter.mjs';
import { buildDigest } from './briefingEngine.mjs';
import { createSpaceManager } from './spaceManager.mjs';

const ADMIN_ONLY = new Set(['add_project', 'assign_task', 'list_approvals']);

let _defaultSpaceManager = null;
function getDefaultSpaceManager() {
  if (!_defaultSpaceManager) _defaultSpaceManager = createSpaceManager();
  return _defaultSpaceManager;
}

export function createRouter({
  approvalManager = { resolve: resolveApproval, listPending: amListPending, countPending: amCountPending },
  projectManager = { assign: pmAssign, create: pmCreate, complete: pmComplete, listOpen: pmListOpen, statusSummary: pmStatus },
  suppressionModel = { snooze: smSnooze },
  responseFormatter = { formatWithClaude },
  briefingEngine = { buildDigest },
  spaceManager = null,
} = {}) {
  // spaceManager is resolved lazily on first space command to avoid DB access at import time
  let _sm = spaceManager;
  function sm() { if (!_sm) _sm = getDefaultSpaceManager(); return _sm; }

  async function dispatch(intent, member, body) {
    // Reaction events bypass normal intent routing
    if (body?.event_type === 'reaction') {
      return approvalManager.resolve(body.discord_message_id, body.emoji);
    }

    if (ADMIN_ONLY.has(intent.command) && member?.role === 'kid') {
      return 'Ask a parent to do that.';
    }

    if (intent.command === 'add_project') {
      return projectManager.create(intent.args?.title, member);
    }

    if (intent.command === 'list_projects') {
      return projectManager.listOpen();
    }

    if (intent.command === 'complete_task') {
      return projectManager.complete(intent.args?.taskId, member);
    }

    if (intent.command === 'assign_task') {
      await projectManager.assign(intent.args?.taskId, intent.args?.mention?.replace(/[<@!>]/g, ''));
      return `Task assigned.`;
    }

    if (intent.command === 'snooze') {
      suppressionModel.snooze(member.id, intent.args?.hours ?? 1);
      const until = new Date(Date.now() + (intent.args?.hours ?? 1) * 3600 * 1000)
        .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: member.timezone || 'UTC' });
      return `Snoozed until ${until}. You can still issue commands and get immediate responses.`;
    }

    if (intent.command === 'list_approvals') {
      return approvalManager.listPending();
    }

    if (intent.command === 'status') {
      // Per-person digest when member is known; fall back to global summary otherwise.
      if (member?.id) {
        const today = new Date().toISOString().split('T')[0];
        const digest = briefingEngine.buildDigest(member.id, today);
        return digest.formatted;
      }
      const pendingCount = approvalManager.countPending();
      return projectManager.statusSummary(pendingCount);
    }

    if (intent.command === 'space_list') {
      return sm().formatList();
    }

    if (intent.command === 'space_set_ready' || intent.command === 'space_set_not_ready') {
      const isReady = intent.command === 'space_set_ready';
      const nameArg = (intent.args?.name ?? '').trim().toLowerCase();
      if (!nameArg) return 'Usage: /space set-ready <name>';

      const spaces = sm().getAll();
      const match = spaces.find(s => s.name.toLowerCase() === nameArg)
        ?? spaces.find(s => s.name.toLowerCase().includes(nameArg));
      if (!match) return `Space not found: "${intent.args?.name}". Try /space list.`;

      const { space, taskCreated } = sm().setReady(match.id, isReady, { createTask: !isReady });
      const icon = space.is_ready ? '✅' : '🔴';
      let reply = `${icon} **${space.name}** marked ${isReady ? 'ready' : 'not ready'}.`;
      if (taskCreated) reply += `\nTidy task open: "${taskCreated.title}"${space.assigned_to_name ? ` (${space.assigned_to_name})` : ''}.`;
      return reply;
    }

    if (intent.command === 'ask' || intent.intent === 'question') {
      const question = intent.args?.question ?? body?.content ?? '';
      return responseFormatter.formatWithClaude(question, null, member);
    }

    // Unknown/natural language
    return responseFormatter.formatWithClaude(body?.content ?? '', null, member);
  }

  return { dispatch };
}

// singleton (lazy — avoids DB connection at import time)
let _router = null;
export async function dispatch(intent, member, body) {
  if (!_router) _router = createRouter();
  return _router.dispatch(intent, member, body);
}
