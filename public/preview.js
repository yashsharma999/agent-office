/**
 * A live pixel preview of the agent being built.
 *
 * Shows the same isometric desk the room uses, so what you pick in the Foundry
 * is literally what appears at the desk afterwards - pick a Salvaged Terminal
 * and you watch the big monitor shrink to a beige CRT.
 *
 * The drawing primitives are a deliberate copy of the ones in scene.js rather
 * than a shared import. Extracting them would mean surgery on the room
 * renderer, which works; a hundred lines of duplication is the cheaper trade.
 */
import { drawDoll, lookFor } from './doll.js';

const BUF_W = 140, BUF_H = 116;
const TW = 20, TH = 10;
const OX = 62, OY = 46;

const C = {
  floorA: '#55607d', floorB: '#4e5872',
  deskTop: '#c9cdd8', deskL: '#9aa0b0', deskR: '#848a9c',
  metalTop: '#54596e', metalL: '#3b3f52', metalR: '#2f3243',
  screenOff: '#14161f',
  chairTop: '#3f4a63', chairL: '#323a4f', chairR: '#282f41',
  key: '#5a5a72',
};

/** Matches MONITORS in scene.js. */
const MONITORS = {
  crt:  { i0: 0.65, i1: 1.45, h: 15, stand: 4, second: false, tower: false },
  flat: { i0: 0.35, i1: 1.75, h: 21, stand: 7, second: false, tower: false },
  dual: { i0: 0.30, i1: 1.45, h: 22, stand: 7, second: true,  tower: true  },
};

export function createPreview(canvas) {
  const g = canvas.getContext('2d');
  canvas.width = BUF_W;
  canvas.height = BUF_H;

  const gp = (i, j) => [OX + (i - j) * (TW / 2), OY + (i + j) * (TH / 2)];
  const gpz = (i, j, z) => { const p = gp(i, j); return [p[0], p[1] - z]; };

  /** Crisp integer scanline polygon fill - no antialiasing. */
  function poly(pts, col) {
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    g.fillStyle = col;
    for (let y = Math.floor(minY); y < Math.ceil(maxY); y++) {
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

  const rect = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x | 0, y | 0, w | 0, h | 0); };

  function box(i, j, w, d, h, lift, cTop, cLeft, cRight) {
    const z = lift + h;
    poly([gpz(i + w, j, z), gpz(i + w, j + d, z), gpz(i + w, j + d, lift), gpz(i + w, j, lift)], cRight);
    poly([gpz(i, j + d, z), gpz(i + w, j + d, z), gpz(i + w, j + d, lift), gpz(i, j + d, lift)], cLeft);
    poly([gpz(i, j, z), gpz(i + w, j, z), gpz(i + w, j + d, z), gpz(i, j + d, z)], cTop);
  }

  const faceQuad = (i0, i1, jj, z0, z1, col) =>
    poly([gpz(i0, jj, z1), gpz(i1, jj, z1), gpz(i1, jj, z0), gpz(i0, jj, z0)], col);

  let t = 0;
  let spec = { colour: 'teal', rig: 'desk' };
  let raf = null;

  function drawFloor() {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        poly([gp(i, j), gp(i + 1, j), gp(i + 1, j + 1), gp(i, j + 1)], (i + j) % 2 ? C.floorA : C.floorB);
      }
    }
  }

  /**
   * Desk and computer, sitting on the LEFT of the platform.
   * The agent stands beside it rather than behind it: at this size a seated
   * pose puts the monitor directly on top of the head and reads as a hat.
   */
  function drawRig(shape, lit) {
    const deskH = 15, base = deskH + shape.stand, jj = 1.75;
    box(0.15, 0.7, 1.9, 1.05, deskH, 0, C.deskTop, C.deskL, C.deskR);

    box(0.95, 1.0, 0.4, 0.3, shape.stand, deskH, C.metalTop, C.metalL, C.metalR);
    box(shape.i0, 0.8, shape.i1 - shape.i0, 0.7, shape.h, base, C.metalTop, C.metalL, C.metalR);

    const z0 = base + 3.5, z1 = base + shape.h - 1.5;
    const s0 = shape.i0 + 0.12, s1 = shape.i1 - 0.12;
    faceQuad(s0, s1, jj, z0, z1, C.screenOff);
    if (lit) {
      // a hint of life so a working machine reads as switched on
      g.globalAlpha = 0.22;
      faceQuad(s0, s1, jj, z0, z1, '#6ee7d7');
      g.globalAlpha = 1;
      for (let n = 0; n < 4; n++) {
        const y = z0 + 3 + ((n * 4 + ((t / 6) | 0)) % (shape.h - 8));
        faceQuad(s0 + 0.1, s0 + 0.5 + (n % 2) * 0.4, jj, y, y + 1.4, '#6ee7d7');
      }
    }

    if (shape.second) {
      box(shape.i1 + 0.08, 0.85, 0.62, 0.6, shape.h - 5, base, C.metalTop, C.metalL, C.metalR);
      faceQuad(shape.i1 + 0.14, shape.i1 + 0.64, 1.45, base + 3, base + shape.h - 8, C.screenOff);
    }
    if (shape.tower) {
      const ti = 0.15, tj = 2.15;
      box(ti, tj, 0.7, 0.7, 24, 0, C.metalTop, C.metalL, C.metalR);
      const front = tj + 0.7;
      for (let v = 0; v < 5; v++) faceQuad(ti + 0.12, ti + 0.58, front, 4 + v * 2.2, 5 + v * 2.2, C.metalR);
      const blink = ((t / 14) | 0) % 3 !== 0;
      faceQuad(ti + 0.12, ti + 0.28, front, 18.5, 20.5, blink ? '#7ee787' : '#1d4425');
      faceQuad(ti + 0.36, ti + 0.5, front, 18.5, 20.5, '#ffd166');
    }

    // keyboard
    box(0.6, 1.42, 0.95, 0.28, 2, deskH, C.key, '#3a3a50', '#31314a');
  }

  /** The agent stands beside its rig, facing us, so the whole outfit shows. */
  function drawAgent() {
    const [cx, cy] = gp(2.85, 1.35);
    g.globalAlpha = 0.22;
    poly([gp(2.45, 1.0), gp(3.3, 1.0), gp(3.3, 1.75), gp(2.45, 1.75)], '#120e1f');
    g.globalAlpha = 1;
    const blink = ((t / 60) | 0) % 7 === 0;
    drawDoll(g, lookFor(spec), { x: cx, y: cy, scale: 1, view: 'front', pose: 'stand', blink });
  }

  function frame() {
    t++;
    const shape = MONITORS[spec.rig] ?? MONITORS.flat;
    g.clearRect(0, 0, BUF_W, BUF_H);
    drawFloor();
    // Painter's order: the desk is further back than the agent standing beside it.
    drawRig(shape, spec.rig !== 'tin');
    drawAgent();
  }

  function loop() {
    try { frame(); } catch (err) { console.error('preview failed:', err); }
    raf = requestAnimationFrame(loop);
  }

  return {
    set(next) { spec = { ...spec, ...next }; },
    start() { if (!raf) raf = requestAnimationFrame(loop); },
    stop() { if (raf) cancelAnimationFrame(raf); raf = null; },
  };
}
