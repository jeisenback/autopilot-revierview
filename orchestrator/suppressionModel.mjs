// Suppression model — governs proactive (bot-initiated) messages only.
// canNotify() is read-only. increment() is called by the proactive send path after delivery.
// See: GitHub issue #4

export function canNotify(member, priority, state) {
  throw new Error('not implemented');
}

export function increment(db, memberId) {
  throw new Error('not implemented');
}
