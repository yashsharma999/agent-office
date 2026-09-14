/**
 * Isometric office scene, Sims-style camera.
 *
 * Everything is drawn into a small pixel buffer (BUF_W x BUF_H) that CSS
 * upscales, so one fill is one crisp pixel. Canvas path fills are NOT used
 * for shapes - they antialias, which turns to mush at 4x. `poly()` below is
 * an integer scanline filler instead.
 *
 * Grid: 8x8 tiles in a 2:1 isometric projection.
 *   +i goes down-RIGHT on screen, +j goes down-LEFT.
 *   The camera therefore sees the +i and +j faces of every box.
 */

/**
 * Pixel density. Everything in this file is drawn in logical units - the
 * original 196x146 room - and the two primitives below rasterise at P device
 * pixels per unit. Doubling P sharpens every edge without touching a single
 * coordinate, and lets new art spend half-units where old art spent pixels.
 */
const P = 2;
const VIEW_W = 196, VIEW_H = 146;         // logical
export const BUF_W = VIEW_W * P;          // device
export const BUF_H = VIEW_H * P;

const TW = 20, TH = 10;          // tile width / height in pixels
const OX = 98, OY = 54;         // screen position of grid point (0,0)
const GRID = 8;
const WALL_H = 50;

/** Grid point (i,j) -> screen [x,y]. Fractional i/j is fine. */
const gp = (i, j) => [OX + (i - j) * (TW / 2), OY + (i + j) * (TH / 2)];
/** Grid point raised by z pixels. */
const gpz = (i, j, z) => { const p = gp(i, j); return [p[0], p[1] - z]; };

let g = null;
let overlay = null;

/** Crisp integer scanline polygon fill, in logical units rasterised at P. */
function poly(lpts, col) {
  const pts = lpts.map(([x, y]) => [x * P, y * P]);
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const y0 = Math.floor(minY), y1 = Math.ceil(maxY);
  g.fillStyle = col;
  for (let y = y0; y < y1; y++) {
    const xs = [];
    const sy = y + 0.5;
    for (let k = 0; k < pts.length; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[(k + 1) % pts.length];
      if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
        xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.round(xs[k]), xb = Math.round(xs[k + 1]);
      if (xb > xa) g.fillRect(xa, y, xb - xa, 1);
    }
  }
}

/** Axis-aligned fill in logical units. Half-units are real pixels at P=2. */
const rect = (x, y, w, h, col) => {
  const x0 = Math.round(x * P), y0 = Math.round(y * P);
  const x1 = Math.round((x + w) * P), y1 = Math.round((y + h) * P);
  g.fillStyle = col;
  g.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
};

/**
 * An axis-aligned box on the grid.
 * Draws the two camera-facing sides then the top.
 */
function box(i, j, w, d, h, lift, cTop, cLeft, cRight) {
  const zTop = lift + h;
  // +i face (down-right)
  poly([gpz(i + w, j, zTop), gpz(i + w, j + d, zTop), gpz(i + w, j + d, lift), gpz(i + w, j, lift)], cRight);
  // +j face (down-left)
  poly([gpz(i, j + d, zTop), gpz(i + w, j + d, zTop), gpz(i + w, j + d, lift), gpz(i, j + d, lift)], cLeft);
  // top
  poly([gpz(i, j, zTop), gpz(i + w, j, zTop), gpz(i + w, j + d, zTop), gpz(i, j + d, zTop)], cTop);
}

/** A flat quad on a box's +j face (screen faces down-left). */
function faceQuad(i0, i1, jj, z0, z1, col) {
  poly([gpz(i0, jj, z1), gpz(i1, jj, z1), gpz(i1, jj, z0), gpz(i0, jj, z0)], col);
}

/** A flat quad on a box's +i face (screen faces down-right). */
function faceQuadI(j0, j1, ii, z0, z1, col) {
  poly([gpz(ii, j0, z1), gpz(ii, j1, z1), gpz(ii, j1, z0), gpz(ii, j0, z0)], col);
}

/** Mix a hex colour toward white (k>0) or black (k<0). For highlights and shade. */
function tint(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k))));
  const r = ch(n >> 16), gg = ch((n >> 8) & 255), b = ch(n & 255);
  return `#${((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0')}`;
}

// ----------------------------------------------------------------- theme
import { THEMES, DEFAULT_THEME } from './themes.js';
import { drawDoll, drawPortrait, lookFor } from './doll.js';

let themeName = DEFAULT_THEME;
/** Active palette. Reassigned by setTheme, so always read through `C`. */
let C = THEMES[DEFAULT_THEME].palette;
let THEME = THEMES[DEFAULT_THEME];

export function setTheme(name) {
  const th = THEMES[name];
  if (!th) return false;
  themeName = name;
  THEME = th;
  C = th.palette;
  return true;
}
export function getTheme() { return themeName; }

// ----------------------------------------------------------------- state
let t = 0;
/**
 * Frames' worth of time since the last loop, at a nominal 60Hz. Everything
 * that moves scales by it, so the room looks the same on a 60Hz monitor, a
 * 120Hz laptop, and a headless browser running requestAnimationFrame flat out.
 * Clamped so a background tab waking up does not teleport anyone.
 */
let k = 1;
let lastMs = 0;
let sparks = [];
let steam = [];

/**
 * Four desks. Each is either bare, or occupied by whoever the user built into
 * that slot. Nothing here knows any agent's name up front - the roster is
 * pushed in with setRoster().
 */
function newSlot(key) {
  return {
    key,
    agent: null,          // {name, toolName, colour, rig, monitor} or null
    state: 'idle',
    screenOn: 0,
    codeLines: [],
    blinkUntil: 0,
    nextBlink: 120,
    frame: null,          // a live browser screenshot
    // Home is on one's feet in the open floor, facing the room - the chair is
    // only for computer work. `pos` is null while seated; an errand is a walk
    // to one of the room's fixtures, some business there, and the walk back.
    pos: null,
    path: [],
    errand: null,         // {place, verb, phase: 'going'|'acting'|'back', busy, acted, toSeat}
    errands: [],          // further fixtures to visit before going home
    transit: null,        // 'sit' walking to the chair, 'rise' walking back to the home spot
    sinceWork: 0,         // frames seated with nothing running, before getting up
    computing: 0,         // how many computer-using tools are running right now
    idleAt: 300 + Math.random() * 600,   // when to next do something with nothing to do
    fidget: null,         // {kind: 'stretch'|'sip', until}
    step: 0,
    facing: 'front',
  };
}
const slots = [newSlot('A'), newSlot('B'), newSlot('C'), newSlot('D')];

/** toolName -> slot, so events can find the right desk. */
const byName = new Map();

export function setRoster(agents = []) {
  byName.clear();
  slots.forEach((slot, i) => {
    const a = agents[i] ?? null;
    slot.agent = a ? { ...a, look: lookFor(a) } : null;
    slot.state = 'idle';
    slot.frame = null;
    slot.pos = a ? [...HOME_POS[i]] : null; slot.path = []; slot.errand = null; slot.errands = [];
    slot.transit = null; slot.sinceWork = 0; slot.computing = 0; slot.facing = 'front';
    if (a?.toolName) byName.set(a.toolName, slot);
    seedDesk(slot);
  });
}

const slotFor = (who) => byName.get(who) ?? slots[0];

/** Overall status, used for the HUD. */
let state = 'idle';

export function setSceneState(s, who) {
  state = s;
  const slot = who ? slotFor(who) : slots[0];
  if (slot?.agent) slot.state = s;
}

/**
 * The computer is on only while it is actually being used - a shell, a file,
 * the browser. Thinking happens in the agent's head, and mail and calendar
 * are trips across the room, so neither lights the screen. Counted rather
 * than flagged because tools can overlap.
 */
export function setComputing(who, on) {
  const slot = byName.get(who) ?? slots[0];
  if (!slot?.agent) return;
  slot.computing = Math.max(0, slot.computing + (on ? 1 : -1));
  if (on) seedDesk(slot);
}
export function clearComputing() { for (const d of slots) d.computing = 0; }
/** True while the agent is at the keys: seated, with a computer tool running. */
const atKeys = (d) => Boolean(d.agent) && d.computing > 0 && seated(d);

/** A specialist wakes when handed work and dozes off again afterwards. */
export function setAgentActive(who, active) {
  const slot = byName.get(who);
  if (!slot?.agent) return;
  slot.state = active ? 'thinking' : 'idle';
  if (active) seedDesk(slot);
}

function seedDesk(d) {
  d.codeLines = [];
  for (let n = 0; n < 8; n++) {
    d.codeLines.push({
      z: 4 + n * 3.4,
      a: 0.12 + Math.random() * 0.1,
      len: 0.25 + Math.random() * 0.85,
      c: Math.floor(Math.random() * 3),
    });
  }
}
export function reseedScreen() { for (const d of slots) seedDesk(d); }
reseedScreen();

/** A live browser frame for one agent's monitor. */
export function showWebFrame(who, url) {
  const slot = byName.get(who) ?? slots[0];
  if (!slot?.agent) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { slot.frame = img; };
  img.onerror = () => { /* expired or blocked; keep the code view */ };
  img.src = url;
}
export function clearWebFrames() { for (const d of slots) d.frame = null; }
/** True while any monitor is showing a web page. */
export function hasWebFrame(who) {
  if (who) return Boolean(byName.get(who)?.frame);
  return slots.some((d) => d.frame);
}

/** Everything back to sleep. Frames deliberately survive, and so does anyone
 *  mid-errand - they finish the walk rather than teleporting to a chair. */
export function resetScene() {
  for (const d of slots) d.state = 'idle';
  state = 'idle';
}

// ----------------------------------------------------------- fixtures
/**
 * Which accounts the world has linked. A linked account puts its fixture in
 * the room - a letterbox for mail, a calendar on the wall - whether or not any
 * particular agent holds the pass to use it.
 */
