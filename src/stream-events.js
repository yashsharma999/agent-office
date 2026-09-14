/**
 * The event protocol shared by every layer.
 *
 * The raw SDK stream is reduced to a handful of small JSON events:
 *   {type:'status',  value:'thinking'|'tool'|'done', who}
 *   {type:'agent',   name, phase:'start'|'end'}      a specialist woke up / finished
 *   {type:'thought', who, value}                     model reasoning, for the thought cloud
 *   {type:'tool',    phase:'start'|'end', name, who, input?, status?, result?}
 *   {type:'text',    value}                          the answer, orchestrator only
 *   {type:'artifact', name, size, mimeType, url}    a file the run produced
 *   {type:'screen',  who, url}                      a browser frame for that agent's monitor
 *   {type:'stop',    reason, approvals}             how the loop ended; approvals when it paused
 *   {type:'end'} | {type:'error', message}
 *
 * `who` is the boss agent's tool name or a helper's. The browser
 * animates off these, so one shape means the UI behaves identically whether
 * the agent runs locally or inside AgentCore.
 */

import { snapshot, collectNew } from './artifacts.js';
import { pendingApprovals } from './approvals.js';

/** Pulls one protocol event out of a raw SDK event, or [] to ignore it. */
function translate(ev, who, agentNames, main) {
  switch (ev.type) {
    case 'beforeModelCallEvent':
      return [{ type: 'status', value: 'thinking', who }];

    case 'beforeToolCallEvent': {
      const name = ev.toolUse?.name;
      // A "tool" that is really a colleague gets announced as an agent instead.
      if (agentNames.has(name)) {
        return [
          { type: 'agent', name, phase: 'start' },
          { type: 'status', value: 'tool', who: name },
        ];
      }
      return [
        { type: 'tool', phase: 'start', name, who, input: ev.toolUse?.input },
        { type: 'status', value: 'tool', who },
      ];
    }

    case 'afterToolCallEvent': {
      const name = ev.toolUse?.name;
      // ToolResultBlock: real props are {type,toolUseId,status,content,error}.
      // The {toolResult:...} wrapper only exists in its toJSON() output.
      const block = ev.result;
      const first = block?.content?.[0];
      const status = block?.status ?? (ev.error ? 'error' : 'success');
      if (agentNames.has(name)) {
        return [{ type: 'agent', name, phase: 'end', status }];
      }
      return [{
        type: 'tool',
        phase: 'end',
        name,
        who,
        status,
        result: first?.json ?? first?.text ?? null,
      }];
    }

    case 'modelStreamUpdateEvent': {
      const d = ev.event?.delta;
      if (d?.type === 'reasoningContentDelta' && d.text) {
        return [{ type: 'thought', who, value: d.text }];
      }
      if (d?.type === 'textDelta' && d.text) {
        // Only the orchestrator's prose is the answer. A specialist's draft
        // comes back through the delegation result and Atlas relays it, so
        // emitting it here too would print the whole thing twice.
        return who === main ? [{ type: 'text', value: d.text }] : [];
      }
      return [];
    }

    case 'agentResultEvent':
      return who === main ? [{ type: 'status', value: 'done', who }] : [];

    default:
      return [];
  }
}

/**
 * A push queue that an async generator can drain.
 *
 * The agent's own stream goes quiet for the whole duration of a tool call - a
 * `browse` can take ten seconds with no events at all - so a generator that
 * only forwards agent events has no opportunity to emit anything else in the
 * meantime. Anything that produces output on its own clock (browser frames)
 * pushes in here instead, and the two are drained together.
 */
function createQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(value) { items.push(value); wake?.(); wake = null; },
    close() { closed = true; wake?.(); wake = null; },
    async *drain() {
      while (true) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise((resolve) => { wake = resolve; });
      }
    },
  };
}

/** How often to grab a frame while the agent has a page open. */
const FRAME_INTERVAL_MS = Number(process.env.BROWSER_FRAME_MS || 900);

