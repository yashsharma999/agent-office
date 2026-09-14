#!/usr/bin/env node
/**
 * Scripted evals.
 *
 * Twenty short conversations against the mock inbox and mock calendar, each
 * with a few assertions: which tools ran, what the answer said, how many
 * model turns it took. Cheap (Haiku rigs), deterministic enough to run on
 * every push, and the first thing to reach for when a prompt change makes
 * the agents worse.
 *
 *   npm run eval                 the whole suite
 *   npm run eval -- --only <id>  one case
 *   npm run eval -- --json       machine-readable output
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Mocks, whatever .env says: the suite must never touch a real account, and
// `connectors.js` decides at import time, so this comes before any src import.
process.env.GMAIL_PROVIDER_NAME = '';
process.env.GOOGLE_PROVIDER_NAME = '';

const { createTeam } = await import('../src/team.js');
const { agentEvents } = await import('../src/stream-events.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(join(__dirname, 'cases.json'), 'utf8'));

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const asJson = args.includes('--json');
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 2);
/** A throttled case is rerun after a pause; it says nothing about the agent. */
const THROTTLE_ATTEMPTS = Number(process.env.EVAL_THROTTLE_ATTEMPTS || 3);
const isThrottle = (r) =>
  r.failures.some((f) => /too many requests|throttl/i.test(f))
  || /too many requests|throttl|rate.?limit|overloaded/i.test(r.text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS || 120_000);

const tin = (name, instructions, grants = []) => ({
  name, toolName: name.toLowerCase(), instructions, rig: 'tin', colour: 'teal', grants,
});

const ROSTERS = {
  solo: () => [tin('Atlas', 'You are a concise personal assistant. Use your tools rather than guessing.', ['gmail', 'calendar'])],
  nopass: () => [tin('Atlas', 'You are a concise personal assistant. Use your tools rather than guessing.')],
  scheduler: () => [tin('Booker',
    'You are a personal scheduler. Keep the calendar sane and the inbox answered. '
    + 'Draft, never send. Book only what the user asked for, and confirm what you booked.',
    ['gmail', 'calendar'])],
  pair: () => [
    tin('Boss', 'You coordinate colleagues. Delegate factual questions to them and relay their answers.'),
    tin('Scout', 'You answer geography questions in one line.'),
  ],
  trio: () => [
    tin('Boss', 'You coordinate colleagues. Delegate to them and relay their answers in full.'),
    tin('Scout', 'You answer geography questions in one line.'),
    tin('Quill', 'You write one-line poems about a given city.'),
  ],
};

async function runCaseOnce(c) {
  const started = Date.now();
  const team = await createTeam({ preset: 'dev', userId: 'eval', roster: ROSTERS[c.roster ?? 'solo']() });
  const tools = [];
  let text = '';
  let turns = 0;
  let error = null;

  const work = (async () => {
    for await (const ev of agentEvents(team.boss, c.prompt, { agentNames: team.agentToolNames, main: team.roster[0].toolName })) {
      if (ev.type === 'tool' && ev.phase === 'start') tools.push(ev.name);
      if (ev.type === 'agent' && ev.phase === 'start') tools.push(ev.name);
      if (ev.type === 'status' && ev.value === 'thinking' && ev.who === team.roster[0].toolName) turns++;
      if (ev.type === 'text') text += ev.value;
      if (ev.type === 'error') error = ev.message;
    }
  })();
  let timedOut = false;
  await Promise.race([work, new Promise((r) => setTimeout(() => { timedOut = true; r(); }, TIMEOUT_MS))]);
  await team.close().catch(() => {});

  // The first 'thinking' is the pre-flight status, not a model call.
  turns = Math.max(0, turns - 1);
  const failures = [];
  if (timedOut) failures.push(`timed out after ${TIMEOUT_MS / 1000}s`);
  if (error) failures.push(`error: ${error}`);
  for (const t of c.expectTools ?? []) if (!tools.includes(t)) failures.push(`expected tool ${t}`);
  for (const t of c.forbidTools ?? []) if (tools.includes(t)) failures.push(`forbidden tool ${t} ran`);
  if (c.expectText && !new RegExp(c.expectText, 'i').test(text)) failures.push(`text !~ /${c.expectText}/`);
  if (c.forbidText && new RegExp(c.forbidText, 'i').test(text)) failures.push(`text ~ /${c.forbidText}/ (forbidden)`);
  if (c.maxTurns && turns > c.maxTurns) failures.push(`${turns} turns > ${c.maxTurns}`);

  return { id: c.id, pass: failures.length === 0, failures, tools, turns, ms: Date.now() - started, text: text.trim() };
}

async function runCase(c) {
  let r = await runCaseOnce(c);
  for (let attempt = 2; attempt <= THROTTLE_ATTEMPTS && !r.pass && isThrottle(r); attempt++) {
    await sleep(15_000 * (attempt - 1));
    r = await runCaseOnce(c);
    r.retried = attempt;
  }
  return r;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const selected = only ? CASES.filter((c) => c.id === only) : CASES;
if (!selected.length) { console.error(`no case called "${only}"`); process.exit(2); }

const results = await pool(selected, CONCURRENCY, (c) => runCase(c).catch((err) => ({
  id: c.id, pass: false, failures: [`crashed: ${err.message}`], tools: [], turns: 0, ms: 0, text: '',
})));

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const w = Math.max(...results.map((r) => r.id.length));
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${r.id.padEnd(w)}  ${String(r.ms).padStart(6)}ms  turns=${r.turns}  tools=${r.tools.join(',') || '-'}${r.retried ? `  (attempt ${r.retried})` : ''}`);
    if (!r.pass) {
      for (const f of r.failures) console.log(`        - ${f}`);
      console.log(`        answer: ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