let linked = {};
export function setConnections(connections = {}) {
  linked = {};
  for (const [id, c] of Object.entries(connections)) if (c?.linked) linked[id] = true;
}

/**
 * Where each fixture is, and where an agent stands to use it.
 *
 * The letterbox hangs on the right wall left of the big desk; the calendar is
 * on the left wall past the writer's desk. Both are open floor, and both are
 * away from either seat, so a trip is long enough to read as a trip.
 */
const PLACES = {
  mailbox:  { stand: [1.00, 1.15] },
  calendar: { stand: [0.95, 7.30] },
  // places to wander to with nothing to do; each exists only in some themes
  cooler:   { stand: [6.30, 1.50], needs: 'cooler' },
  plant:    { stand: [1.35, 6.55], needs: 'plant' },
};

/**
 * How each seat gets to each fixture without walking through furniture.
 *
 * `exit` is the step out of the chair. Then waypoints. Things to skirt: desk
 * A's tower at i 2.15-2.9, j 2.45-3.2; chair B at i 1.78-2.83, j 4.88-5.83;
 * and the second row - desks C and D at j 3.6-4.75 from i 3.3 rightward,
 * with their chairs at j 4.9-5.85. The one way between the back of the room
 * and the front is the aisle between chair B and desk C (i about 3.0-3.3),
 * so every long trip goes through it. The way back is the route reversed.
 */
const AISLE_UP = [[3.0, 6.5], [3.0, 4.8], [3.1, 3.3]];       // front of the room -> back
const AISLE_DOWN = [...AISLE_UP].reverse();                  // back -> front
const ROUTES = [
  { exit: [4.10, 2.00], mailbox: [[2.0, 1.7]],             calendar: [...AISLE_DOWN],
    cooler: [[4.3, 2.9], [6.4, 2.6]], plant: [...AISLE_DOWN] },
  { exit: [3.00, 6.00], mailbox: [[3.2, 2.2], [2.0, 1.7]], calendar: [],
    cooler: [[3.1, 3.3], [4.3, 2.9], [6.4, 2.6]], plant: [] },
  { exit: [5.00, 6.40], mailbox: [...AISLE_UP, [2.0, 1.7]], calendar: [[3.0, 6.5]],
    cooler: [...AISLE_UP, [4.3, 2.9], [6.4, 2.6]], plant: [[3.0, 6.5]] },
  { exit: [6.90, 6.40], mailbox: [...AISLE_UP, [2.0, 1.7]], calendar: [[3.0, 6.5]],
    cooler: [...AISLE_UP, [4.3, 2.9], [6.4, 2.6]], plant: [[3.0, 6.5]] },
];

/**
 * Where each agent stands when it has no computer work: on the open floor,
 * facing the room. A stands off to the left of the big desk, between the
 * tower and chair B - anywhere nearer its chair is hidden behind the second
 * row's monitors. B stands in front of its chair; C and D loiter in the open
 * front-right corner, staggered so nobody stands in anybody's face. Every
 * spot is a step or two from a chair-side exit, so every route still begins
 * there.
 */
const HOME_POS = [[2.00, 3.60], [3.60, 6.20], [6.20, 6.90], [7.50, 6.30]];

const WALK_SPEED = 0.055;   // tiles per frame; the long trips take about 2s
const MIN_ACT = 70;         // frames spent at a fixture even for an instant tool
const LINGER = 90;          // frames to stay seated after the last computer tool ends

/**
 * Send an agent to a fixture. `verb` is 'read' or 'write' and only changes the
 * business done there.
 *
 * Models call tools in parallel - "let me check both at once" - so a second
 * place arriving mid-trip is normal. It joins a short queue: the current visit
 * is finished first, then the agent walks straight on to the next fixture,
 * and only then home. Each tool's trip stays visible, and nobody is in two
 * places at once.
 */
export function beginErrand(who, place, verb = 'read') {
  const slot = byName.get(who) ?? slots[0];
  if (!slot?.agent || !PLACES[place]) return;
  const idx = slots.indexOf(slot);
  const route = ROUTES[idx];
  const cur = slot.errand;

  // A real job interrupts a wander: turn around, by way of the exit.
  if (cur && cur.verb === 'idle' && verb !== 'idle') {
    slot.errands = [];
    const back = cur.phase === 'acting' ? [...route[cur.place]].reverse() : [];
    slot.path = [...back, route.exit, ...route[place], PLACES[place].stand];
    slot.errand = { place, verb, phase: 'going', busy: true, acted: 0 };
    return;
  }
  // Already there or on the way, or already on the list: it is live again.
  if (cur?.place === place && cur.phase !== 'back') { cur.verb = verb; cur.busy = true; return; }
  const queued = slot.errands.find((e) => e.place === place);
  if (queued) { queued.verb = verb; queued.busy = true; return; }

  const next = { place, verb, phase: 'going', busy: true, acted: 0 };
  if (cur && cur.phase !== 'back') { slot.errands.push(next); return; }

  // Setting off - from the chair, the home spot, or turning around on the way
  // home. Either way the route begins at the chair-side exit, which every
  // walk passes.
  slot.pos = slot.pos ?? [...SLOT_POS[idx]];
  slot.transit = null;
  slot.path = [route.exit, ...route[place], PLACES[place].stand];
  slot.errand = next;
}

/**
 * A tool finished. Name the place so parallel tools resolve the right trip;
 * without it the current one is meant. The agent leaves once it has been seen
 * there long enough.
 */
export function finishErrand(who, place) {
  const slot = byName.get(who) ?? slots[0];
  if (!slot) return;
  const target = !place || slot.errand?.place === place
    ? slot.errand
    : slot.errands.find((e) => e.place === place);
  if (target) target.busy = false;
}

/** One frame of walking or acting for a slot. */
function advanceErrand(d, idx) {
  const e = d.errand;
  if (!e || !d.pos) return;
  const route = ROUTES[idx];

  if (e.phase === 'acting') {
    e.acted += k;
    if (e.busy || e.acted <= (e.verb === 'idle' ? MIN_ACT * 2 : MIN_ACT)) return;
    const next = d.errands.shift();
    if (next) {
      // Straight on to the next fixture, by way of the chair-side exit.
      d.path = [...[...route[e.place]].reverse(), route.exit, ...route[next.place], PLACES[next.place].stand];
      d.errand = next;
    } else {
      // Home is the chair if a computer tool is waiting, the floor otherwise.
      e.phase = 'back';
      e.toSeat = d.computing > 0;
      d.path = [...[...route[e.place]].reverse(), route.exit, e.toSeat ? SLOT_POS[idx] : HOME_POS[idx]];
    }
    return;
  }

  if (!walk(d)) return;
  if (e.phase === 'going') { e.phase = 'acting'; e.acted = 0; d.facing = 'back'; }
  else if (e.toSeat) { d.pos = null; d.errand = null; d.sinceWork = 0; }
  else { d.facing = 'front'; d.errand = null; }
}

/** One stride along d.path. True once the last waypoint has been reached. */
function walk(d) {
  const target = d.path[0];
  if (!target) return true;
  const dx = target[0] - d.pos[0], dy = target[1] - d.pos[1];
  const dist = Math.hypot(dx, dy);
  const stride = WALK_SPEED * k;
  if (dist <= stride) {
    d.pos = [...target];
    d.path.shift();
    return d.path.length === 0;
  }
  d.pos[0] += (dx / dist) * stride;
  d.pos[1] += (dy / dist) * stride;
  d.step += k;
  // Walking toward the camera means i+j is growing.
  if (Math.abs(dx + dy) > 0.01) d.facing = dx + dy > 0 ? 'front' : 'back';
  return false;
}

/**
 * The chair is for computer work only. A shell, a file, the browser: the
 * agent walks over and sits. When the last such tool ends it lingers a
 * moment - the next one is often seconds away - then gets up and returns to
 * its spot on the floor, facing the room. Errands take priority; the walk
 * home from one already picks chair or floor (see advanceErrand).
 */
function advanceSeat(d, idx) {
  if (!d.agent || d.errand) return;
  const route = ROUTES[idx];
  const wants = d.computing > 0;

  if (d.transit) {
    // Called back to the keys while walking away: turn around.
    if (d.transit === 'rise' && wants) { d.transit = 'sit'; d.path = [route.exit, SLOT_POS[idx]]; }
    const arrived = walk(d);
    if (d.transit === 'sit') d.facing = 'back';   // the last step is sideways into the chair
    if (!arrived) return;
    if (d.transit === 'sit') { d.pos = null; d.sinceWork = 0; }
    else d.facing = 'front';
    d.transit = null;
    return;
  }

  if (seated(d)) {
    if (wants) { d.sinceWork = 0; return; }
    d.sinceWork += k;
    if (d.sinceWork < LINGER) return;
    d.pos = [...SLOT_POS[idx]];
    d.path = [route.exit, HOME_POS[idx]];
    d.transit = 'rise';
    d.fidget = null;
  } else if (wants) {
    d.path = [route.exit, SLOT_POS[idx]];
    d.transit = 'sit';
    d.fidget = null;
  }
}

/** A read-only view of where everyone is, for poking at the room from the console. */
export function debugSlots() {
  return slots.map((d) => ({
    who: d.agent?.toolName ?? null, state: d.state, t,
    pos: d.pos ? d.pos.map((v) => +v.toFixed(2)) : null, facing: d.facing,
    pathLeft: d.path.length, errand: d.errand ? { ...d.errand } : null,
    queue: d.errands.map((e) => e.place), fidget: d.fidget?.kind ?? null, idleIn: Math.round(d.idleAt - t),
    seated: seated(d), transit: d.transit, computing: d.computing, screenOn: +d.screenOn.toFixed(2),
  }));
}

// ---------------------------------------------------------- selection
/** The agent the user clicked on, by tool name. Wears the plumbob. */
let selected = null;
export function setSelected(who) { selected = who ?? null; }
export function getSelected() { return selected; }

