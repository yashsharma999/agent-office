/**
 * Routines: things the agent does on its own clock.
 *
 * A routine is a prompt plus a "when". It lives on the user record
 * (`prefs.routines`), and each one has an EventBridge Scheduler schedule
 * whose target is the AgentCore runtime itself - the universal target
 * `aws-sdk:bedrockagentcore:invokeAgentRuntime` with a job payload. No
 * Lambda, no queue. Locally, where there is no runtime ARN, a one-minute
 * ticker in the UI server plays the scheduler (see `dueNow`).
 *
 * Three kinds:
 *   schedule  - run the prompt at the time
 *   mail      - every N minutes, look for new matching mail; run only if any
 *   calendar  - every N minutes, look for events starting within `lead`
 *               minutes; run only for ones not handled yet
 *
 * "When" is kept in a small normalised form so both the scheduler and the
 * local ticker read the same thing:
 *   { every: 30 }                              minutes
 *   { daily: '08:00', days: 'all'|'weekdays', tz: 'Europe/London' }
 */
import { readPrefs, writePrefs } from './prefs.js';

const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN || '';
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const GROUP = process.env.SCHEDULE_GROUP || 'default';
const MAX_ROUTINES = 10;
const MIN_EVERY = 15;

export const KINDS = ['schedule', 'mail', 'calendar'];
export const schedulerEnabled = () => Boolean(RUNTIME_ARN && SCHEDULER_ROLE_ARN);

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
export const scheduleName = (userId, id) => `ao-${safe(userId)}-${safe(id)}`.slice(0, 64);

/** Runtime session ids must be at least 33 characters. */
const sessionFor = (id) => `routine-${id}`.padEnd(33, '0');

// ----------------------------------------------------------- validation
function cleanWhen(when) {
  if (!when || typeof when !== 'object') throw new Error('Say when the routine should run.');
  if (when.every != null) {
    const every = Math.max(MIN_EVERY, Math.round(Number(when.every)));
    if (!Number.isFinite(every)) throw new Error('"every" must be a number of minutes.');
    return { every };
  }
  if (when.daily) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(when.daily)) throw new Error('Daily time must be HH:MM.');
    const days = when.days === 'weekdays' ? 'weekdays' : 'all';
    const tz = String(when.tz || 'UTC').slice(0, 64);
    try { Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new Error(`Unknown time zone "${tz}".`); }
    return { daily: when.daily, days, tz };
  }
  throw new Error('"when" needs either every (minutes) or daily (HH:MM).');
}

export function cleanRoutine(r, existing = {}) {
  const kind = KINDS.includes(r?.kind) ? r.kind : 'schedule';
  const name = String(r?.name ?? '').trim().slice(0, 40);
  const prompt = String(r?.prompt ?? '').trim().slice(0, 2000);
  if (!name) throw new Error('Give the routine a name.');
  if (!prompt) throw new Error('Say what the routine should do.');
  const when = cleanWhen(r?.when);
  // Triggers poll: a daily check of the inbox is allowed but odd, so they
  // default to every 30 minutes.
  if (kind !== 'schedule' && !when.every) throw new Error('Mail and calendar routines run every N minutes.');
  return {
    id: existing.id ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind, name, prompt, when,
    query: kind === 'mail' ? String(r?.query ?? '').slice(0, 200) : undefined,
    lead: kind === 'calendar' ? Math.max(5, Math.min(1440, Math.round(Number(r?.lead ?? 60)))) : undefined,
    enabled: r?.enabled !== false,
    createdAt: existing.createdAt ?? new Date().toISOString(),
    lastRunAt: existing.lastRunAt ?? null,
    lastSeen: existing.lastSeen ?? [],
  };
}

// --------------------------------------------------------------- storage
export async function listRoutines(userId) {
  const { prefs } = await readPrefs(userId);
  return Array.isArray(prefs?.routines) ? prefs.routines : [];
}

async function writeAll(userId, routines) {
  const { stored } = await writePrefs(userId, { routines });
  if (!stored) throw new Error('Could not save routines.');
}

export async function saveRoutine(userId, input) {
  const all = await listRoutines(userId);
  const existing = input?.id ? all.find((r) => r.id === input.id) : null;
  if (!existing && all.length >= MAX_ROUTINES) throw new Error(`At most ${MAX_ROUTINES} routines.`);
  const routine = cleanRoutine(input, existing ?? {});
  const next = existing ? all.map((r) => (r.id === routine.id ? routine : r)) : [...all, routine];
  await writeAll(userId, next);
  await syncSchedule(userId, routine).catch((err) => console.warn('routines: schedule sync failed -', err.message));
  return routine;
}

export async function deleteRoutine(userId, id) {
  const all = await listRoutines(userId);
  await writeAll(userId, all.filter((r) => r.id !== id));
  await removeSchedule(userId, id).catch((err) => console.warn('routines: schedule delete failed -', err.message));
}

