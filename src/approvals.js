/**
 * Approval gates for unattended runs.
 *
 * When a person is in the chat, the agent asks them in words and they answer
 * in words. When nobody is - a routine, a trigger, a detached job - a tool
 * that changes the user's world stops the run instead, with the SDK's
 * interrupt machinery: the agent's state is snapshotted with the question
 * in it, the outbox carries the question to the user, and their /approve or
 * /deny resumes the very same tool call.
 *
 * Attended runs pass straight through: `approveFirst` is a no-op unless
 * `unattended` is set.
 */

/**
 * Pauses for approval, or returns at once when the run is attended.
 * @throws when the user declined, so the tool reports it like any other failure
 */
export function approveFirst(ctx, unattended, { tool, summary, input }) {
  if (!unattended || !ctx?.interrupt) return;
  const answer = ctx.interrupt({ name: 'approve', reason: { tool, summary, input } });
  if (answer !== 'approved') {
    throw new Error(`The user declined: ${summary}. Do not retry it; report that it was not done.`);
  }
}

/** Reads the pending questions off an interrupted result, for the outbox. */
export const pendingApprovals = (result) =>
  (result?.interrupts ?? []).map((i) => ({
    id: i.id,
    tool: i.reason?.tool ?? i.name,
    summary: i.reason?.summary ?? i.name,
    input: i.reason?.input ?? null,
  }));