/** Whether an agent currently has a plumbob over its head. */
function hasPlumbob(d) {
  return Boolean(d.agent) && (d.agent.toolName === selected || d.state !== 'idle' || Boolean(d.errand));
}

/**
 * Which agent, if any, is under a point given in device buffer pixels (what
 * the page can compute from a click). The sprite is roughly 20 wide and 44
 * tall above its ground point; the nearer agent wins an overlap.
 */
export function hitAgent(dx, dy) {
  const lx = dx / P, ly = dy / P;
  let best = null, bestDepth = -Infinity;
  slots.forEach((d, i) => {
    if (!d.agent) return;
    const pos = d.pos ?? SLOT_POS[i];
    const [cx, cy] = gp(pos[0], pos[1]);
    const top = cy - 34, bottom = cy + 2;
    if (lx >= cx - 12 && lx <= cx + 12 && ly >= top && ly <= bottom) {
      const depth = pos[0] + pos[1];
      if (depth > bestDepth) { best = d.agent.toolName; bestDepth = depth; }
    }
  });
  return best;
}

/**
 * The plumbob: the spinning diamond that says "this one". Colour is what the
 * agent is doing; the width breathing is the spin.
 */
function drawPlumbob(cx, bottomY, col) {
  const spin = Math.abs(Math.cos(t / 22));
  const hw = 1.5 + 3 * spin;              // half width
  const bob = Math.sin(t / 30) * 1.2;
  const mid = bottomY - 6 + bob, apex = bottomY - 12 + bob, base = bottomY + bob;
  const light = tint(col, 0.35), dark = tint(col, -0.3);
  poly([[cx, apex], [cx - hw, mid], [cx, base]], light);
  poly([[cx, apex], [cx + hw, mid], [cx, base]], dark);
  poly([[cx - 0.5, apex + 2], [cx - hw * 0.4, mid], [cx - 0.5, base - 2]], tint(col, 0.6));
}

/** A ring on the floor under the selected agent. */
function drawSelectRing(i, j) {
  const ri = 0.62, rj = 0.48, w = 0.07;
  const pts = (a, b) => [gp(i - a, j), gp(i, j - b), gp(i + a, j), gp(i, j + b)];
  const o = pts(ri, rj), n = pts(ri - w, rj - w);
  g.globalAlpha = 0.85;
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    poly([o[k], o[k2], n[k2], n[k]], '#7ee787');
  }
  g.globalAlpha = 1;
}

/** A head-and-shoulders portrait on a small square canvas, for the agent panel. */
export function paintPortrait(ctx, agent, mood = null) {
  drawPortrait(ctx, lookFor(agent), { mood, size: ctx.canvas.width });
}

/** True while an agent is in its chair; on its feet anywhere else. */
const seated = (d) => !d.pos;

/**
 * Life with nothing to do. Every so often an idle agent stretches, sips its
 * coffee, or - when the whole room is quiet - wanders to the cooler or the
 * plant and back. A real errand always interrupts (see beginErrand).
 */
function idleBehaviour(d) {
  if (!d.agent) return;
  if (d.fidget && (t > d.fidget.until || d.state !== 'idle')) d.fidget = null;
  if (d.state !== 'idle' || d.errand || d.transit || d.fidget || t < d.idleAt) return;

  const roll = Math.random();
  const spots = Object.entries(PLACES).filter(([, pl]) => pl.needs && THEME.extras.includes(pl.needs));
  if (state === 'idle' && spots.length && roll < 0.22) {
    const [place] = spots[(Math.random() * spots.length) | 0];
    beginErrand(d.agent.toolName, place, 'idle');
    // a wander leaves on its own once it has been seen there
    setTimeout(() => finishErrand(d.agent?.toolName, place), 3800);
  } else {
    d.fidget = roll < 0.6 ? { kind: 'stretch', until: t + 80 } : { kind: 'sip', until: t + 75 };
  }
  d.idleAt = t + 700 + Math.random() * 900;
}


function screenPalette(st) {
  if (st === 'error') return ['#ff5d73', '#8d2233', '#ffb3bd'];
  if (st === 'done')  return ['#7ee787', '#2c6b36', '#c6ffcd'];
  if (st === 'tool')  return ['#ffd166', '#6ee7d7', '#b892ff'];
  return ['#6ee7d7', '#b892ff', '#4a8f86'];
}

/**
 * What each rig looks like on the desk. A Salvaged Terminal is a squat little
 * CRT; the Overclocked Rig gets a second screen and a tower with blinkenlights.
 */
const MONITORS = {
  crt:  { i0: 3.45, i1: 4.55, h: 15, stand: 4, second: false, tower: false },
  flat: { i0: 3.00, i1: 4.95, h: 21, stand: 7, second: false, tower: false },
  dual: { i0: 3.00, i1: 4.75, h: 22, stand: 7, second: true,  tower: true  },
};

// ----------------------------------------------------------------- pieces
function drawFloor() {
  const style = THEME.floorStyle;
  const ins = 0.035;
  const tile = (i, j, k) => [gp(i + k, j + k), gp(i + 1 - k, j + k), gp(i + 1 - k, j + 1 - k), gp(i + k, j + 1 - k)];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const onRug = i >= 2 && i <= 7 && j >= 2 && j <= 6 && style !== 'checker';
      let col;
      if (onRug) col = (i + j) % 2 ? C.rugA : C.rugB;
      else if (style === 'checker') col = (i + j) % 2 ? C.floorA : C.floorB;
      else if (style === 'carpet') col = (i * 3 + j * 5) % 4 === 0 ? C.floorB : C.floorA;
      else col = (i + j) % 2 ? C.floorA : C.floorB;   // wood planks
      if (onRug) { poly(tile(i, j, 0), col); continue; }   // fabric has no grout
      // grout, then the tile set into it - reads as tiles rather than a print
      poly(tile(i, j, 0), C.floorEdge);
      poly(tile(i, j, ins), col);
      if (style === 'wood') {
        // a grain line along the plank
        g.globalAlpha = 0.18;
        poly([gp(i + 0.1, j + 0.55), gp(i + 0.9, j + 0.55), gp(i + 0.9, j + 0.6), gp(i + 0.1, j + 0.6)], C.floorEdge);
        g.globalAlpha = 1;
      }
    }
  }
  if (style !== 'checker') {
    // rug border: a darker band just inside its edge
    g.globalAlpha = 0.35;
    const e = 0.08;
    poly([gp(2, 2), gp(8, 2), gp(8, 2 + e), gp(2, 2 + e)], C.floorEdge);
    poly([gp(2, 2), gp(2 + e, 2), gp(2 + e, 7), gp(2, 7)], C.floorEdge);
    poly([gp(2, 7 - e), gp(8, 7 - e), gp(8, 7), gp(2, 7)], C.floorEdge);
    poly([gp(8 - e, 2), gp(8, 2), gp(8, 7), gp(8 - e, 7)], C.floorEdge);
    g.globalAlpha = 1;
  }
}

/**
 * Light. The room used to be lit evenly from nowhere; these are the three
 * things that make it read as a lit space instead of a diagram.
 */
function drawFloorAO() {
  // the floor darkens where it meets a wall
  g.globalAlpha = 0.22;
  poly([gp(0, 0), gp(0, GRID), gp(0.3, GRID), gp(0.3, 0)], '#08060f');
  poly([gp(0, 0), gp(GRID, 0), gp(GRID, 0.3), gp(0, 0.3)], '#08060f');
  g.globalAlpha = 0.10;
  poly([gp(0.3, 0.3), gp(0.3, GRID), gp(0.7, GRID), gp(0.7, 0.3)], '#08060f');
  poly([gp(0.3, 0.3), gp(GRID, 0.3), gp(GRID, 0.7), gp(0.3, 0.7)], '#08060f');
  g.globalAlpha = 1;
}

function drawWindowLight() {
  const daylit = THEME.windowStyle === 'city-day';
  const ph = daylit ? dayPhase() : 'night';
  const col = daylit && ph === 'day' ? '#fff1c9' : daylit && ph === 'dusk' ? '#ffb570'
    : THEME.windowStyle === 'neon' ? C.accent : '#8fb0ff';
  const a0 = daylit && ph === 'day' ? 0.14 : daylit && ph === 'dusk' ? 0.11 : 0.08;
  // spills in from the window on the right wall, drifting a little sideways
  for (const [j0, j1, a] of [[0.15, 1.7, a0], [1.7, 3.3, a0 * 0.55], [3.3, 4.8, a0 * 0.25]]) {
    g.globalAlpha = a;
    poly([gp(3.9 + j0 * 0.12, j0), gp(6.9 + j0 * 0.12, j0), gp(6.9 + j1 * 0.12, j1), gp(3.9 + j1 * 0.12, j1)], col);
  }
  g.globalAlpha = 1;
}

function drawWallShade() {
  // the corner is the darkest part of the room, and the tops catch the light
  for (const [s0, s1, a] of [[0, 0.10, 0.16], [0.10, 0.22, 0.10], [0.22, 0.36, 0.05]]) {
    g.globalAlpha = a;
    poly([wallPt('L', s0, WALL_H), wallPt('L', s1, WALL_H), wallPt('L', s1, 0), wallPt('L', s0, 0)], '#05040a');
    poly([wallPt('R', s0, WALL_H), wallPt('R', s1, WALL_H), wallPt('R', s1, 0), wallPt('R', s0, 0)], '#05040a');
  }
  g.globalAlpha = 0.07;
  poly([wallPt('L', 0, WALL_H), wallPt('L', 1, WALL_H), wallPt('L', 1, WALL_H - 9), wallPt('L', 0, WALL_H - 9)], '#ffffff');
  poly([wallPt('R', 0, WALL_H), wallPt('R', 1, WALL_H), wallPt('R', 1, WALL_H - 9), wallPt('R', 0, WALL_H - 9)], '#ffffff');
  g.globalAlpha = 1;
}

