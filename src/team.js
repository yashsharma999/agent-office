/**
 * Builds a team from the user's roster.
 *
 * Nothing here is hardcoded: the agents, their instructions, their models and
 * their tools all come out of the world record. Slot 0 is the boss - the one
 * the user talks to - and every other agent becomes one of its tools through
 * a handoff envelope (see `handoff.js`), so a delegated job arrives with a
 * brief, context and a deliverable rather than a bare string. The helper's
 * whole inner event stream surfaces on the boss's stream, tagged with who.
 *
 * What an agent can DO is decided by the computer it was given. A Salvaged
 * Terminal has no shell, no filing cabinet and no browser; a better rig is
 * what unlocks them. See `rigs.js`.
 *
 * Every agent gets the same safety rails: a conversation manager so long
 * chats compress instead of dying, retries with backoff for throttles, a
 * ceiling on loop turns, and a deadline on every tool.
 */
import {
  Agent, tool, InitializedEvent,
  SummarizingConversationManager, DefaultModelRetryStrategy, ExponentialBackoff,
} from '@strands-agents/sdk';
import { z } from 'zod';
import { createModel } from './model.js';
import { AgentCoreSandbox } from './agentcore-sandbox.js';
import { CloudBrowser } from './browser.js';
import { makeLibraryTools } from './library-tools.js';
import { makeBrowserTools } from './browser-tools.js';
import { libraryEnabled } from './library.js';
import { allTools } from './tools.js';
import { rigFor } from './rigs.js';
import { readWorld } from './world.js';
import { connectorFor } from './connectors.js';
import { TOOLS_FOR } from './connector-tools.js';
import { sessionManagerFor } from './chats.js';
import { guardTools, GuardedTool, HANDOFF_TIMEOUT_MS } from './guard.js';
import { HandoffTool } from './handoff.js';
import { skillsFor } from './roles.js';
import { makeMeter } from './usage.js';

// ------------------------------------------------------------ shared tools
const wordCount = tool({
  name: 'word_count',
  description: 'Count the words and sentences in a draft.',
  inputSchema: z.object({ text: z.string().describe('The draft to measure.') }),
  callback: ({ text }) => {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim()).length;
    return { words, sentences };
  },
});

/** Every agent gets these regardless of rig - they cost nothing to run. */
const BASE_TOOLS = [...allTools, wordCount];

/** Loop turns one invocation may take before the SDK stops it. */
const MAX_TURNS = Number(process.env.MAX_TURNS || 60);

const WORKSPACE_NOTE = `
You have a private Linux workspace: a sandboxed VM with Python 3.12 and the
usual document libraries installed (reportlab, python-pptx, python-docx,
openpyxl, Pillow, pandas, matplotlib). Reach it with the shell tool - write a
script with a heredoc and run it.

Your workspace is scratch and is wiped when the conversation goes quiet.
- Always use plain relative filenames ("report.pdf"), never absolute paths.
  Files written outside the working directory are invisible to the user.
- Anything the user attaches is already in your working directory.
- After creating a file, say what you made and its filename. The interface
  attaches it automatically; never paste base64 or invent a link.`;

const LIBRARY_NOTE = `
Lasting files live in the user's saved files, which persist between
conversations. Files they send and documents you finish are filed
automatically. Call list_saved_files before saying you cannot find something,
and open_saved_file to hand a document back.`;

const BROWSER_NOTE = `
You have a real web browser. Use the browse tool for anything needing the live
web. Never guess what a website says - open it.`;

const UNATTENDED_NOTE = `
Nobody is watching this run: it was started by a schedule or a trigger, and
your answer will be delivered as a message. Do the job fully without asking
questions; if a choice is needed, make the sensible one and say which you
made. Anything that changes the user's world (a calendar entry, a draft) will
pause for their approval automatically - just proceed as if it will be given.
Finish with the result itself, written so it reads well as a message.`;

/** Tells an agent what accounts it may reach, and what it may do with each. */
function accessNote(grants) {
  if (!grants.length) {
    return `
You have no access passes, so you cannot see the user's email or any other
account of theirs. If they ask for something that needs one, say so plainly.`;
  }
  const lines = grants
    .map((g) => connectorFor(g))
    .filter(Boolean)
    .map((c) => `- ${c.label}: you may ${c.allows.join(', ')}.`);
  return `
The user has given you access passes:
${lines.join('\n')}
Use them whenever a request touches those accounts. You can never send mail -
leave a draft and tell the user it is waiting for them.`;
}

