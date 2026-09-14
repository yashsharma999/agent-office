/**
 * The computers you can buy an agent.
 *
 * AWS does not let you choose vCPU or memory - `create-code-interpreter` and
 * `create-agent-runtime` have no compute parameters at all, and every sandbox
 * is a fixed 2 vCPU / 8 GB. So a "better computer" cannot mean more CPU.
 *
 * What it means instead is a better brain, more thinking, and more
 * peripherals - all of which are real, cost real money, and are visible in
 * the room. A Salvaged Terminal genuinely cannot browse the web; buying the
 * upgrade is what unlocks it.
 *
 * This is the single source of truth. The builder UI reads it over
 * `GET /api/rigs` rather than keeping its own copy.
 */

export const RIGS = {
  tin: {
    id: 'tin',
    label: 'Salvaged Terminal',
    blurb: 'A beige box someone threw out. Fast and cheap, no frills.',
    model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    modelLabel: 'Haiku 4.5',
    reasoning: false,
    maxTokens: 2048,
    tools: { shell: false, library: false, browser: false },
    sandboxTtl: 600,
    costHint: '1x',
    monitor: 'crt',
  },
  desk: {
    id: 'desk',
    label: 'Office Workstation',
    blurb: 'A proper machine. Files, a workspace, and a web browser.',
    model: 'global.anthropic.claude-sonnet-4-6',
    modelLabel: 'Sonnet 4.6',
    reasoning: true,
    maxTokens: 4096,
    tools: { shell: true, library: true, browser: true },
    sandboxTtl: 900,
    costHint: '4x',
    monitor: 'flat',
  },
  rig: {
    id: 'rig',
    label: 'Overclocked Rig',
    blurb: 'Two screens and a tower that hums. Thinks hard, works longer.',
    model: 'global.anthropic.claude-opus-4-6-v1',
    modelLabel: 'Opus 4.6',
    reasoning: true,
    maxTokens: 8192,
    tools: { shell: true, library: true, browser: true },
    sandboxTtl: 1800,
    costHint: '6x',
    monitor: 'dual',
  },
};

export const DEFAULT_RIG = 'desk';
export const MAX_AGENTS = 4;

/** Colours an agent can be. Kept here so the builder and the room agree. */
export const SKINS = {
  teal:   { body: '#6ee7d7', mid: '#4fc3b4', dark: '#2b7a70', eye: '#0d2b28', label: 'Teal' },
  amber:  { body: '#ffc46b', mid: '#dfa049', dark: '#8f6224', eye: '#3a2408', label: 'Amber' },
  violet: { body: '#c9a6ff', mid: '#a37fe0', dark: '#5f3f96', eye: '#241436', label: 'Violet' },
  rose:   { body: '#ff9db1', mid: '#e0798f', dark: '#93475a', eye: '#3a1420', label: 'Rose' },
  mint:   { body: '#9ae6a0', mid: '#6fc177', dark: '#3d7a45', eye: '#122d16', label: 'Mint' },
};

export const DEFAULT_SKIN = 'teal';

export const rigFor = (id) => RIGS[id] ?? RIGS[DEFAULT_RIG];
export const skinFor = (id) => SKINS[id] ?? SKINS[DEFAULT_SKIN];

/** What the builder needs to render the shop, without leaking model ids. */
export const rigCatalogue = () =>
  Object.values(RIGS).map(({ id, label, blurb, modelLabel, reasoning, tools, costHint, monitor }) => ({
    id, label, blurb, modelLabel, reasoning, tools, costHint, monitor,
  }));