/** A drop shadow for a box footprint, thrown a little away from the window. */
function shadow(i, j, w, d, a = 0.26) {
  const di = 0.12, dj = 0.20, e = 0.05;
  g.globalAlpha = a;
  poly([gp(i - e + di, j - e + dj), gp(i + w + e + di, j - e + dj), gp(i + w + e + di, j + d + e + dj), gp(i - e + di, j + d + e + dj)], '#08060f');
  g.globalAlpha = 1;
}

/** Point on a wall. side 'L' runs top->left corner, 'R' runs top->right. */
function wallPt(side, s, z) {
  return side === 'L' ? gpz(0, s * GRID, z) : gpz(s * GRID, 0, z);
}

function drawWalls() {
  // left wall (runs along +j)
  poly([gpz(0, 0, WALL_H), gpz(0, GRID, WALL_H), gpz(0, GRID, 0), gpz(0, 0, 0)], C.wallL);
  // right wall (runs along +i)
  poly([gpz(0, 0, WALL_H), gpz(GRID, 0, WALL_H), gpz(GRID, 0, 0), gpz(0, 0, 0)], C.wallR);
  // skirting
  poly([gpz(0, 0, 3), gpz(0, GRID, 3), gpz(0, GRID, 0), gpz(0, 0, 0)], C.wallTrim);
  poly([gpz(0, 0, 3), gpz(GRID, 0, 3), gpz(GRID, 0, 0), gpz(0, 0, 0)], C.wallTrim);
}

/** Real time of day, coarse: the daylit office follows it, and the lamp comes on. */
function dayPhase() {
  const h = new Date().getHours();
  return h >= 20 || h < 6 ? 'night' : h >= 17 ? 'dusk' : 'day';
}

/** Window on the right wall. Its contents follow the theme - and, by day, the clock. */
function drawWindow() {
  const q = (s0, s1, z0, z1, col) =>
    poly([wallPt('R', s0, z1), wallPt('R', s1, z1), wallPt('R', s1, z0), wallPt('R', s0, z0)], col);

  q(0.48, 0.86, 16, 42, C.frame);

  if (THEME.windowStyle === 'city-day') {
    const ph = dayPhase();
    const sky = ph === 'night' ? '#1b2140' : ph === 'dusk' ? '#e9865a' : C.sky;
    const low = ph === 'night' ? '#2b3560' : ph === 'dusk' ? '#ffd39a' : C.skyLow;
    const bld = ph === 'day' ? C.building : '#2a2f45';
    q(0.51, 0.83, 19, 39, sky);
    q(0.51, 0.83, 19, 26, low);
    if (ph === 'dusk') q(0.70, 0.76, 30, 33.5, '#ffe6a8');           // low sun
    if (ph === 'night') { q(0.56, 0.58, 35, 36, '#f4f0ff'); q(0.74, 0.755, 32, 33, '#f4f0ff'); }  // stars
    // skyline, with a few lit windows - more of them after dark
    const towers = [[0.53, 12], [0.575, 18], [0.615, 9], [0.655, 15], [0.70, 20], [0.75, 11], [0.79, 16]];
    const every = ph === 'day' ? 4 : 2;
    towers.forEach(([x, h], n) => {
      q(x, x + 0.035, 19, 19 + h, bld);
      if ((((t / 40) | 0) + n) % every !== 0) q(x + 0.008, x + 0.019, 19 + h - 5, 19 + h - 3, C.buildingLit);
      if (ph !== 'day' && n % 2 === 0) q(x + 0.02, x + 0.03, 19 + h - 9, 19 + h - 7.5, C.buildingLit);
    });
  } else if (THEME.windowStyle === 'neon') {
    q(0.51, 0.83, 19, 39, C.sky);
    q(0.51, 0.83, 19, 27, C.skyLow);
    const towers = [[0.54, 14], [0.60, 19], [0.66, 10], [0.72, 17], [0.78, 13]];
    towers.forEach(([x, h], n) => {
      q(x, x + 0.04, 19, 19 + h, '#2a1145');
      if ((((t / 22) | 0) + n) % 3 !== 0) q(x + 0.01, x + 0.03, 19 + h - 4, 19 + h - 2, C.building);
    });
  } else {
    q(0.51, 0.83, 19, 39, C.sky);
    for (let n = 0; n < 6; n++) {
      const ss = 0.54 + n * 0.047;
      const zz = 22 + ((n * 5) % 14);
      if ((((t / 26) | 0) + n) % 5 !== 0) q(ss, ss + 0.012, zz, zz + 1.4, C.building);
    }
    q(0.75, 0.80, 31, 36, C.buildingLit);
  }

  q(0.665, 0.681, 19, 39, C.frame);
  q(0.51, 0.83, 28.4, 29.8, C.frame);
  q(0.46, 0.88, 14, 16.5, C.frame);
}

/** Left-wall decor. Which fixture appears is a theme choice. */
function drawLeftWallDecor() {
  const q = (s0, s1, z0, z1, col) =>
    poly([wallPt('L', s0, z1), wallPt('L', s1, z1), wallPt('L', s1, z0), wallPt('L', s0, z0)], col);

  if (THEME.leftWall === 'whiteboard') {
    q(0.26, 0.72, 26, 48, '#8f97a8');       // frame
    q(0.28, 0.70, 28, 46, '#f4f6f8');       // board
    // scribbles - a box-and-arrow diagram, because of course
    q(0.32, 0.40, 38, 43, C.accent);
    q(0.46, 0.54, 38, 43, C.accent);
    q(0.40, 0.46, 40, 40.8, '#5b6478');
    q(0.32, 0.58, 34, 34.8, '#5b6478');
    q(0.32, 0.50, 31.5, 32.3, '#5b6478');
    q(0.60, 0.68, 37, 44, '#ff9f43');
    // pen tray
    q(0.28, 0.70, 26.5, 27.6, '#c2c8d2');
  } else if (THEME.leftWall === 'neon-sign') {
    const on = ((t / 30) | 0) % 8 !== 0;    // flickers
    g.globalAlpha = on ? 1 : 0.35;
    q(0.30, 0.64, 30, 32, C.accent);
    q(0.30, 0.32, 30, 42, C.accent);
    q(0.62, 0.64, 30, 42, C.accent);
    q(0.30, 0.64, 40, 42, C.accent);
    q(0.44, 0.50, 32, 40, C.leaf);
    g.globalAlpha = 1;
  } else {
    q(0.30, 0.60, 24, 42, '#5a4a80');
    q(0.32, 0.58, 26, 40, '#221a3d');
    q(0.50, 0.555, 34, 38.5, '#ffb457');
    for (let n = 0; n < 7; n++) {
      const s0 = 0.335 + n * 0.032;
      const peak = Math.min(n, 6 - n);
      q(s0, s0 + 0.03, 27, 29 + peak * 2.2, '#6ee7d7');
    }
    q(0.66, 0.90, 30, 32, C.shelf);
    const bookCols = ['#e0574f', '#6ee7d7', '#ffd166', '#b892ff', '#7ee787'];
    for (let n = 0; n < 5; n++) {
      const s0 = 0.68 + n * 0.042;
      q(s0, s0 + 0.032, 32, 32 + 5 + (n % 3) * 2, bookCols[n]);
    }
  }
}

/** A desk lamp at the far end of the big desk. On from dusk. */
function drawLamp() {
  const i = 2.45, j = 0.42, top = 15;
  const on = dayPhase() !== 'day';
  if (on) {
    // a pool of warm light on the desk and up the wall
    g.globalAlpha = 0.16;
    poly([gpz(i - 0.3, j - 0.3, top), gpz(i + 1.1, j - 0.3, top), gpz(i + 1.4, j + 0.9, top), gpz(i - 0.2, j + 0.9, top)], '#ffd48a');
    g.globalAlpha = 0.10;
    poly([gpz(i - 0.4, 0, top + 1), gpz(i + 1.2, 0, top + 1), gpz(i + 1.0, 0, top + 16), gpz(i - 0.2, 0, top + 16)], '#ffd48a');
    g.globalAlpha = 1;
  }
  box(i + 0.1, j + 0.1, 0.22, 0.22, 0.8, top, '#3a3a50', '#2a2a3e', '#22222f');          // base
  box(i + 0.18, j + 0.18, 0.07, 0.07, 8, top + 0.8, '#5a5a72', '#3a3a50', '#31314a');   // stem
  box(i + 0.02, j + 0.02, 0.42, 0.42, 3, top + 8.8, on ? '#ffe3a3' : '#5a5a72', on ? '#d9b46e' : '#3a3a50', on ? '#b8964f' : '#31314a');  // shade
  if (on) { g.globalAlpha = 0.8; poly([gpz(i + 0.08, j + 0.08, top + 8.7), gpz(i + 0.38, j + 0.08, top + 8.7), gpz(i + 0.38, j + 0.38, top + 8.7), gpz(i + 0.08, j + 0.38, top + 8.7)], '#fff4c8'); g.globalAlpha = 1; }
}

function drawDesk() {
  shadow(2, 0.15, 4, 1.15);
  box(2, 0.15, 4, 1.15, 15, 0, C.deskTop, C.deskL, C.deskR);
  drawLamp();
  // a lit front edge
  g.globalAlpha = 0.18;
  poly([gpz(2, 1.3, 15), gpz(6, 1.3, 15), gpz(6, 1.3, 13.6), gpz(2, 1.3, 13.6)], '#ffffff');
  g.globalAlpha = 1;
}

/** Whoever is at a fixture right now, and what they are doing there. */
function actingAt(place) {
  return slots.find((d) => d.errand?.place === place && d.errand.phase === 'acting') ?? null;
}

/**
 * A letterbox on the right wall, left of the big desk. Appears once Gmail is
 * linked. While an agent stands at it, envelopes go in or come out, and the
 * little flag goes up after a draft is posted.
 */
