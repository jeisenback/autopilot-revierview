// Command router — dispatches parsed intents to the correct handler module.
// See: GitHub issue #8

import * as projectManager_singleton from './projectManager.mjs';

const ADMIN_ONLY = new Set(['add_project', 'assign_task']);

// createRouter: factory for dependency injection in tests.
export function createRouter({ projectManager = projectManager_singleton } = {}) {

  async function dispatch(intent, member, body) {
    const { command, args = {} } = intent;

    // Role guard: kids cannot run admin-only commands
    if (member.role === 'kid' && ADMIN_ONLY.has(command)) {
      return "Ask a parent to do that.";
    }

    switch (command) {
      case 'add_project':
        return projectManager.create(args.title, member);

      case 'list_projects':
        return projectManager.listOpen();

      case 'complete_task':
        return projectManager.complete(args.taskId, member);

      case 'assign_task':
        return projectManager.assign(args.taskId, args.mention);

      case 'ask':
        return args.question ? `You asked: ${args.question}` : "What's your question?";

      case 'snooze': {
        const hours = Number(args.hours) || 1;
        return `Snoozed for ${hours} hour${hours === 1 ? '' : 's'}.`;
      }

      default:
        return "I didn't understand that command. Try /project list or /task done <id>.";
    }
  }

  return { dispatch };
}

// Singleton for production use
const router = createRouter();
export async function dispatch(intent, member, body) {
  return router.dispatch(intent, member, body);
}
