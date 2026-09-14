/**
 * The user's world: which agents exist, and what computers they have.
 *
 * Stored on the same DynamoDB record as the room theme, keyed by the stable
 * anonymous user id. One read gets everything the room needs; one write saves
 * it. There are at most a couple of agents, so a list on a single item beats a
 * second table with its own query path.
 *
 * Creating an agent is a database write. Nothing is redeployed, ever.
 */
import { readPrefs, writePrefs } from './prefs.js';
import { RIGS, SKINS, DEFAULT_RIG, DEFAULT_SKIN, MAX_AGENTS } from './rigs.js';
import { CONNECTORS } from './connectors.js';
import { isRole } from './roles.js';

const MAX_NAME = 24;
const MAX_INSTRUCTIONS = 2000;

/**
 * How an agent looks: the paper-doll slots the browser knows how to draw.
 * The server only checks shape - short lowercase ids per slot - and lets the
 * renderer fall back to a default for anything it does not recognise, so a
 * wardrobe item can be retired without breaking a stored agent.
 */
const LOOK_SLOTS = ['skin', 'hair', 'hairColor', 'top', 'topColor', 'bottom', 'bottomColor', 'shoes', 'shoeColor', 'hat', 'hatColor', 'glasses'];
const LOOK_ID = /^[a-z0-9_-]{1,16}$/;
function cleanLook(look) {
  if (!look || typeof look !== 'object') return undefined;
  const out = {};
  for (const k of LOOK_SLOTS) if (LOOK_ID.test(String(look[k] ?? ''))) out[k] = String(look[k]);
  return Object.keys(out).length ? out : undefined;
}

/** Tool-name rules: the model calls a helper by name, so it must be callable. */
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9 _-]{1,23}$/;

/** A name usable as a tool id: lowercase, no spaces. */
export const toolNameFor = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);

/** Normalises whatever is stored into something the rest of the code can trust. */
function clean(agent, slot) {
  const name = String(agent?.name ?? '').trim().slice(0, MAX_NAME);
  return {
    slot,
    name: name || `Agent ${slot + 1}`,
    toolName: toolNameFor(name || `agent_${slot + 1}`),
    role: slot === 0 ? 'boss' : 'helper',
    instructions: String(agent?.instructions ?? '').slice(0, MAX_INSTRUCTIONS),
    rig: RIGS[agent?.rig] ? agent.rig : DEFAULT_RIG,
    colour: SKINS[agent?.colour] ? agent.colour : DEFAULT_SKIN,
    ...(cleanLook(agent?.look) ? { look: cleanLook(agent.look) } : {}),
    /** Role template the agent was built from; its skills ride in the prompt. */
    ...(isRole(agent?.template) ? { template: agent.template } : {}),
    /** Connector ids this agent may use. Unknown ids are dropped. */
    grants: (Array.isArray(agent?.grants) ? agent.grants : []).filter((g) => CONNECTORS[g]),
  };
}

/**
 * @returns {Promise<Array>} the roster, in slot order. Empty is a valid world.
 * @throws if the store could not be read - the caller must not mistake a
 *         failed lookup for a user who has not built anything.
 */
export async function readWorld(userId) {
  const { prefs, failed } = await readPrefs(userId);
  if (failed) throw new Error('Could not reach your saved agents. Try again in a moment.');
  const raw = Array.isArray(prefs?.agents) ? prefs.agents : [];
  const connections = prefs?.connections && typeof prefs.connections === 'object'
    ? prefs.connections : {};
  const agents = raw.slice(0, MAX_AGENTS).map((a, i) => clean(a, i));
  // A pass to an account that is no longer linked must not stay in force.
  for (const a of agents) a.grants = a.grants.filter((g) => connections[g]?.linked);
  return { agents, connections };
}

/** Links or unlinks an account for the whole world. */
export async function setConnection(userId, id, linked) {
  if (!CONNECTORS[id]) throw new Error(`Unknown connector "${id}".`);
  const { prefs } = await readPrefs(userId);
  const connections = { ...(prefs?.connections ?? {}) };
  if (linked) connections[id] = { linked: true, linkedAt: new Date().toISOString() };
  else delete connections[id];

  const { stored } = await writePrefs(userId, {
    ...(prefs?.theme ? { theme: prefs.theme } : {}),
    ...(prefs?.agents ? { agents: prefs.agents } : {}),
    connections,
  });
  if (!stored) throw new Error('Could not save the connection. Nothing was changed.');
  return connections;
}

/**
 * Replaces the whole roster. Validation lives here rather than in the route so
 * the rules hold whoever writes.
 * @returns {Promise<{agents: Array, stored: boolean}>}
 */
export async function writeWorld(userId, agents) {
  if (!Array.isArray(agents)) throw new Error('agents must be a list.');
  if (agents.length > MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} agents.`);

  const seen = new Set();
  const cleaned = agents.map((a, i) => {
    const name = String(a?.name ?? '').trim();
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`"${name || '(blank)'}" is not a usable name: letters, numbers, spaces, 2-24 characters.`);
    }
    const c = clean({ ...a, name }, i);
    if (seen.has(c.toolName)) throw new Error(`Two agents would both be called "${c.toolName}".`);
    seen.add(c.toolName);
    return c;
  });

  // Preserve the theme and connections, which live on the same record.
  const { prefs } = await readPrefs(userId);
  const connections = prefs?.connections ?? {};
  // Cannot grant a pass to an account nobody has linked.
  for (const a of cleaned) a.grants = a.grants.filter((g) => connections[g]?.linked);

  const { stored } = await writePrefs(userId, {
    ...(prefs?.theme ? { theme: prefs.theme } : {}),
    ...(Object.keys(connections).length ? { connections } : {}),
    agents: cleaned,
  });
  return { agents: cleaned, stored };
}