function drawLetterbox() {
  if (!linked.gmail) return;
  const lift = 16;
  box(1.10, 0.02, 0.78, 0.34, 11, lift, '#e0574f', '#b5423c', '#8e302c');
  // slot on the front, and a lip below it
  faceQuad(1.23, 1.77, 0.36, lift + 7.2, lift + 8.4, '#3a1412');
  faceQuad(1.19, 1.81, 0.36, lift + 6.4, lift + 7.0, '#f0b3ae');
  // domed lid
  box(1.15, 0.02, 0.68, 0.30, 1.4, lift + 11, '#f28b84', '#b5423c', '#8e302c');

  // flag on the far end, away from whoever is standing at it: a post, and a
  // paddle that flips up once a draft has gone in
  const d = actingAt('mailbox');
  const flagUp = d?.errand.verb === 'write' && d.errand.acted > 40;
  const [fx, fy] = gpz(1.88, 0.2, lift + 4);
  rect(fx, fy - 8, 1, 8, '#4a2a28');
  if (flagUp) rect(fx + 1, fy - 9, 5, 3, '#ffd166');
  else rect(fx + 1, fy - 3, 2, 4, '#ffd166');
}

/**
 * The business done at a fixture, painted after the agents so a body cannot
 * hide it. Reading: an envelope comes out of the slot, is held up, goes back.
 * Posting: it goes in once, and stays in.
 */
function drawFixtureActions() {
  const d = actingAt('mailbox');
  if (!d) return;
  const [cx, cy] = gp(d.pos[0], d.pos[1]);
  const hy = cy - 6 - 28;                          // top of the head, as in drawStanding
  const [sx, sy] = gpz(1.50, 0.36, 16 + 7.5);      // the slot
  const held = [cx + 5, hy - 3];                   // up beside the head, where it can be seen
  const posting = d.errand.verb === 'write';

  let u;                                           // 0 = in the slot, 1 = held
  if (posting) {
    if (d.errand.acted > 30) return;               // posted; the flag tells the rest
    u = 1 - d.errand.acted / 30;
  } else {
    const k = d.errand.acted % 96;
    u = k < 30 ? k / 30 : k < 66 ? 1 : 1 - (k - 66) / 30;
  }
  const ex = sx + (held[0] - sx) * u, ey = sy + (held[1] - sy) * u;
  rect(ex - 2, ey - 2, 6, 4, '#f7f4ea');
  rect(ex - 2, ey - 2, 6, 1, '#c9c2ad');
  rect(ex, ey, 2, 1, '#e0574f');                  // a stamp
}

/**
 * A wall calendar on the left wall past the writer's desk. Appears once
 * Calendar is linked. Today's square is marked; an agent reading it sweeps a
 * highlight across the month, and one writing to it leaves a red mark.
 */
function drawWallCalendar() {
  if (!linked.calendar) return;
  const q = (s0, s1, z0, z1, col) =>
    poly([wallPt('L', s0, z1), wallPt('L', s1, z1), wallPt('L', s1, z0), wallPt('L', s0, z0)], col);

  const s0 = 0.775, s1 = 0.955, zTop = 46, zBot = 27;
  q(s0 - 0.006, s1 + 0.006, zBot - 0.8, zTop + 0.8, '#2a2a3a');   // frame
  q(s0, s1, zBot, zTop, '#f6f5ef');                                // sheet
  q(s0, s1, zTop - 4, zTop, '#4285f4');                            // header band
  // ring at the top
  const [rx, ry] = wallPt('L', (s0 + s1) / 2, zTop + 1);
  rect(rx - 1, ry - 3, 2, 3, '#c9c2ad');

  // 7 x 4 grid of days
  const cols = 7, rows = 4;
  const cw = (s1 - s0 - 0.016) / cols, ch = (zTop - 4 - zBot - 2.4) / rows;
  const today = (new Date().getDate() - 1) % (cols * rows);
  const d = actingAt('calendar');
  const reading = d && d.errand.verb === 'read';
  const writing = d && d.errand.verb === 'write';
  const sweep = reading ? ((t / 4) | 0) % (cols * rows) : -1;
  const markOn = writing && d.errand.acted > 24 && (((t / 6) | 0) % 4 !== 0);
  const target = (today + 3) % (cols * rows);   // the day being written to

  for (let n = 0; n < cols * rows; n++) {
    const c = n % cols, r = (n / cols) | 0;
    const cs0 = s0 + 0.008 + c * cw, cz1 = zTop - 5.2 - r * ch;
    let col = '#d9d6cc';
    if (n === today) col = '#4285f4';
    if (n === sweep) col = '#ffd166';
    if (n === target && markOn) col = '#e0574f';
    q(cs0, cs0 + cw * 0.72, cz1 - ch * 0.62, cz1, col);
  }
}

/**
 * Where Atlas's screen glass is, in buffer coordinates. Recorded each frame by
 * drawMonitorA() and consumed by paintWebLayer().
 */
/** Per slot: where the glass is, so the overlay knows where to draw a page. */
const screenQuads = [null, null, null, null];

/**
 * Paints the browser frame onto the overlay canvas at full display resolution.
 *
 * Drawing it into the room's own 196x146 buffer would quantise a web page down
 * to roughly 48x16 pixels - unreadable. The overlay sits exactly on top of the
 * room and is sized to real device pixels, so the page stays sharp while
 * everything around it keeps its chunky look.
 *
 * The glass is a parallelogram, so the image is mapped through a matrix built
 * from three of its corners.
 */
function paintWebLayer() {
  if (!overlay) return;
  const cssW = overlay.clientWidth, cssH = overlay.clientHeight;
  if (!cssW || !cssH) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (overlay.width !== Math.round(cssW * dpr) || overlay.height !== Math.round(cssH * dpr)) {
    overlay.width = Math.round(cssW * dpr);
    overlay.height = Math.round(cssH * dpr);
  }
  const o = overlay.getContext('2d');
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.clearRect(0, 0, overlay.width, overlay.height);

  // The room canvas is object-fit:contain inside the same box, so mirror that
  // letterboxing to line the overlay up with it exactly.
  const scale = Math.min(cssW / BUF_W, cssH / BUF_H) * dpr;
  const ox = (overlay.width - BUF_W * scale) / 2;
  const oy = (overlay.height - BUF_H * scale) / 2;
  // quads are in logical units; the buffer is P times finer.
  const map = ([x, y]) => [ox + x * P * scale, oy + y * P * scale];

  slots.forEach((d, n) => paintFrame(o, d, screenQuads[n], map));
}

/** One agent's browser page onto its own screen. */
function paintFrame(o, d, quad, map) {
  const fade = d.screenOn;
  const img = d.frame;
  if (!img || !quad || fade < 0.05) return;
  const [tl, tr, bl] = quad.map(map);
  const ax = tr[0] - tl[0], ay = tr[1] - tl[1];
  const bx = bl[0] - tl[0], by = bl[1] - tl[1];

  o.save();
  o.globalAlpha = fade;
  o.beginPath();
  o.moveTo(tl[0], tl[1]);
  o.lineTo(tr[0], tr[1]);
  o.lineTo(tr[0] + bx, tr[1] + by);
  o.lineTo(bl[0], bl[1]);
  o.closePath();
  o.clip();
  // Smoothing ON: the point of this layer is that the page is NOT pixelated.
  o.imageSmoothingEnabled = true;
  o.imageSmoothingQuality = 'high';
  o.setTransform(ax / img.width, ay / img.width,
                 bx / img.height, by / img.height, tl[0], tl[1]);
  o.drawImage(img, 0, 0);
  o.restore();
}

/** Renders a screen's contents onto a quad, whichever way it faces. */
function drawScreenContents(d, quad, s0, s1, z0, z1) {
  const cols = screenPalette(d.state);
  g.globalAlpha = 0.10 + 0.18 * d.screenOn;
  quad(s0, s1, z0, z1, cols[0]);
  g.globalAlpha = 1;

  if (d.state === 'done') {
    const steps = [[0.30, 8], [0.40, 5.6], [0.50, 8], [0.62, 10.6], [0.74, 13]];
    for (const [p, zz] of steps) {
      const x = s0 + (s1 - s0) * p;
      quad(x, x + (s1 - s0) * 0.07, z0 + zz, z0 + zz + 2.4, cols[0]);
    }
  } else if (d.state === 'error') {
    for (let n = 0; n < 5; n++) {
      const xa = s0 + (s1 - s0) * (0.28 + n * 0.11);
      const xb = s0 + (s1 - s0) * (0.72 - n * 0.11);
      const w = (s1 - s0) * 0.065;
      quad(xa, xa + w, z0 + 3.5 + n * 2.2, z0 + 5.5 + n * 2.2, cols[0]);
      quad(xb, xb + w, z0 + 3.5 + n * 2.2, z0 + 5.5 + n * 2.2, cols[0]);
    }
  } else {
    const speed = d.state === 'tool' ? 0.30 : 0.09;
    for (const L of d.codeLines) {
      L.z += speed;
      if (L.z > 15.4) { L.z = 1.2; L.len = 0.25 + Math.random() * 0.85; L.c = (Math.random() * 3) | 0; }
      const xa = s0 + (s1 - s0) * (0.07 + L.a);
      const xb = Math.min(s1 - (s1 - s0) * 0.05, xa + (s1 - s0) * L.len);
      quad(xa, xb, z0 + L.z, z0 + L.z + 1.4, cols[L.c]);
    }
    if (((t / 18) | 0) % 2 === 0) {
      quad(s0 + (s1 - s0) * 0.05, s0 + (s1 - s0) * 0.12, z0 + 1.5, z0 + 3.2, cols[0]);
    }
  }

  g.globalAlpha = 0.07;
  quad(s0, s1, z1 - 2.4, z1, '#ffffff');
  g.globalAlpha = 1;
}

/**
 * Right-hand desk. Screen faces down-left.
 * A bare desk has no monitor at all - that is what an unequipped slot looks like.
 */