const NO_HARDWARE_NOTE = `
Your computer is a basic terminal: no workspace, no file storage and no web
browser. If the user needs a file built or a web page read, say plainly that
your hardware cannot do it and that a better computer would.`;

/** Assembles a system prompt from the user's instructions plus its rig. */
function promptFor(spec, rig, helpers, { unattended = false } = {}) {
  const parts = [`You are ${spec.name}.`];
  parts.push(spec.instructions?.trim() || 'You are a helpful assistant.');

  const skills = spec.template ? skillsFor(spec.template) : '';
  if (skills) parts.push('\n' + skills);

  if (helpers.length) {
    parts.push(
      '\nYou have colleagues you can delegate to:\n' +
        helpers
          .map((h) => `- ${h.toolName}: ${h.instructions?.trim().split('\n')[0] || h.name}`)
          .join('\n') +
        '\nHand a colleague a proper brief: what to do, what you already know, and what to come back with. ' +
        'When subtasks are independent, hand them all out in the same turn - colleagues work in parallel. ' +
        'When one of them returns work, relay it to the user in full and verbatim. ' +
        'Never summarise it or replace it with a description.',
    );
  }

  parts.push(accessNote(spec.grants ?? []));

  if (rig.tools.shell) parts.push(WORKSPACE_NOTE);
  if (rig.tools.library && libraryEnabled()) parts.push(LIBRARY_NOTE);
  if (rig.tools.browser) parts.push(BROWSER_NOTE);
  if (!rig.tools.shell && !rig.tools.browser) parts.push(NO_HARDWARE_NOTE);
  if (unattended) parts.push(UNATTENDED_NOTE);

  parts.push('\nBe brief: the answer first, then a sentence of context if it helps.');
  return parts.join('\n');
}

/**
 * Bedrock reports a throttle two ways: as a `throttlingException` event
 * mid-stream, which the SDK turns into ModelThrottledError and retries, and
 * as a plain ThrottlingException thrown before the stream opens, which it
 * does not. Both deserve the same patience.
 */
class PatientRetry extends DefaultModelRetryStrategy {
  isRetryable(err) {
    return super.isRetryable(err)
      || err?.name === 'ThrottlingException'
      || /too many requests|throttl/i.test(String(err?.message ?? ''));
  }
}

/** The rails every agent runs on. Fresh instances per agent: they hold state. */
function rails() {
  return {
    conversationManager: new SummarizingConversationManager({
      preserveRecentMessages: 12,
      proactiveCompression: true,
    }),
    retryStrategy: new PatientRetry({
      maxAttempts: 8,
      backoff: new ExponentialBackoff({ baseMs: 1500, maxMs: 40_000, jitter: 'full' }),
    }),
    limits: { turns: MAX_TURNS },
  };
}

/**
 * Builds one agent plus whatever hardware its rig entitles it to.
 *
 * `colleagues` are tools wrapping the helper Agents. They MUST be passed here
 * rather than pushed onto `agent.tools` afterwards: the Agent builds its tool
 * registry at construction, so a later push leaves the array looking right
 * while the model still cannot call the tool.
 */
