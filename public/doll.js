/**
 * The paper doll: a chibi character built from swappable, recolourable layers.
 *
 * A doll is 24 pixels wide and 32 tall, big head on a small body. Hair, hats
 * and a few details are tiny pixel maps - one character per pixel, with a
 * legend that maps characters to the wearer's colours at draw time - so one
 * map serves every hair colour. The body, clothes, legs and face are drawn
 * from short descriptors, because rectangles are enough for them and it keeps
 * the wardrobe cheap to extend.
 *
 * Views: 'front' (face toward the camera) and 'back'. Poses: 'stand', 'walk'
 * (with a frame), 'sit' (legs hidden behind the desk). Arms have named poses
 * for the room's business: keys, reaching to a letterbox, a wall, a cup.
 *
 * `drawDoll` paints in the caller's pixel space: (x, y) is the feet-centre in
 * that space and `scale` is the size of one doll pixel. The room passes device
 * pixels; the portrait passes a 48x48 canvas.
 */

export const DOLL_W = 24;
export const DOLL_H = 32;

// -------------------------------------------------------------- palettes
export const SKIN_TONES = {
  porcelain: '#fbe6d3', peach: '#f6cba7', honey: '#e2a878', tan: '#c98a5b', bronze: '#a0663e', cocoa: '#6f4630',
};
export const HAIR_COLORS = {
  black: '#2a2430', brown: '#6b4a34', chestnut: '#8a5a3c', blonde: '#e9c46a', red: '#c8553d',
  grey: '#a9a9b8', white: '#f1efe8', pink: '#f28bb5', blue: '#5b8def', teal: '#4fc3b4', violet: '#a37fe0', mint: '#6fc177',
};
export const CLOTH_COLORS = {
  white: '#f1efe8', black: '#2a2430', grey: '#8a8a9a', navy: '#2f3d6b', denim: '#4a6fa5', red: '#d94a3d',
  orange: '#f0913d', yellow: '#f2c94c', green: '#4f9d69', teal: '#4fc3b4', blue: '#5b8def', violet: '#a37fe0',
  pink: '#f28bb5', rose: '#ff9db1', amber: '#ffc46b', mint: '#9ae6a0', brown: '#7a5236', olive: '#8a8f4a',
};
export const SHOE_COLORS = { white: '#f1efe8', black: '#2a2430', brown: '#7a5236', red: '#d94a3d', blue: '#5b8def' };

const OUTLINE = '#1a1522';
const EYE = '#2a2430';

/** Mix a hex colour toward white (k>0) or black (k<0). */
export function tint(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k))));
  return `#${((ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).padStart(6, '0')}`;
}

// -------------------------------------------------------------- wardrobe
/**
 * Pixel maps. 24 columns; row 0 is the top of the doll. Legend:
 *   .  nothing        #  outline
 *   h  hair           H  hair shade      L  hair light
 *   a  hat            A  hat shade       W  hat white
 */