function drawMonitorA() {
  const d = slots[0];
  if (!d.agent) return;
  const shape = MONITORS[d.agent.monitor] ?? MONITORS.flat;
  const i0 = shape.i0, i1 = shape.i1, jj = 1.05;
  const deskH = 15, standH = shape.stand, base = deskH + standH;

  box(3.82, 0.60, 0.46, 0.30, standH, deskH, C.metalTop, C.metalL, C.metalR);
  box(3.62, 0.56, 0.86, 0.38, 1.6, deskH, C.metalTop, C.metalL, C.metalR);
  box(i0, 0.35, i1 - i0, 0.7, shape.h, base, C.metalTop, C.metalL, C.metalR);
  // the overclocked rig gets a second screen and a humming tower
  if (shape.second) {
    box(i1 + 0.08, 0.42, 0.9, 0.6, shape.h - 4, base, C.metalTop, C.metalL, C.metalR);
    faceQuad(i1 + 0.16, i1 + 0.82, 1.02, base + 3, base + shape.h - 6, C.screenOff);
  }
  if (shape.tower) {
    // Out on the floor, clear of the desk. Tucked underneath (j < 1.3) the desk
    // swallows it entirely; flush against the near edge it reads as shadow.
    const ti = 2.15, tj = 2.45;
    shadow(ti, tj, 0.75, 0.75);
    box(ti, tj, 0.75, 0.75, 25, 0, C.metalTop, C.metalL, C.metalR);
    // vents and blinkenlights on the face turned toward the camera
    const front = tj + 0.75;
    for (let v = 0; v < 5; v++) faceQuad(ti + 0.12, ti + 0.62, front, 4 + v * 2.2, 5 + v * 2.2, C.metalR);
    const blink = ((t / 14) | 0) % 3 !== 0;
    faceQuad(ti + 0.12, ti + 0.3, front, 19.5, 21.5, blink ? '#7ee787' : '#1d4425');
    faceQuad(ti + 0.38, ti + 0.52, front, 19.5, 21.5, '#ffd166');
  }

  const z0 = base + 3.5, z1 = base + shape.h - 1.5;
  const s0 = i0 + 0.12, s1 = i1 - 0.12;
  const quad = (a, b, c, e, col) => faceQuad(a, b, jj, c, e, col);
  // bezel catches the light along its top and left
  quad(i0 + 0.03, i1 - 0.03, z1 + 0.4, z1 + 1.1, tint(C.metalTop, 0.35));
  quad(i0 + 0.03, i0 + 0.09, z0 - 1, z1 + 1.1, tint(C.metalTop, 0.25));
  quad(s0, s1, z0, z1, C.screenOff);
  if (d.screenOn > 0.02) {
    // A web page is painted on the overlay layer instead, at full display
    // resolution - see paintWebLayer(). Here we leave the glass dark so the
    // sharp image has something to sit on.
    if (!d.frame) drawScreenContents(d, quad, s0, s1, z0, z1);
  }
  // Remember where the glass is, so the overlay knows where to draw.
  screenQuads[0] = d.frame ? [gpz(s0, jj, z1), gpz(s1, jj, z1), gpz(s0, jj, z0)] : null;

  quad(i1 - 0.21, i1 - 0.12, base + 1.4, base + 2.6,
    d.screenOn > 0.35 ? (d.state === 'error' ? '#ff5d73' : '#7ee787') : '#5a2530');
}

/** Scribe's desk, along the left wall. Screen faces down-right. */
function drawDeskB() {
  shadow(0.15, 2.2, 1.15, 3.2);
  box(0.15, 2.2, 1.15, 3.2, 15, 0, C.deskTop, C.deskR, C.deskL);
  g.globalAlpha = 0.18;
  poly([gpz(1.3, 2.2, 15), gpz(1.3, 5.4, 15), gpz(1.3, 5.4, 13.6), gpz(1.3, 2.2, 13.6)], '#ffffff');
  g.globalAlpha = 1;
}

function drawMonitorB() {
  const d = slots[1];
  if (!d.agent) return;
  const shape = MONITORS[d.agent.monitor] ?? MONITORS.flat;
  const j0 = 2.95, j1 = 4.70, ii = 1.07;
  const deskH = 15, standH = shape.stand, base = deskH + standH;

  box(0.55, 3.66, 0.30, 0.46, standH, deskH, C.metalTop, C.metalL, C.metalR);
  box(0.51, 3.46, 0.38, 0.86, 1.6, deskH, C.metalTop, C.metalL, C.metalR);
  box(0.35, j0 - 0.2, 0.72, j1 - j0 + 0.4, shape.h, base, C.metalTop, C.metalL, C.metalR);

  const z0 = base + 3.5, z1 = base + shape.h - 1.5;
  const s0 = j0 + 0.12, s1 = j1 - 0.12;
  const quad = (a, b, c, e, col) => faceQuadI(a, b, ii, c, e, col);
  quad(j0 - 0.17, j1 + 0.17, z1 + 0.4, z1 + 1.1, tint(C.metalTop, 0.35));
  quad(j0 - 0.17, j0 - 0.11, z0 - 1, z1 + 1.1, tint(C.metalTop, 0.25));
  quad(s0, s1, z0, z1, C.screenOff);
  if (d.screenOn > 0.02 && !d.frame) drawScreenContents(d, quad, s0, s1, z0, z1);
  screenQuads[1] = d.frame ? [gpz(ii, s0, z1), gpz(ii, s1, z1), gpz(ii, s0, z0)] : null;

  quad(4.52, 4.62, base + 1.4, base + 2.6,
    d.screenOn > 0.35 ? (d.state === 'error' ? '#ff5d73' : '#7ee787') : '#5a2530');
}

/** A keyboard: a slab with a grid of keys on top, one of them down while typing. */
function keyboard(i, j, w, d, lift, typing, alongI) {
  box(i, j, w, d, 2, lift, '#4a4a60', '#34344a', '#2b2b40');
  const z = lift + 2.05;
  const n = 9, rows = 2;
  const pressed = typing ? ((t / 5) | 0) % n : -1;
  for (let a = 0; a < n; a++) {
    for (let r = 0; r < rows; r++) {
      const ki = alongI ? i + 0.06 + a * (w - 0.12) / n : i + 0.06 + r * (w - 0.12) / rows;
      const kj = alongI ? j + 0.06 + r * (d - 0.12) / rows : j + 0.06 + a * (d - 0.12) / n;
      const kw = alongI ? (w - 0.12) / n * 0.7 : (w - 0.12) / rows * 0.7;
      const kd = alongI ? (d - 0.12) / rows * 0.7 : (d - 0.12) / n * 0.7;
      const down = a === pressed && r === 1;
      poly([gpz(ki, kj, z), gpz(ki + kw, kj, z), gpz(ki + kw, kj + kd, z), gpz(ki, kj + kd, z)], down ? '#8a8aa8' : '#c4c4d8');
    }
  }
}

function mug(i, j, lift) {
  box(i, j, 0.34, 0.34, 6, lift, C.mug, tint(C.mug, -0.25), tint(C.mug, -0.4));
  box(i + 0.34, j + 0.10, 0.10, 0.14, 3, lift + 1.5, C.mug, tint(C.mug, -0.25), tint(C.mug, -0.4));   // handle
  const z = lift + 6.05;
  poly([gpz(i + 0.06, j + 0.06, z), gpz(i + 0.28, j + 0.06, z), gpz(i + 0.28, j + 0.28, z), gpz(i + 0.06, j + 0.28, z)], '#3b2416');
  poly([gpz(i + 0.09, j + 0.09, z), gpz(i + 0.16, j + 0.09, z), gpz(i + 0.16, j + 0.14, z), gpz(i + 0.09, j + 0.14, z)], '#6b4a34');
}

function drawDeskProps(typing) {
  const lift = 15;
  keyboard(3.55, 1.30, 1.5, 0.42, lift, typing, true);
  box(5.05, 1.35, 0.28, 0.26, 2, lift, '#5a5a72', '#3a3a50', '#31314a');   // mouse
  mug(5.35, 0.45, lift);
  box(2.40, 0.98, 0.44, 0.32, 1.0, lift, '#cfcab4', '#a8a494', '#918d80');  // notepad
  poly([gpz(2.46, 1.08, 16.05), gpz(2.74, 1.08, 16.05), gpz(2.74, 1.11, 16.05), gpz(2.46, 1.11, 16.05)], '#8a86a0');
  poly([gpz(2.46, 1.16, 16.05), gpz(2.70, 1.16, 16.05), gpz(2.70, 1.19, 16.05), gpz(2.46, 1.19, 16.05)], '#8a86a0');
}

function drawDeskPropsB(typing) {
  const lift = 15;
  keyboard(0.40, 3.55, 0.42, 1.5, lift, typing, false);
  box(0.45, 5.05, 0.26, 0.28, 2, lift, '#5a5a72', '#3a3a50', '#31314a');   // mouse
  // a stack of paper - this is the writer's desk
  box(0.42, 2.45, 0.34, 0.5, 1.6, lift, '#cfcab4', '#a8a494', '#918d80');
  box(0.48, 2.55, 0.30, 0.44, 1.2, lift + 1.6, C.paper, '#c9c5ae', '#b5b19c');
}

/**
 * The second row: two smaller desks out on the rug, screens facing down-left
 * like the big desk. Everything is placed from the desk's centre, so the two
 * are the same drawing at two positions.
 *
 * Placed so the people at the wall desks stay in view: any further right and
 * desk D's monitor sits in front of whoever is at the big desk; any further
 * left and desk C's does the same to the scribe's desk.
 */
const ROW2 = [
  { slot: 2, i0: 3.30, w: 2.00, j0: 3.60 },
  { slot: 3, i0: 5.50, w: 2.00, j0: 3.60 },
];
const DEPTH = 1.15;   // same as the big desk