function buildMember(spec, { userId, helpers = [], colleagues = [], preset, provider, sessionId, unattended = false }) {
  const rig = rigFor(spec.rig);

  // Lazy: no VM boots until the agent actually reaches for one.
  const workspace = rig.tools.shell ? new AgentCoreSandbox({ label: spec.toolName }) : undefined;
  const web = rig.tools.browser ? new CloudBrowser({ label: spec.toolName }) : undefined;

  const tools = [...BASE_TOOLS];
  if (rig.tools.library && libraryEnabled()) tools.push(...makeLibraryTools({ userId, workspace }));
  if (web) tools.push(...makeBrowserTools({ browser: web }));
  // Connector tools go only to agents holding that pass.
  for (const grant of spec.grants ?? []) {
    const make = TOOLS_FOR[grant];
    if (make) tools.push(...make({ userId, unattended }));
  }

  // The boss remembers the conversation across restarts and reopened chats;
  // a helper's conversation is one delegated job and is not worth keeping.
  const memory = sessionId ? sessionManagerFor(userId, sessionId) : null;
  const prompt = promptFor(spec, rig, helpers, { unattended });
  /**
   * A restored snapshot carries the system prompt it was saved with. The
   * instructions the user has NOW must win - they may have edited the agent
   * since - so this runs after the session manager's restore and puts the
   * current prompt back. Plugins initialise in order, which is why it comes
   * second in the list.
   */
  const keepCurrentPrompt = {
    name: 'keep-current-prompt',
    initAgent(agent) { agent.addHook(InitializedEvent, () => { agent.systemPrompt = prompt; }); },
  };

  const agent = new Agent({
    // Stable id: the SDK files snapshots under it, so it must not change
    // between one boot and the next.
    id: spec.toolName,
    name: spec.toolName,
    description:
      spec.instructions?.trim().split('\n')[0]?.slice(0, 200) || `The ${spec.name} agent.`,
    model: createModel({
      preset,
      provider,
      modelId: rig.model,
      reasoning: rig.reasoning,
      maxTokens: rig.maxTokens,
    }),
    systemPrompt: prompt,
    tools: [...guardTools(tools), ...colleagues],
    ...rails(),
    ...(workspace ? { sandbox: workspace } : {}),
    ...(memory ? { plugins: [memory, keepCurrentPrompt] } : {}),
    printer: false,
  });

  return { spec, rig, agent, workspace, web };
}

/**
 * Assembles the whole team for a user. An empty roster is a valid world - the
 * room stays bare until something is built.
 *
 * @param {object} o
 * @param {string} o.userId
 * @param {string} [o.sessionId]   chat id the boss's memory is filed under
 * @param {boolean} [o.unattended] a scheduled or triggered run: no one to ask
 * @param {object} [o.user]        { email, timeZone } for handoff envelopes
 */
export async function createTeam({ userId = 'anon', preset, provider, roster, sessionId, unattended = false, user = {} } = {}) {
  const world = roster ? { agents: roster, connections: {} } : await readWorld(userId);
  const specs = world.agents;

  if (!specs.length) {
    return {
      boss: null,
      members: [],
      agentToolNames: new Set(),
      workspaces: [],
      webs: [],
      roster: [],
      connections: world.connections,
      userId,
      unattended,
      measure: () => ({ inputTokens: 0, outputTokens: 0, toolCalls: 0 }),
      close: async () => {},
    };
  }

  const [bossSpec, ...helperSpecs] = specs;
  const helpers = helperSpecs.map((s) => buildMember(s, { userId, preset, provider, unattended }));

  // What every envelope says about the user and the boss. `notes` is a slot
  // for the boss's own memory once it has one.
  const about = () => ({
    from: bossSpec.name,
    user: user.email ?? undefined,
    timeZone: user.timeZone ?? undefined,
    date: new Date().toISOString().slice(0, 10),
    notes: '',
  });
  const colleagues = helpers.map((h) => new GuardedTool(
    new HandoffTool({
      agent: h.agent,
      name: h.spec.toolName,
      description: h.spec.instructions?.trim().split('\n')[0]?.slice(0, 200) || `${h.spec.name}, a colleague.`,
      about,
    }),
    HANDOFF_TIMEOUT_MS,
  ));

  const boss = buildMember(bossSpec, {
    userId, preset, provider, sessionId, unattended,
    helpers: helperSpecs,
    colleagues,
  });

  const members = [boss, ...helpers];
  const meter = makeMeter();
  return {
    boss: boss.agent,
    members,
    /** Tool names that are really colleagues, for attributing streamed events. */
    agentToolNames: new Set(helpers.map((h) => h.spec.toolName)),
    /**
     * Hardware belongs to individual agents, not the team. A boss on a
     * Salvaged Terminal has none while its helper does all the work, so both
     * artifact collection and browser frames have to look across everyone.
     */
    workspaces: members
      .filter((m) => m.workspace)
      .map((m) => ({ who: m.spec.toolName, workspace: m.workspace })),
    webs: members.filter((m) => m.web).map((m) => ({ who: m.spec.toolName, web: m.web })),
    roster: specs,
    connections: world.connections,
    userId,
    unattended,
    /** Tokens and tool calls the whole team has spent since the last reading. */
    measure: () => meter(members.map((m) => m.agent)),
    /** Stops every VM this team owns. They bill per second while alive. */
    close: async () => {
      await Promise.all(
        members.flatMap((m) => [
          m.workspace?.close?.().catch(() => {}),
          m.web?.close?.().catch(() => {}),
        ]).filter(Boolean),
      );
    },
  };
}