const HAIR = {
  bob: {
    label: 'Bob',
    front: [
      '........########........',
      '......##hhhhhhhh##......',
      '.....#hhhhLLhhhhhh#.....',
      '....#hhhLLhhhhhhhhh#....',
      '...#hhhhLhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhh##hhhh#...',
      '...#hhhh#####..##hhh#...',
      '...#hhh#.........#hh#...',
      '...#hh#...........#h#...',
      '...#hh#...........#h#...',
      '...#hh#...........#h#...',
      '...#hH#...........#H#...',
      '...#HH#...........#H#...',
      '....##.............##...',
    ],
    back: [
      '........########........',
      '......##hhhhhhhh##......',
      '.....#hhhhhhhhhhhh#.....',
      '....#hhhLhhhhhhhhhh#....',
      '...#hhhhLhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hHhhhhhhhhhhhhHh#...',
      '...#HHHHHHHHHHHHHHHH#...',
      '...##HHHHHHHHHHHHHH##...',
      '....################....',
    ],
  },
  short: {
    label: 'Short',
    front: [
      '.......##########.......',
      '.....##hhhhhhhhhh##.....',
      '....#hhhhLLhhhhhhhh#....',
      '...#hhhhLLhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhh#hhhh#hhhhh#...',
      '...#hhh##.####.##hhh#...',
      '...#hh#.........#hhh#...',
      '....##...........#hh#...',
      '..................##....',
    ],
    back: [
      '.......##########.......',
      '.....##hhhhhhhhhh##.....',
      '....#hhhhhhhhhhhhhh#....',
      '...#hhhhLhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hHhhhhhhhhhhhhHh#...',
      '...##HHHHHHHHHHHHHH##...',
      '....###HHHHHHHHHH###....',
      '.......##########.......',
    ],
  },
  spiky: {
    label: 'Spiky',
    front: [
      '.....#....##....#.......',
      '....#h#..#hh#..#h#..#...',
      '...#hhh##hhhh##hhh##h#..',
      '...#hhhhhhhhhhhhhhhhh#..',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#HHHHHHHHHHHHHHHH#...',
      '...#hh#...........#h#...',
      '....##.............##...',
    ],
    back: [
      '.....#....##....#.......',
      '....#h#..#hh#..#h#..#...',
      '...#hhh##hhhh##hhh##h#..',
      '...#hhhhhhhhhhhhhhhhh#..',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#HHHHHHHHHHHHHHHH#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hHhhhhhhhhhhhhHh#...',
      '...##HHHHHHHHHHHHHH##...',
      '....###HHHHHHHHHH###....',
      '.......##########.......',
    ],
  },
  long: {
    label: 'Long',
    front: [
      '........########........',
      '......##hhhhhhhh##......',
      '.....#hhhhLLhhhhhh#.....',
      '....#hhhLLhhhhhhhhh#....',
      '...#hhhhLhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhh##hhhhhhh#...',
      '...#hhhh###..###hhhh#...',
      '...#hhh#.......#hhhh#...',
      '...#hh#.........#hhh#...',
      '...#hh#.........#hhh#...',
      '...#hh#.........#hhh#...',
      '...#hh#.........#hhh#...',
      '...#hh#.........#hhh#...',
      '...#hh#.........#hhh#...',
      '...#hh#.........#hhh#...',
      '..#hhh#.........#hhhh#..',
      '..#hhh#.........#hhhh#..',
      '..#hHh#.........#hhHh#..',
      '..#HHH#.........#HHHH#..',
      '...###...........####...',
    ],
    back: [
      '........########........',
      '......##hhhhhhhh##......',
      '.....#hhhhhhhhhhhh#.....',
      '....#hhhLhhhhhhhhhh#....',
      '...#hhhhLhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '..#hhhhhhhhhhhhhhhhhh#..',
      '..#hhhhhhhhhhhhhhhhhh#..',
      '..#hHhhhhhhhhhhhhhhHh#..',
      '..#HHHHHHHHHHHHHHHHHH#..',
      '...##################...',
    ],
  },
  ponytail: {
    label: 'Ponytail', sways: true,
    front: [
      '........########........',
      '......##hhhhhhhh##......',
      '.....#hhhhLLhhhhhh#.....',
      '....#hhhLLhhhhhhhhh#....',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhh###########hh##..',
      '...#hh#...........#hh#..',
      '....##.............#h#..',
      '....................#h#.',
      '....................#h#.',
      '....................#h#.',
      '....................#H#.',
      '.....................#..',
    ],
    back: [
      '........########........',
      '......##hhhhhhhh##......',
      '.....#hhhhhhhhhhhh#.....',
      '....#hhhLhhhhhhhhhh#....',
      '...#hhhhLhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...##hhhhhhhhhhhhhh##...',
      '....####HHHHHH####......',
      '........#hhhh#..........',
      '........#hhhh#..........',
      '........#hhhh#..........',
      '........#hhhh#..........',
      '........#hhhh#..........',
      '........#hhhh#..........',
      '........#hhhh#..........',
      '........#hhhh#..........',
      '........#hHHh#..........',
      '.........#HH#...........',
      '..........##............',
    ],
  },
  curly: {
    label: 'Curly',
    front: [
      '......##.####.##........',
      '.....#hh#hhhh#hh#.......',
      '....#hhhhhhhhhhhh#.##...',
      '...#hhhhhhhhhhhhhh#hh#..',
      '..##hhhhLhhhhhhhhhhhh#..',
      '..#hhhhhhhhhhhhhhhhhh#..',
      '..#hhhh#hhhhh#hhhhhhh#..',
      '..#hh##.#####.###hhhh#..',
      '..#hh#..........#hhh#...',
      '..##h#..........#hh#....',
      '...##............##.....',
    ],
    back: [
      '......##.####.##........',
      '.....#hh#hhhh#hh#.......',
      '....#hhhhhhhhhhhh#.##...',
      '...#hhhhhhhhhhhhhh#hh#..',
      '..##hhhhLhhhhhhhhhhhh#..',
      '..#hhhhhhhhhhhhhhhhhh#..',
      '..#hhhhhhhhhhhhhhhhhh#..',
      '..#hhhhhhhhhhhhhhhhhh#..',
      '..#hhhhhhhhhhhhhhhhhh#..',
      '..##hhhhhhhhhhhhhhhh##..',
      '...#hHhhhhhhhhhhhhHh#...',
      '...##HHHHHHHHHHHHHH##...',
      '....###HHHHHHHHHH###....',
      '.......##########.......',
    ],
  },
  buzz: {
    label: 'Buzz',
    front: [
      '........########........',
      '......##HHHHHHHH##......',
      '.....#HHHHHHHHHHHH#.....',
      '....#HHHHHHHHHHHHHH#....',
      '...#HhhhhhhhhhhhhhhH#...',
      '...##..............##...',
    ],
    back: [
      '........########........',
      '......##HHHHHHHH##......',
      '.....#HHHHHHHHHHHH#.....',
      '....#HHHHHHHHHHHHHH#....',
      '...#HhhhhhhhhhhhhhhH#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...#hhhhhhhhhhhhhhhh#...',
      '...##HHHHHHHHHHHHHH##...',
      '....################....',
    ],
  },
};