function drawDeskN(desk) {
  const { i0, w, j0 } = desk;
  shadow(i0, j0, w, DEPTH);
  box(i0, j0, w, DEPTH, 15, 0, C.deskTop, C.deskL, C.deskR);
  g.globalAlpha = 0.18;
  poly([gpz(i0, j0 + DEPTH, 15), gpz(i0 + w, j0 + DEPTH, 15), gpz(i0 + w, j0 + DEPTH, 13.6), gpz(i0, j0 + DEPTH, 13.6)], '#ffffff');
  g.globalAlpha = 1;
}

function drawMonitorN(desk) {
  const d = slots[desk.slot];
  if (!d.agent) return;
  const shape = MONITORS[d.agent.monitor] ?? MONITORS.flat;
  const cx = desk.i0 + desk.w / 2, j0 = desk.j0, jj = j0 + 0.9;
  const deskH = 15, standH = shape.stand, base = deskH + standH;
  // A narrower desk: the same shapes, scaled to the width there is. The
  // overclocked rig's tower stays off the floor here - there is no spot for
  // it that would not stand in front of somebody - so it is twin screens.
  const wide = shape.second ? 0.80 : Math.min(desk.w - 0.3, shape.i1 - shape.i0);
  const i0 = shape.second ? cx - 0.85 : cx - wide / 2, i1 = i0 + wide;

  box(cx - 0.23, j0 + 0.45, 0.46, 0.30, standH, deskH, C.metalTop, C.metalL, C.metalR);
  box(cx - 0.43, j0 + 0.41, 0.86, 0.38, 1.6, deskH, C.metalTop, C.metalL, C.metalR);
  box(i0, j0 + 0.2, wide, 0.7, shape.h, base, C.metalTop, C.metalL, C.metalR);
  if (shape.second) {
    box(i1 + 0.06, j0 + 0.27, 0.8, 0.6, shape.h - 4, base, C.metalTop, C.metalL, C.metalR);
    faceQuad(i1 + 0.14, i1 + 0.78, jj - 0.03, base + 3, base + shape.h - 6, C.screenOff);
  }

  const z0 = base + 3.5, z1 = base + shape.h - 1.5;
  const s0 = i0 + 0.12, s1 = i1 - 0.12;
  const quad = (a, b, c, e, col) => faceQuad(a, b, jj, c, e, col);
  quad(i0 + 0.03, i1 - 0.03, z1 + 0.4, z1 + 1.1, tint(C.metalTop, 0.35));
  quad(i0 + 0.03, i0 + 0.09, z0 - 1, z1 + 1.1, tint(C.metalTop, 0.25));
  quad(s0, s1, z0, z1, C.screenOff);
  if (d.screenOn > 0.02 && !d.frame) drawScreenContents(d, quad, s0, s1, z0, z1);
  screenQuads[desk.slot] = d.frame ? [gpz(s0, jj, z1), gpz(s1, jj, z1), gpz(s0, jj, z0)] : null;

  quad(i1 - 0.21, i1 - 0.12, base + 1.4, base + 2.6,
    d.screenOn > 0.35 ? (d.state === 'error' ? '#ff5d73' : '#7ee787') : '#5a2530');
}

function drawDeskPropsN(desk, typing) {
  const cx = desk.i0 + desk.w / 2, lift = 15;
  keyboard(cx - 0.75, desk.j0 + 1.15, 1.5, 0.42, lift, typing, true);
  box(cx + 0.85, desk.j0 + 1.2, 0.28, 0.26, 2, lift, '#5a5a72', '#3a3a50', '#31314a');   // mouse
}

/** Where each row-two keyboard is, for the typing sparks. */
const keysAt = (desk) => [desk.i0 + desk.w / 2 - 0.45, desk.j0 + 1.3];

function drawChairs() {
  // second-row chairs, in front of their desks, backs to the camera
  for (const desk of ROW2) {
    if (!slots[desk.slot].agent) continue;
    const ci = desk.i0 + desk.w / 2 - 0.525, cj = desk.j0 + 1.3;
    shadow(ci, cj, 1.05, 0.95, 0.2);
    box(ci, cj, 1.05, 0.95, 7, 0, C.chairTop, C.chairL, C.chairR);
    poly([gpz(ci + 0.12, cj + 0.12, 7.05), gpz(ci + 0.93, cj + 0.12, 7.05), gpz(ci + 0.93, cj + 0.83, 7.05), gpz(ci + 0.12, cj + 0.83, 7.05)], tint(C.chairTop, 0.10));
    box(ci, cj + 0.72, 1.05, 0.22, 15, 7, C.chairTop, C.chairL, C.chairR);
  }
  if (slots[0].agent) {
    shadow(4.52, 1.44, 1.05, 0.95, 0.2);
    box(4.52, 1.44, 1.05, 0.95, 7, 0, C.chairTop, C.chairL, C.chairR);
    poly([gpz(4.64, 1.56, 7.05), gpz(5.45, 1.56, 7.05), gpz(5.45, 2.27, 7.05), gpz(4.64, 2.27, 7.05)], tint(C.chairTop, 0.10));
    box(4.52, 2.16, 1.05, 0.22, 15, 7, C.chairTop, C.chairL, C.chairR);
  }
  if (slots[1].agent) {
    shadow(1.78, 4.88, 1.05, 0.95, 0.2);
    box(1.78, 4.88, 1.05, 0.95, 7, 0, C.chairTop, C.chairL, C.chairR);
    poly([gpz(1.90, 5.00, 7.05), gpz(2.71, 5.00, 7.05), gpz(2.71, 5.71, 7.05), gpz(1.90, 5.71, 7.05)], tint(C.chairTop, 0.10));
    box(2.50, 4.88, 0.22, 1.05, 15, 7, C.chairTop, C.chairL, C.chairR);
  }
}

/** Where each agent sits: the chair's centre, in grid units. */
const SLOT_POS = [[5.05, 1.92], [2.30, 5.40], [4.30, 5.38], [6.50, 5.38]];
export function agentAnchor(who) {
  const slot = byName.get(who);
  if (!slot?.agent) return null;
  // Follows the agent around the room; a standing sprite is a little taller.
  const pos = slot.pos ?? SLOT_POS[slots.indexOf(slot)];
  const [x, y] = gp(pos[0], pos[1]);
  const lift = (slot.pos ? 34 : 35) + (hasPlumbob(slot) ? 16 : 0);
  return [x * P, (y - lift) * P];   // device pixels
}



const AGENT_STATE_COL = {
  thinking: '#b892ff', tool: '#ffd166', done: '#7ee787', error: '#ff5d73', idle: '#5c5478',
};

/** A soft, two-layer shadow blob under a body. */
function blobShadow(i, j, ri, rj) {
  g.globalAlpha = 0.14;
  poly([gp(i - ri, j), gp(i, j - rj), gp(i + ri, j), gp(i, j + rj)], '#08060f');
  poly([gp(i - ri * 0.6, j), gp(i, j - rj * 0.6), gp(i + ri * 0.6, j), gp(i, j + rj * 0.6)], '#08060f');
  g.globalAlpha = 1;
}

/**
 * An agent on its feet, at `pos`. Back view walking away or facing a wall
 * fixture; front view - the only time the face shows - walking toward us or
 * standing at home, facing the room. The doll draws in device pixels, so it
 * is handed P directly.
 */
function drawStanding(d) {
  const [pi, pj] = d.pos;
  const [cx, cy] = gp(pi, pj);
  const e = d.errand;
  const walking = d.path.length > 0;
  const front = d.facing === 'front';
  const fidget = d.state === 'idle' ? d.fidget?.kind : null;
  const arms = walking ? 'down'
    : e?.place === 'mailbox' ? 'up-right'
    : e?.place === 'calendar' ? 'up-left'
    : e?.place === 'cooler' ? 'cup'
    : fidget === 'stretch' ? 'stretch'
    : fidget === 'sip' ? 'sip' : 'down';
  const mood = d.state === 'idle' ? null : (d.state in AGENT_STATE_COL ? d.state : 'tool');

  if (d.agent.toolName === selected) drawSelectRing(pi, pj);
  blobShadow(pi, pj, 0.55, 0.42);
  drawDoll(g, d.agent.look, {
    x: cx * P, y: cy * P, scale: P,
    view: front ? 'front' : 'back', pose: walking ? 'walk' : 'stand', frame: (d.step / 6) | 0,
    arms, mood, blink: t < d.blinkUntil,
    sway: walking ? Math.sin(t / 9) : Math.sin(t / 40) * 0.6,   // loose hair swings on the walk
  });
  if (hasPlumbob(d)) {
    const stateCol = d.state === 'idle' ? '#7ee787' : (AGENT_STATE_COL[d.state] ?? AGENT_STATE_COL.tool);
    drawPlumbob(cx, cy - 36, stateCol);
  }
}

/**
 * An agent at its desk, seated with its back to the camera. The chair seat is
 * 7 up from the ground point, so the doll's feet-line sits a touch above it
 * and the desk hides the legs. Anyone on their feet is drawn where they are.
 */
function drawAgent(index) {
  const d = slots[index];
  if (!d.agent) return;                 // a bare desk has nobody at it
  if (!seated(d)) { drawStanding(d); return; }
  const [ax, aj] = SLOT_POS[index];
  const [cx, cyRaw] = gp(ax, aj);

  const idle = d.state === 'idle';
  // Idle agents doze: the whole body settles a pixel and breathing is slower.
  const bob = idle ? (Math.sin(t / 70) > 0 ? 0 : 1) : 0;
  const y = cyRaw - 1 + bob;
  const fidget = idle ? d.fidget?.kind : null;
  const arms = fidget === 'stretch' ? 'stretch' : fidget === 'sip' ? 'sip' : idle ? 'lap' : 'keys';

  if (d.agent.toolName === selected) drawSelectRing(ax, aj - 0.3);
  blobShadow(ax, aj - 0.3, 0.6, 0.4);
  drawDoll(g, d.agent.look, {
    x: cx * P, y: y * P, scale: P, view: 'back', pose: 'sit', arms, asleep: idle,
    sway: Math.sin(t / 50) * 0.6,
  });
  if (hasPlumbob(d)) {
    const col = d.state === 'idle' ? '#7ee787' : (AGENT_STATE_COL[d.state] ?? '#7ee787');
    drawPlumbob(cx, y - 36, col);
  }
}