/**
 * Drives an agent and yields protocol events, including those from any
 * specialist it delegates to.
 *
 * A delegated agent's whole inner stream arrives wrapped twice:
 *   toolStreamUpdateEvent -> ev.event (ToolStreamEvent) -> .data (the real event)
 *
 * @param {import('@strands-agents/sdk').Agent} agent
 * @param {string} prompt
 * @param {object} [options]
 * @param {Array<{who:string, workspace:object}>} [options.workspaces]
 * @param {Array<{who:string, web:object}>} [options.webs]
 * @param {string} [options.sessionId]  namespaces published artifacts
 * @param {string} [options.userId]     whose filing cabinet finished files land in
 * @param {Set<string>} [options.agentNames]  tool names that are really colleagues
 * @param {string} [options.main]             the boss agent's tool name
 */
export async function* agentEvents(agent, prompt, {
  workspaces = [], webs = [], sessionId, userId, agentNames = new Set(), main = 'agent',
} = {}) {
  const queue = createQueue();
  queue.push({ type: 'status', value: 'thinking', who: main });

  // Snapshot first so only files this run creates are offered to the user.
  //
  // Only if a VM is already running, though: listing files would START one,
  // and then every "what is 2+2" would spin up (and bill for) a microVM. On a
  // cold workspace the baseline is empty, which is correct - anything the run
  // leaves behind is new by definition.
  const before = new Map();
  for (const { who, workspace } of workspaces) {
    before.set(who, workspace.started ? await snapshot(workspace) : new Set());
  }

  // Frames tick on their own clock, so the monitor updates live while the
  // agent is still inside the browse call rather than only once it returns.
  const ticker = webs.length
    ? setInterval(async () => {
        for (const { who, web } of webs) {
          if (!web.started) continue;
          const frame = await web.capture().catch(() => null);
          if (frame) queue.push({ type: 'screen', who, url: frame });
        }
      }, FRAME_INTERVAL_MS)
    : null;

  const pump = (async () => {
    // Which specialist is currently running, so its inner events can be tagged.
    // ev.agent on an inner event reports the PARENT, so it cannot be used here.
    let activeSpecialist = null;

    // Iterated by hand rather than for-await: the generator's return value
    // is the AgentResult, and that is where the stop reason and any pending
    // approvals live.
    const gen = agent.stream(prompt);
    let step = await gen.next();
    while (!step.done) {
      const ev = step.value;
      if (ev.type === 'beforeToolCallEvent' && agentNames.has(ev.toolUse?.name)) {
        activeSpecialist = ev.toolUse.name;
      }

      if (ev.type === 'toolStreamUpdateEvent') {
        const data = ev.event?.data;
        // A handoff envelope tags each inner event with the colleague it came
        // from, so two colleagues working at once do not get mixed up.
        const inner = data?.who && data?.event ? data.event : data;
        const who = data?.who && data?.event ? data.who : (activeSpecialist ?? main);
        if (inner?.type) {
          for (const out of translate(inner, who, agentNames, main)) queue.push(out);
        }
        step = await gen.next();
        continue;
      }

      for (const out of translate(ev, main, agentNames, main)) queue.push(out);

      if (ev.type === 'afterToolCallEvent' && agentNames.has(ev.toolUse?.name)) {
        activeSpecialist = null;
      }
      step = await gen.next();
    }
    const result = step.value;
    queue.push({ type: 'stop', reason: result?.stopReason ?? 'endTurn', approvals: pendingApprovals(result) });
  })();

  pump
    .catch((err) => queue.push({ type: 'error', message: err?.message ?? 'Agent failed.' }))
    .finally(() => {
      if (ticker) clearInterval(ticker);
      queue.close();
    });

  for await (const ev of queue.drain()) yield ev;

  // One last frame each, so the page an agent finished on is the one left up.
  for (const { who, web } of webs) {
    if (!web.started) continue;
    const frame = await web.capture().catch(() => null);
    if (frame) yield { type: 'screen', who, url: frame };
  }

  // Only look for output where an agent actually opened its workspace.
  for (const { who, workspace } of workspaces) {
    if (!workspace.started) continue;
    for (const a of await collectNew(workspace, before.get(who) ?? new Set(), sessionId, userId)) {
      yield { type: 'artifact', who, ...a };
    }
  }
  yield { type: 'end' };
}

/** Server-sent-events framing. AgentCore streams a response only for this content type. */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export const sseLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** Pulls protocol events out of an SSE byte stream. */
export function makeSseParser(onEvent) {
  let buf = '';
  return (chunkText) => {
    buf += chunkText;
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const body = line.slice(5).trim();
        if (!body) continue;
        try { onEvent(JSON.parse(body)); } catch { /* ignore partial/keepalive */ }
      }
    }
  };
}