const HAT = {
  none: { label: 'None' },
  cap: {
    label: 'Cap',
    front: [
      '.......#########........',
      '.....##aaaaaaaaa##......',
      '....#aaaaaaaaaaaaa#.....',
      '...#aaaaaaaaaaaaaaa#....',
      '...#aaaaaaaaaaaaaaa#....',
      '...#AAAAAAAAAAAAAAA#....',
      '..#AAAAAAAAAAAAAAAAAAA#.',
      '...####################.',
    ],
    back: [
      '.......#########........',
      '.....##aaaaaaaaa##......',
      '....#aaaaaaaaaaaaa#.....',
      '...#aaaaaaaaaaaaaaa#....',
      '...#aaaaaaaaaaaaaaa#....',
      '...#AAAAAAAAAAAAAAA#....',
      '...#AAAAAAA##AAAAAA#....',
      '....###############.....',
    ],
  },
  beanie: {
    label: 'Beanie',
    front: [
      '..........#W#...........',
      '.......###aaa###........',
      '.....##aaaaaaaaaa#......',
      '....#aaaaaaaaaaaaa#.....',
      '...#aaaaaaaaaaaaaaa#....',
      '...#aaaaaaaaaaaaaaa#....',
      '...#AAAAAAAAAAAAAAA#....',
      '...#AAAAAAAAAAAAAAA#....',
      '....###############.....',
    ],
    back: null,   // same as the front
  },
  headphones: {
    label: 'Headphones',
    front: [
      '.......##########.......',
      '.....##aaaaaaaaaa##.....',
      '....#aa##########aa#....',
      '...#aa#..........#aa#...',
      '...#a#............#a#...',
      '..##a##..........##a##..',
      '..#aaa#..........#aaa#..',
      '..#aAa#..........#aAa#..',
      '..#aAa#..........#aAa#..',
      '..#aaa#..........#aaa#..',
      '..#####..........#####..',
    ],
    back: null,
  },
  beret: {
    label: 'Beret',
    front: [
      '...........##...........',
      '.......####aa####.......',
      '....###aaaaaaaaaaa###...',
      '..##aaaaaaaaaaaaaaaaa##.',
      '..#AAAAAAAAAAAAAAAAAAA#.',
      '...###AAAAAAAAAAAAA###..',
      '......#############.....',
    ],
    back: null,
  },
};

const GLASSES = { none: 'None', round: 'Round', square: 'Square', shades: 'Shades' };
const TOPS = { tee: 'T-shirt', shirt: 'Shirt', sweater: 'Sweater', hoodie: 'Hoodie', jacket: 'Jacket' };
const BOTTOMS = { jeans: 'Jeans', shorts: 'Shorts', skirt: 'Skirt' };
const SHOES = { sneakers: 'Sneakers', boots: 'Boots' };

