// Approval manager — request, resolve (via Discord reaction), expire stale approvals.
// See: GitHub issues #11, #13

export async function request(task, requestedBy) {
  throw new Error('not implemented');
}

export async function resolve(discordMessageId, emoji) {
  throw new Error('not implemented');
}

export async function expireStale() {
  throw new Error('not implemented');
}