/** Records a run (or a quiet check) without touching anything else. */
export async function markRun(userId, id, { lastSeen } = {}) {
  const all = await listRoutines(userId);
  const next = all.map((r) => r.id === id
    ? { ...r, lastRunAt: new Date().toISOString(), ...(lastSeen ? { lastSeen: lastSeen.slice(-50) } : {}) }
    : r);
  await writeAll(userId, next);
}

/** Every user who has routines - for the local ticker. */
export async function routineOwners() {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const out = await db.send(new ScanCommand({
    TableName: process.env.PREFS_TABLE || 'my-agent-prefs',
    FilterExpression: 'attribute_exists(routines)',
    ProjectionExpression: 'clientId',
  }));
  return (out.Items ?? []).map((i) => i.clientId);
}

// ------------------------------------------------------------- the clock
/** The EventBridge expression for a "when". */
export function expressionFor(when) {
  if (when.every) return { expression: `rate(${when.every} minutes)`, tz: 'UTC' };
  const [h, m] = when.daily.split(':').map(Number);
  const dow = when.days === 'weekdays' ? 'MON-FRI' : '*';
  return { expression: `cron(${m} ${h} ? * ${dow} *)`, tz: when.tz };
}

/** Words for the routines list. */
export function describeWhen(when) {
  if (when.every) return when.every % 60 === 0 ? `every ${when.every / 60}h` : `every ${when.every} min`;
  return `${when.days === 'weekdays' ? 'weekdays' : 'daily'} at ${when.daily} ${when.tz}`;
}

/** Local ticker: is this routine due, given when it last ran? */
export function dueNow(routine, now = new Date()) {
  if (!routine.enabled) return false;
  const last = routine.lastRunAt ? new Date(routine.lastRunAt).getTime() : 0;
  const w = routine.when;
  if (w.every) return now.getTime() - last >= w.every * 60_000;
  // Daily: due once the local time has passed today's HH:MM and it has not run since then.
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: w.tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
    .formatToParts(now).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  if (w.days === 'weekdays' && ['Sat', 'Sun'].includes(parts.weekday)) return false;
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  const [h, m] = w.daily.split(':').map(Number);
  if (nowMin < h * 60 + m) return false;
  return now.getTime() - last > 20 * 60 * 60_000;
}

// ---------------------------------------------------------- the scheduler
let scheduler = null;
async function client() {
  if (scheduler) return scheduler;
  const { SchedulerClient, CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand } =
    await import('@aws-sdk/client-scheduler');
  scheduler = { c: new SchedulerClient({ region: REGION }), CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand };
  return scheduler;
}

/** The payload the runtime receives when the schedule fires. */
export const jobPayload = (userId, routine) => ({
  job: {
    userId,
    source: routine.kind === 'schedule' ? 'routine' : 'trigger',
    routineId: routine.id,
    routineName: routine.name,
    kind: routine.kind,
    prompt: routine.prompt,
    query: routine.query,
    lead: routine.lead,
  },
});

export async function syncSchedule(userId, routine) {
  if (!schedulerEnabled()) return false;
  const { c, CreateScheduleCommand, UpdateScheduleCommand, GetScheduleCommand } = await client();
  const name = scheduleName(userId, routine.id);
  const { expression, tz } = expressionFor(routine.when);
  const params = {
    Name: name, GroupName: GROUP,
    ScheduleExpression: expression,
    ScheduleExpressionTimezone: tz,
    FlexibleTimeWindow: { Mode: 'OFF' },
    State: routine.enabled ? 'ENABLED' : 'DISABLED',
    Description: `${routine.kind}: ${routine.name}`,
    Target: {
      Arn: 'arn:aws:scheduler:::aws-sdk:bedrockagentcore:invokeAgentRuntime',
      RoleArn: SCHEDULER_ROLE_ARN,
      Input: JSON.stringify({
        AgentRuntimeArn: RUNTIME_ARN,
        RuntimeSessionId: sessionFor(routine.id),
        ContentType: 'application/json',
        Payload: JSON.stringify(jobPayload(userId, routine)),
      }),
      RetryPolicy: { MaximumRetryAttempts: 1, MaximumEventAgeInSeconds: 600 },
    },
  };
  let exists = true;
  try { await c.send(new GetScheduleCommand({ Name: name, GroupName: GROUP })); } catch { exists = false; }
  await c.send(exists ? new UpdateScheduleCommand(params) : new CreateScheduleCommand(params));
  return true;
}

export async function removeSchedule(userId, id) {
  if (!schedulerEnabled()) return false;
  const { c, DeleteScheduleCommand } = await client();
  try { await c.send(new DeleteScheduleCommand({ Name: scheduleName(userId, id), GroupName: GROUP })); } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }
  return true;
}