/** What the wardrobe offers, per slot, for the editor to draw. */
export const CATALOG = {
  skin: Object.fromEntries(Object.entries(SKIN_TONES).map(([k, v]) => [k, { label: k, swatch: v }])),
  hair: Object.fromEntries(Object.entries(HAIR).map(([k, v]) => [k, { label: v.label }])),
  hairColor: Object.fromEntries(Object.entries(HAIR_COLORS).map(([k, v]) => [k, { label: k, swatch: v }])),
  top: Object.fromEntries(Object.entries(TOPS).map(([k, v]) => [k, { label: v }])),
  topColor: Object.fromEntries(Object.entries(CLOTH_COLORS).map(([k, v]) => [k, { label: k, swatch: v }])),
  bottom: Object.fromEntries(Object.entries(BOTTOMS).map(([k, v]) => [k, { label: v }])),
  bottomColor: Object.fromEntries(Object.entries(CLOTH_COLORS).map(([k, v]) => [k, { label: k, swatch: v }])),
  shoes: Object.fromEntries(Object.entries(SHOES).map(([k, v]) => [k, { label: v }])),
  shoeColor: Object.fromEntries(Object.entries(SHOE_COLORS).map(([k, v]) => [k, { label: k, swatch: v }])),
  hat: Object.fromEntries(Object.entries(HAT).map(([k, v]) => [k, { label: v.label }])),
  hatColor: Object.fromEntries(Object.entries(CLOTH_COLORS).map(([k, v]) => [k, { label: k, swatch: v }])),
  glasses: Object.fromEntries(Object.entries(GLASSES).map(([k, v]) => [k, { label: v }])),
};

export const LOOK_DEFAULT = {
  skin: 'peach', hair: 'short', hairColor: 'brown', top: 'tee', topColor: 'teal',
  bottom: 'jeans', bottomColor: 'navy', shoes: 'sneakers', shoeColor: 'white',
  hat: 'none', hatColor: 'red', glasses: 'none',
};

/**
 * A complete look for an agent. Agents built before the wardrobe existed have
 * only a colour; it becomes their hair and their top, and the name picks a
 * hairstyle, so the same agent always looks the same.
 */
