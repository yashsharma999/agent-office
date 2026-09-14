/**
 * Metering.
 *
 * The SDK counts every token an agent spends (`agent.metrics`). After each
 * turn the team's spend since the last reading is added to one counter per
 * user per day. That counter is the ENERGY bar in the room, and it is what
 * stops a runaway routine from spending all night.
 *
 *   usage:<userId>:<YYYY-MM-DD>  -> { inputTokens, outputTokens, turns, toolCalls }
 *
 * The budget is tokens, not dollars: it is the one unit every model reports
 * the same way. DAILY_TOKEN_BUDGET sets it; the default is roomy for a person
 * and tight for a bug.
 */
import { addCounters, readPrefs } from './prefs.js';

export const DAILY_BUDGET = Number(process.env.DAILY_TOKEN_BUDGET || 2_000_000);

export class OutOfEnergy extends Error {
  constructor(used, budget) {
    super(`Your agents are out of energy for today (${fmt(used)} of ${fmt(budget)} tokens used). They recharge at midnight UTC.`);
    this.name = 'OutOfEnergy';
    this.used = used;
    this.budget = budget;
  }
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const today = () => new Date().toISOString().slice(0, 10);
const keyFor = (userId, day = today()) => `usage:${userId}:${day}`;

/** Where the day stands for one user. */
export async function readUsage(userId) {
  const { prefs } = await readPrefs(keyFor(userId));
  const inputTokens = prefs?.inputTokens ?? 0;
  const outputTokens = prefs?.outputTokens ?? 0;
  const used = inputTokens + outputTokens;
  return {
    day: today(),
    inputTokens, outputTokens, used,
    turns: prefs?.turns ?? 0,
    toolCalls: prefs?.toolCalls ?? 0,
    budget: DAILY_BUDGET,
    remaining: Math.max(0, DAILY_BUDGET - used),
    ratio: Math.max(0, Math.min(1, 1 - used / DAILY_BUDGET)),
  };
}

/** Throws OutOfEnergy once the day's budget is gone. Call before a turn. */
export async function assertBudget(userId) {
  const u = await readUsage(userId);
  if (u.used >= u.budget) throw new OutOfEnergy(u.used, u.budget);
  return u;
}

/** Adds one turn's spend. Counters are atomic, so concurrent turns add up right. */
export async function recordUsage(userId, { inputTokens = 0, outputTokens = 0, toolCalls = 0, turns = 1 } = {}) {
  if (!userId) return;
  if (!inputTokens && !outputTokens && !toolCalls) return;
  await addCounters(keyFor(userId), { inputTokens, outputTokens, toolCalls, turns })
    .catch((err) => console.warn('usage: could not record -', err.message));
}

/**
 * Reads what a set of agents have spent since the last reading. Metrics on an
 * agent accumulate for its whole life, so the previous total is remembered
 * per agent and only the difference is reported.
 */
export function makeMeter() {
  const seen = new WeakMap();
  return function measure(agents) {
    let inputTokens = 0, outputTokens = 0, toolCalls = 0;
    for (const agent of agents) {
      const m = agent?.metrics;
      if (!m) continue;
      const calls = Object.values(m.toolMetrics ?? {}).reduce((n, t) => n + (t.callCount ?? 0), 0);
      const now = {
        i: m.accumulatedUsage?.inputTokens ?? 0,
        o: m.accumulatedUsage?.outputTokens ?? 0,
        c: calls,
      };
      const prev = seen.get(agent) ?? { i: 0, o: 0, c: 0 };
      inputTokens += Math.max(0, now.i - prev.i);
      outputTokens += Math.max(0, now.o - prev.o);
      toolCalls += Math.max(0, now.c - prev.c);
      seen.set(agent, now);
    }
    return { inputTokens, outputTokens, toolCalls };
  };
}