function drawPlant() {
  shadow(0.25, 6.2, 0.7, 0.7, 0.2);
  box(0.25, 6.2, 0.7, 0.7, 9, 0, C.potTop, C.potL, C.potR);
  const [px_, py] = gpz(0.6, 6.55, 9);
  const sway = Math.sin(t / 45) > 0 ? 1 : 0;
  rect(px_ - 1, py - 12, 2, 12, C.leafD);
  rect(px_ - 7 + sway, py - 16, 8, 4, C.leaf);
  rect(px_ + sway, py - 20, 8, 5, C.leaf);
  rect(px_ + 1 - sway, py - 12, 7, 4, C.leafD);
  rect(px_ - 8 + sway, py - 10, 7, 4, C.leaf);
}

/** Office water cooler. */
function drawCooler() {
  shadow(6.55, 0.35, 0.6, 0.6, 0.2);
  box(6.55, 0.35, 0.6, 0.6, 12, 0, '#dfe4ec', '#b6bcc9', '#9aa1b0');   // base
  box(6.62, 0.42, 0.46, 0.46, 11, 12, '#9fd8f0', '#7cbcd8', '#63a3c0'); // bottle
  const [wx, wy] = gpz(6.85, 0.65, 12);
  rect(wx - 2, wy - 2, 4, 2, '#5b6478');
  // a paper cup on top
  rect(wx + 5, wy - 15, 3, 4, C.paper);
}

/** A small potted plant in the far right corner, past the big desk. */
function drawCornerPlant() {
  // Tucked against the right wall, a clear tile away from the desk's end.
  shadow(7.25, 0.30, 0.5, 0.5, 0.2);
  box(7.25, 0.30, 0.5, 0.5, 6, 0, C.potTop, C.potL, C.potR);
  const [px_, py] = gpz(7.50, 0.55, 6);
  const sway = Math.sin(t / 50) > 0 ? 1 : 0;
  rect(px_ - 1, py - 9, 2, 9, C.leafD);
  rect(px_ - 5 + sway, py - 12, 6, 3, C.leaf);
  rect(px_ + sway, py - 15, 6, 4, C.leaf);
  rect(px_ + 1 - sway, py - 9, 5, 3, C.leafD);
  rect(px_ - 6 + sway, py - 7, 5, 3, C.leaf);
}

/** Screen light spilling forward from each lit desk. */
function drawScreenGlow() {
  const a = slots[0], b = slots[1];
  if (a.screenOn > 0.05) {
    const [c1] = screenPalette(a.state);
    g.globalAlpha = 0.05 + 0.10 * a.screenOn;
    poly([gpz(3.1, 1.05, 40), gpz(4.9, 1.05, 40), gpz(7.4, 3.9, 0), gpz(3.0, 3.9, 0)], c1);
    g.globalAlpha = 1;
  }
  if (b.screenOn > 0.05) {
    const [c1] = screenPalette(b.state);
    g.globalAlpha = 0.05 + 0.10 * b.screenOn;
    poly([gpz(1.07, 3.0, 40), gpz(1.07, 4.7, 40), gpz(3.9, 7.2, 0), gpz(3.9, 2.9, 0)], c1);
    g.globalAlpha = 1;
  }
  for (const desk of ROW2) {
    const d = slots[desk.slot];
    if (d.screenOn <= 0.05) continue;
    const cx = desk.i0 + desk.w / 2, jj = desk.j0 + 0.9;
    const [c1] = screenPalette(d.state);
    g.globalAlpha = 0.05 + 0.10 * d.screenOn;
    poly([gpz(cx - 0.9, jj, 40), gpz(cx + 0.9, jj, 40), gpz(cx + 2.3, jj + 2.8, 0), gpz(cx - 2.0, jj + 2.8, 0)], c1);
    g.globalAlpha = 1;
  }
}

function drawSteam() {
  if (Math.random() < (slots[0].state === 'idle' ? 0.05 : 0.1)) {
    const [mx, my] = gpz(5.5, 0.6, 21);
    steam.push({ x: mx + Math.random() * 2, y: my, life: 26 + Math.random() * 16 });
  }
  steam = steam.filter((s) => {
    s.y -= 0.22; s.x += Math.sin((s.life + t) / 9) * 0.14; s.life -= 1;
    return s.life > 0;
  });
  g.globalAlpha = 0.4;
  for (const s of steam) rect(s.x, s.y, 1, 1, '#cfc9e8');
  g.globalAlpha = 1;
}

function drawSparks() {
  if (atKeys(slots[0]) && Math.random() < 0.4) {
    const [kx, ky] = gpz(4.1 + Math.random() * 0.9, 1.45, 18);
    sparks.push({ x: kx, y: ky, vx: (Math.random() - 0.5) * 0.5, vy: -0.32 - Math.random() * 0.3, life: 16 + Math.random() * 12 });
  }
  if (atKeys(slots[1]) && Math.random() < 0.4) {
    const [kx, ky] = gpz(0.6, 3.9 + Math.random() * 0.9, 18);
    sparks.push({ x: kx, y: ky, vx: (Math.random() - 0.5) * 0.5, vy: -0.32 - Math.random() * 0.3, life: 16 + Math.random() * 12 });
  }
  for (const desk of ROW2) {
    if (!atKeys(slots[desk.slot]) || Math.random() >= 0.4) continue;
    const [ki, kj] = keysAt(desk);
    const [kx, ky] = gpz(ki + Math.random() * 0.9, kj, 18);
    sparks.push({ x: kx, y: ky, vx: (Math.random() - 0.5) * 0.5, vy: -0.32 - Math.random() * 0.3, life: 16 + Math.random() * 12 });
  }
  sparks = sparks.filter((s) => { s.x += s.vx; s.y += s.vy; s.life -= 1; return s.life > 0; });
  for (const s of sparks) rect(s.x, s.y, 1, 1, s.life > 12 ? '#fff3c4' : '#ffd166');
}

// ----------------------------------------------------------------- loop
export function startScene(ctx, overlayCanvas = null) {
  g = ctx;
  overlay = overlayCanvas;
  const loop = () => {
    // A throw inside the loop would stop requestAnimationFrame and freeze the
    // whole room, with no error visible on screen. Keep drawing.
    try { frame(); } catch (err) { console.error('scene frame failed:', err); }
    requestAnimationFrame(loop);
  };

  const frame = () => {
    const now = performance.now();
    k = lastMs ? Math.min(4, Math.max(0.25, (now - lastMs) / (1000 / 60))) : 1;
    lastMs = now;
    t += k;

    for (const d of slots) {
      // A monitor showing a web page stays on even once the agent is idle.
      // A monitor showing a web page stays on even once its agent is idle.
      // Lit by use, not by mood: a running computer tool, or a web page up.
      const lit = Boolean(d.agent) && (d.computing > 0 || d.frame);
      d.screenOn += ((lit ? 1 : 0) - d.screenOn) * 0.08;
      if (t > d.nextBlink) { d.blinkUntil = t + 7; d.nextBlink = t + 90 + Math.random() * 150; }
    }

    slots.forEach(idleBehaviour);
    slots.forEach(advanceErrand);
    slots.forEach(advanceSeat);

    // Nobody types at a desk they have walked away from.
    const typing = slots.map((d) => atKeys(d) && ((t / 5) | 0) % 2 === 0);

    // An agent standing at the letterbox is behind the big desk's front edge,
    // so it has to go down before the desk does. Everyone at the back of the
    // room - the two wall desks and anyone standing or walking there - goes
    // down before the second row of desks; the rest comes after.
    const behindDesk = (d) => !seated(d) && d.pos[1] < 1.35;
    const depthOf = (d, n) => { const p = d.pos ?? SLOT_POS[n]; return p[0] + p[1]; };
    const behindRow2 = (d, n) => !behindDesk(d) && depthOf(d, n) < 8.0;
    const inFront = (d, n) => !behindDesk(d) && !behindRow2(d, n);

    g.clearRect(0, 0, BUF_W, BUF_H);
    // painter's order: back of the room first, then furniture, then the
    // agents (which sit in front of their desks), then effects.
    drawWalls();
    drawWallShade();
    drawFloor();
    drawFloorAO();
    drawWindowLight();
    drawWindow();
    drawLeftWallDecor();
    drawWallCalendar();
    drawLetterbox();
    slots.forEach((d, i) => { if (behindDesk(d)) drawAgent(i); });
    for (const extra of THEME.extras) {
      if (extra === 'corner-plant') drawCornerPlant();
      else if (extra === 'cooler') drawCooler();
    }
    drawDesk();
    drawMonitorA();
    if (slots[0].agent) drawDeskProps(typing[0]);
    drawDeskB();
    drawMonitorB();
    if (slots[1].agent) drawDeskPropsB(typing[1]);
    drawScreenGlow();
    if (THEME.extras.includes('plant')) drawPlant();
    drawChairs();
    slots.forEach((d, i) => { if (behindRow2(d, i)) drawAgent(i); });
    // A second-row desk appears only once someone is assigned to it.
    for (const desk of ROW2) {
      if (!slots[desk.slot].agent) continue;
      drawDeskN(desk);
      drawMonitorN(desk);
      drawDeskPropsN(desk, typing[desk.slot]);
    }
    slots.forEach((d, i) => { if (inFront(d, i)) drawAgent(i); });
    drawFixtureActions();
    drawSteam();
    drawSparks();

    paintWebLayer();
  };

  requestAnimationFrame(loop);
}