export function lookFor(agent = {}) {
  const base = { ...LOOK_DEFAULT };
  if (agent.colour) {
    const HAIR_FOR = { teal: 'teal', amber: 'blonde', violet: 'violet', rose: 'pink', mint: 'mint' };
    base.hairColor = HAIR_FOR[agent.colour] ?? base.hairColor;
    base.topColor = CLOTH_COLORS[agent.colour] ? agent.colour : base.topColor;
    const styles = Object.keys(HAIR);
    let h = 0; for (const c of String(agent.name ?? '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    base.hair = styles[h % styles.length];
  }
  const look = { ...base, ...(agent.look ?? {}) };
  for (const k of Object.keys(look)) if (!CATALOG[k]?.[look[k]]) look[k] = base[k];
  return look;
}

// -------------------------------------------------------------- drawing
/** Colours for the legend, from a look. */
function palette(look) {
  const skin = SKIN_TONES[look.skin], hair = HAIR_COLORS[look.hairColor];
  const top = CLOTH_COLORS[look.topColor], pants = CLOTH_COLORS[look.bottomColor];
  const shoe = SHOE_COLORS[look.shoeColor], hat = CLOTH_COLORS[look.hatColor];
  return {
    '#': OUTLINE,
    h: hair, H: tint(hair, -0.28), L: tint(hair, 0.32),
    a: hat, A: tint(hat, -0.28), W: '#f1efe8',
    skin, skinShade: tint(skin, -0.16),
    top, topShade: tint(top, -0.25), topLight: tint(top, 0.5),
    pants, pantsShade: tint(pants, -0.25),
    shoe, shoeShade: tint(shoe, -0.3), sole: '#f1efe8',
  };
}

/**
 * @param ctx      2D context
 * @param look     from lookFor()
 * @param x, y     feet-centre, in ctx pixels
 * @param scale    ctx pixels per doll pixel
 * @param view     'front' | 'back'
 * @param pose     'stand' | 'walk' | 'sit'
 * @param frame    walk frame, any integer
 * @param arms     'down' | 'keys' | 'up-right' | 'up-left' | 'cup' | 'stretch' | 'sip' | 'lap'
 * @param mood     'thinking' | 'tool' | 'done' | 'error' | null
 * @param blink    boolean
 * @param asleep   boolean (closed eyes, front only)
 * @param crop     'head' to draw only the head (portraits)
 */
export function drawDoll(ctx, look, {
  x, y, scale = 1, view = 'front', pose = 'stand', frame = 0, arms = 'down',
  mood = null, blink = false, asleep = false, crop = null, sway = 0,
} = {}) {
  const P = palette(look);
  const ox = x - 12 * scale;                 // doll column 0
  const oy = y - DOLL_H * scale;             // doll row 0
  const px = (c, r, w = 1, h = 1, col) => {
    if (!col) return;
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(ox + c * scale), Math.round(oy + r * scale), Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  };
  /** Paints a map; rows from `swayFrom` down are shifted by `sway` (loose hair). */
  const map = (rows, dr = 0, dc = 0, swayFrom = Infinity, swayBy = 0) => {
    if (!rows) return;
    rows.forEach((row, r) => {
      const shift = r >= swayFrom ? swayBy : 0;
      for (let c = 0; c < row.length; c++) {
        const ch = row[c];
        if (ch === '.') continue;
        px(c + dc + shift, r + dr, 1, 1, P[ch] ?? OUTLINE);
      }
    });
  };
  const front = view === 'front';
  const step = pose === 'walk' ? ((frame | 0) % 2) : 0;   // which leg is forward
  const bob = pose === 'walk' && step ? 1 : 0;
  const headOnly = crop === 'head';

  // ---- legs (standing / walking): rows 26-31
  if (pose !== 'sit' && !headOnly) {
    const lUp = step ? 1 : 0, rUp = step ? 0 : 1;   // the raised leg is 1px shorter
    const legs = [[8, lUp], [12, rUp]];
    for (const [c, up] of legs) {
      // outline column, pants, shoe
      px(c - 1, 26 - bob, 6, 6 - up, OUTLINE);
      const pantsRows = look.bottom === 'shorts' ? 2 : look.bottom === 'skirt' ? 1 : 4;
      px(c, 26 - bob, 4, pantsRows, P.pants);
      px(c + 3, 26 - bob, 1, pantsRows, P.pantsShade);
      if (pantsRows < 4) px(c, 26 - bob + pantsRows, 4, 4 - pantsRows, P.skin);
      if (look.shoes === 'boots') { px(c, 28 - bob, 4, 3 - up, P.shoe); px(c + 3, 28 - bob, 1, 3 - up, P.shoeShade); }
      px(c - 0.5, 30 - bob - up, 5, 2, P.shoe);
      px(c - 0.5, 31 - bob - up, 5, 1, look.shoes === 'boots' ? P.shoeShade : P.sole);
    }
    if (look.bottom === 'skirt') { px(6, 25 - bob, 12, 1, OUTLINE); px(7, 26 - bob, 10, 2, P.pants); px(7, 28 - bob, 10, 1, P.pantsShade); px(6, 26 - bob, 1, 3, OUTLINE); px(17, 26 - bob, 1, 3, OUTLINE); }
  }

  // ---- body: neck + torso, rows 16-25 (sitting keeps them; the desk hides the rest)
  const by = -bob;
  if (!headOnly) {
    px(9, 16 + by, 6, 1, OUTLINE); px(10, 16 + by, 4, 1, P.skinShade);           // neck
    px(6, 17 + by, 12, 9, OUTLINE);                                              // torso outline
    px(7, 17 + by, 10, 8, P.top);
    px(15, 17 + by, 2, 8, P.topShade);
    if (look.top === 'hoodie') {
      if (front) { px(10, 18 + by, 1, 3, P.topLight); px(13, 18 + by, 1, 3, P.topLight); px(8, 22 + by, 8, 3, P.topShade); px(8, 22 + by, 8, 1, OUTLINE); }
      else { px(7, 15 + by, 10, 1, OUTLINE); px(8, 16 + by, 8, 3, P.topShade); px(7, 16 + by, 1, 3, OUTLINE); px(16, 16 + by, 1, 3, OUTLINE); }
    } else if (look.top === 'jacket') {
      if (front) { px(10, 17 + by, 4, 8, P.topLight); px(9, 17 + by, 1, 2, P.topShade); px(14, 17 + by, 1, 2, P.topShade); px(11, 20 + by, 2, 1, tint(P.topLight, -0.3)); }
    } else if (look.top === 'shirt') {
      if (front) {
        px(9, 17 + by, 2, 1, P.topLight); px(13, 17 + by, 2, 1, P.topLight); px(11, 17 + by, 2, 2, P.skinShade);   // collar
        px(11, 19 + by, 1, 1, P.topLight); px(11, 21 + by, 1, 1, P.topLight); px(11, 23 + by, 1, 1, P.topLight);   // buttons
      }
    } else if (look.top === 'sweater') {
      px(7, 20 + by, 10, 1, P.topLight);                       // a stripe across the chest, both sides
      px(7, 24 + by, 10, 1, P.topShade);                       // ribbed hem
    } else if (front) {
      px(11, 17 + by, 2, 1, P.skinShade);   // tee collar
    }
    // arms
    const sleeve = look.top === 'tee' || look.top === 'shirt' ? 3 : 7;
    const armAt = (c, r, len, swing = 0) => {
      px(c - 1, r + swing, 4, len + 3, OUTLINE);
      px(c, r + swing, 2, Math.min(sleeve, len), P.top);
      if (len > sleeve) px(c, r + sleeve + swing, 2, len - sleeve, P.skin);
      px(c, r + len + swing, 2, 2, P.skin);            // hand
    };
    const swingL = pose === 'walk' ? (step ? 1 : -1) : 0, swingR = -swingL;
    if (pose === 'sit' && (arms === 'keys' || arms === 'lap')) {
      // forearms go forward, out of sight; shoulders only
      px(4, 17 + by, 3, 5, OUTLINE); px(5, 17 + by, 2, 4, P.top);
      px(17, 17 + by, 3, 5, OUTLINE); px(17, 17 + by, 2, 4, P.top); px(19, 17 + by, 1, 5, OUTLINE);
    } else if (arms === 'stretch') {
      for (const c of [4, 18]) { px(c - 1, 6 + by, 4, 14, OUTLINE); px(c, 7 + by, 2, 8, P.top); px(c, 15 + by, 2, 4, P.skin); px(c, 5 + by, 2, 2, P.skin); }
    } else if (arms === 'up-right' || arms === 'cup' || arms === 'sip') {
      armAt(4, 17 + by, 6, swingL);
      px(17, 8 + by, 4, 12, OUTLINE); px(18, 9 + by, 2, 6, P.top); px(18, 15 + by, 2, 4, P.skin); px(18, 7 + by, 2, 2, P.skin);
      if (arms === 'cup' || arms === 'sip') { px(17, 5 + by, 4, 3, OUTLINE); px(18, 6 + by, 2, 2, arms === 'cup' ? '#f1efe8' : '#d94a3d'); }
    } else if (arms === 'up-left') {
      px(3, 8 + by, 4, 12, OUTLINE); px(4, 9 + by, 2, 6, P.top); px(4, 15 + by, 2, 4, P.skin); px(4, 7 + by, 2, 2, P.skin);
      armAt(18, 17 + by, 6, swingR);
    } else {
      armAt(4, 17 + by, 6, swingL);
      armAt(18, 17 + by, 6, swingR);
    }
  }

  // ---- head: rows 1-15, a rounded 18-wide block
  const hy = by;
  const headRows = [];
  for (let r = 1; r <= 15; r++) {
    const inset = (r === 1 || r === 15) ? 3 : (r === 2 || r === 14) ? 1 : 0;
    headRows.push([3 + inset, 20 - inset]);
  }
  headRows.forEach(([c0, c1], i) => {
    const r = i + 1 + hy;
    px(c0, r, c1 - c0 + 1, 1, OUTLINE);
    px(c0 + 1, r, c1 - c0 - 1, 1, P.skin);
  });
  // rounded corners inside the outline
  px(4, 2 + hy, 1, 1, OUTLINE); px(19, 2 + hy, 1, 1, OUTLINE); px(4, 14 + hy, 1, 1, OUTLINE); px(19, 14 + hy, 1, 1, OUTLINE);
  // jaw shade
  px(5, 14 + hy, 14, 1, P.skinShade); px(7, 15 + hy, 10, 1, P.skinShade);
  px(19, 4 + hy, 1, 10, P.skinShade);

  if (front) {
    // face: eyes, a small mouth, cheeks
    if (asleep) { px(8, 11 + hy, 3, 1, EYE); px(13, 11 + hy, 3, 1, EYE); }
    else if (blink) { px(8, 11 + hy, 3, 1, EYE); px(13, 11 + hy, 3, 1, EYE); }
    else {
      px(8, 9 + hy, 3, 3, EYE); px(13, 9 + hy, 3, 3, EYE);
      px(8, 9 + hy, 1, 1, '#ffffff'); px(13, 9 + hy, 1, 1, '#ffffff');
      if (mood === 'thinking') { px(8, 8 + hy, 3, 1, OUTLINE); px(13, 7 + hy, 3, 1, OUTLINE); }
      if (mood === 'error') { px(8, 7 + hy, 3, 1, OUTLINE); px(13, 7 + hy, 3, 1, OUTLINE); }
    }
    px(6, 12 + hy, 1, 1, tint(P.skin, -0.12)); px(17, 12 + hy, 1, 1, tint(P.skin, -0.12));   // cheeks
    if (mood === 'done') { px(10, 13 + hy, 4, 1, EYE); px(9, 12 + hy, 1, 1, EYE); px(14, 12 + hy, 1, 1, EYE); }
    else if (mood === 'error') { px(10, 13 + hy, 4, 1, EYE); px(9, 14 + hy, 1, 1, EYE); px(14, 14 + hy, 1, 1, EYE); }
    else if (!asleep) px(11, 13 + hy, 2, 1, tint(P.skin, -0.35));
  } else {
    // back of the head: no face, an ear each side
    px(3, 8 + hy, 1, 3, OUTLINE); px(20, 8 + hy, 1, 3, OUTLINE);
  }

  // ---- hair, then glasses, then hat
  const style = HAIR[look.hair] ?? HAIR.short;
  map(front ? style.front : style.back, hy, 0, style.sways ? 9 : Infinity, Math.max(-1, Math.min(1, Math.round(sway))));
  if (front && look.glasses !== 'none') {
    const g = tint(OUTLINE, 0.35), lens = 'rgba(200,220,255,0.28)';
    if (look.glasses === 'shades') {
      const dark = 'rgba(26,21,34,0.88)';
      px(6, 8 + hy, 12, 1, g); px(6, 9 + hy, 5, 3, dark); px(13, 9 + hy, 5, 3, dark); px(11, 9 + hy, 2, 1, g);
      px(7, 9 + hy, 1, 1, 'rgba(255,255,255,0.35)'); px(14, 9 + hy, 1, 1, 'rgba(255,255,255,0.35)');
    } else if (look.glasses === 'round') {
      for (const c of [7, 12]) { px(c, 8 + hy, 5, 1, g); px(c, 12 + hy, 5, 1, g); px(c - 1, 9 + hy, 1, 3, g); px(c + 5, 9 + hy, 1, 3, g); px(c, 9 + hy, 5, 3, lens); }
      px(12, 10 + hy, 1, 1, g);
    } else {
      for (const c of [7, 13]) { px(c, 8 + hy, 5, 1, g); px(c, 12 + hy, 5, 1, g); px(c, 9 + hy, 1, 3, g); px(c + 4, 9 + hy, 1, 3, g); px(c + 1, 9 + hy, 3, 3, lens); }
      px(12, 10 + hy, 1, 1, g);
    }
  }
  if (look.hat !== 'none') {
    const hat = HAT[look.hat];
    map((front ? hat.front : (hat.back ?? hat.front)), hy);
  }
}

/** A head-and-shoulders portrait into a small square canvas. */
export function drawPortrait(ctx, look, { mood = null, size = 48 } = {}) {
  ctx.clearRect(0, 0, size, size);
  const scale = size / 22;     // 22 doll pixels across the square: the head plus a little
  // feet-centre placed so rows 0..21 fill the canvas
  drawDoll(ctx, look, { x: size / 2, y: (DOLL_H - 0) * scale, scale, view: 'front', pose: 'stand', mood });
}
