/**
 * Runs jobs: unattended turns of the boss agent, start to delivery.
 *
 * Used by the AgentCore runtime (a job arrives in the payload and runs
 * detached while the HTTP call has already been answered) and by the UI
 * server in local mode (where the same function is simply called in the
 * background). One code path, so a routine behaves identically wherever the
 * agent happens to live.
 *
 * Lifecycle of a job record:
 *   running -> done            result delivered to the outbox
 *   running -> needs_approval  a tool paused; the outbox carries the question
 *   needs_approval -> running  /approve or /deny resumed it
 *   running -> failed
 * A trigger whose check finds nothing new creates no job at all.
 */
import { InterruptResponseContent } from '@strands-agents/sdk';
import { createTeam } from './team.js';
import { agentEvents } from './stream-events.js';
import { createJob, updateJob, getJob } from './jobs.js';
import { deliver } from './outbox.js';
import { checkTrigger } from './triggers.js';
import { listRoutines, markRun } from './routines.js';
import { assertBudget, recordUsage } from './usage.js';

let inFlight = 0;
/** For /ping: the container must not be reclaimed while a job is running. */
export const busy = () => inFlight > 0;

/**
 * @param {object} spec  the `job` payload (see routines.jobPayload)
 * @returns {Promise<object|null>} the job record, or null when a trigger was quiet
 */
export async function runJob(spec, { preset } = {}) {
  const { userId, prompt, source = 'manual', routineId, routineName, kind = 'schedule', jobId } = spec;
  if (!userId || !prompt) throw new Error('A job needs a userId and a prompt.');
  inFlight++;
  try {
    let context = '';
    if (routineId && kind !== 'schedule') {
      const stored = (await listRoutines(userId)).find((r) => r.id === routineId);
      const routine = { id: routineId, kind, query: spec.query, lead: spec.lead, lastSeen: stored?.lastSeen ?? [] };
      let check;
      try {
        check = await checkTrigger(userId, routine);
      } catch (err) {
        // A trigger that cannot look (account not linked, API down) must be
        // visible, not silent: file it as a failed job.
        const job = await createJob({ userId, prompt, source, routineId, routineName, jobId });
        await updateJob(userId, job.jobId, { status: 'failed', error: `Could not check: ${err.message}` });
        await deliver(userId, { text: `"${routineName ?? 'routine'}" could not check: ${err.message}` }).catch(() => {});
        return job;
      }
      await markRun(userId, routineId, { lastSeen: check.seen });
      if (!check.fire) { console.log(`job: trigger ${routineName ?? routineId} found nothing new`); return null; }
      context = check.context;
    } else if (routineId) {
      await markRun(userId, routineId);
    }

    const job = await createJob({ userId, prompt, source, routineId, routineName, jobId });
    console.log(`job: ${job.jobId} start (${source}) for ${userId}`);
    await settle(job, preset, context ? `${prompt}\n\n${context}` : prompt);
    return job;
  } finally {
    inFlight--;
  }
}

/** Answers a job's pending approvals and lets it carry on. */
export async function resumeJob({ userId, jobId, approved }, { preset } = {}) {
  const job = await getJob(userId, jobId);
  if (!job) throw new Error('No such job.');
  if (job.status !== 'needs_approval') throw new Error(`That job is ${job.status}; there is nothing to approve.`);
  const response = approved ? 'approved' : 'denied';
  await updateJob(userId, jobId, { status: 'running', decision: response });
  const blocks = (job.approvals ?? []).map((a) => new InterruptResponseContent({ interruptId: a.id, response }));
  inFlight++;
  try {
    await settle(job, preset, blocks);
  } finally {
    inFlight--;
  }
  return getJob(userId, jobId);
}

/** One unattended pass of the boss over `input`, then the bookkeeping. */
async function settle(job, preset, input) {
  const { userId, jobId } = job;
  let team = null;
  try {
    await assertBudget(userId);
    team = await createTeam({ userId, sessionId: jobId, unattended: true, preset });
    if (!team.boss) throw new Error('No agent exists yet. Build one first.');

    let text = '';
    let stop = null;
    const artifacts = [];
    for await (const ev of agentEvents(team.boss, input, {
      workspaces: team.workspaces, webs: team.webs, sessionId: jobId, userId,
      agentNames: team.agentToolNames, main: team.roster[0].toolName,
    })) {
      if (ev.type === 'text') text += ev.value;
      else if (ev.type === 'artifact') artifacts.push(ev);
      else if (ev.type === 'stop') stop = ev;
      else if (ev.type === 'error') throw new Error(ev.message);
    }
    await recordUsage(userId, team.measure());

    const result = [job.result, text.trim()].filter(Boolean).join('\n\n');
    const boss = team.roster[0].name;

    if (stop?.reason === 'interrupt' && stop.approvals?.length) {
      await updateJob(userId, jobId, { status: 'needs_approval', approvals: stop.approvals, result });
      const asks = stop.approvals.map((a) => `- ${a.summary}`).join('\n');
      const to = await deliver(userId, {
        text: `${boss} needs your go-ahead on "${job.title}":\n${asks}\n\nReply /approve ${jobId} or /deny ${jobId}`,
      });
      await updateJob(userId, jobId, { deliveredTo: to });
      console.log(`job: ${jobId} waiting for approval (${to})`);
      return;
    }

    const files = artifacts.map((a) => ({ name: a.name, size: a.size, mimeType: a.mimeType, url: a.url }));
    await updateJob(userId, jobId, { status: 'done', result, artifacts: files, stopReason: stop?.reason ?? 'endTurn' });
    const to = await deliver(userId, {
      text: `${boss} finished "${job.title}":\n\n${result || '(no answer)'}`,
      artifacts,
    });
    await updateJob(userId, jobId, { deliveredTo: to });
    console.log(`job: ${jobId} done (${to})`);
  } catch (err) {
    console.error(`job: ${jobId} failed -`, err.message);
    await updateJob(userId, jobId, { status: 'failed', error: err.message }).catch(() => {});
    await deliver(userId, { text: `"${job.title}" did not finish: ${err.message}` }).catch(() => {});
  } finally {
    await team?.close?.().catch(() => {});
  }
}
