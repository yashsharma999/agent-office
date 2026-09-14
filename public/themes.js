/**
 * Room themes.
 *
 * A theme is pure data: a palette plus a few decor selectors. `scene.js`
 * reads the active theme rather than hard-coding colours, so adding a new
 * look means adding an entry here - no drawing code changes.
 *
 * Agent body colours deliberately live OUTSIDE the theme: an agent's colour
 * is its identity, and it should stay recognisable in every room.
 */

/**
 * Agent colours, keyed by the colour id the user picks in the Foundry.
 * The ids must match SKINS in src/rigs.js, which is what validates them.
 * The extra shades live here because only the renderer needs them.
 */
export const AGENT_SKINS = {
  teal:   { body: '#6ee7d7', mid: '#4fc3b4', dark: '#2b7a70', eye: '#0d2b28' },
  amber:  { body: '#ffc46b', mid: '#dfa049', dark: '#8f6224', eye: '#3a2408' },
  violet: { body: '#c9a6ff', mid: '#a37fe0', dark: '#5f3f96', eye: '#241436' },
  rose:   { body: '#ff9db1', mid: '#e0798f', dark: '#93475a', eye: '#3a1420' },
  mint:   { body: '#9ae6a0', mid: '#6fc177', dark: '#3d7a45', eye: '#122d16' },
};

export const THEMES = {
  /** Open-plan office. Corporate greys and blues, daylight, whiteboard. */
  office: {
    label: 'Office',
    windowStyle: 'city-day',
    leftWall: 'whiteboard',
    floorStyle: 'carpet',
    extras: ['cooler', 'corner-plant'],
    palette: {
      wallL: '#4a5570', wallR: '#3d4760', wallTrim: '#2b3347',
      floorA: '#55607d', floorB: '#4e5872', floorEdge: '#3f4860',
      rugA: '#3f5d72', rugB: '#375265',

      deskTop: '#c9cdd8', deskL: '#9aa0b0', deskR: '#848a9c',
      metalTop: '#54596e', metalL: '#3b3f52', metalR: '#2f3243',
      screenOff: '#14161f',
      chairTop: '#3f4a63', chairL: '#323a4f', chairR: '#282f41',

      potTop: '#b98a5e', potL: '#9a7049', potR: '#7f5c3b',
      leaf: '#5fae7c', leafD: '#43855c',

      sky: '#8fc4e8', skyLow: '#c9e2f2', building: '#6d7f99', buildingLit: '#ffe9a8',
      frame: '#e3e7ef', paper: '#f2f2ea', mug: '#4f7fbf', shelf: '#9aa0b0',
      accent: '#7fd7ff',
    },
  },

  /** The original cosy night room. */
  home: {
    label: 'Home',
    windowStyle: 'night',
    leftWall: 'poster-shelf',
    floorStyle: 'wood',
    extras: ['plant', 'corner-plant'],
    palette: {
      wallL: '#3a2f57', wallR: '#2e2646', wallTrim: '#241d3a',
      floorA: '#5a4574', floorB: '#523e6b', floorEdge: '#42315a',
      rugA: '#3f6b64', rugB: '#356059',

      deskTop: '#8a6547', deskL: '#6b4c34', deskR: '#5a3f2b',
      metalTop: '#4a4a60', metalL: '#33334a', metalR: '#292939',
      screenOff: '#14141f',
      chairTop: '#5a3f70', chairL: '#432d55', chairR: '#372446',

      potTop: '#c9765a', potL: '#a85843', potR: '#8e4936',
      leaf: '#4caf7d', leafD: '#35805b',

      sky: '#141f4d', skyLow: '#141f4d', building: '#cfd8ff', buildingLit: '#ffe9a8',
      frame: '#584a7d', paper: '#e8e4d0', mug: '#d05a5a', shelf: '#6b4c34',
      accent: '#b892ff',
    },
  },

  /** Neon arcade after hours. */
  arcade: {
    label: 'Arcade',
    windowStyle: 'neon',
    leftWall: 'neon-sign',
    floorStyle: 'checker',
    extras: ['corner-plant', 'plant'],
    palette: {
      wallL: '#241040', wallR: '#1b0c31', wallTrim: '#12081f',
      floorA: '#2b1150', floorB: '#1d0b38', floorEdge: '#3a1a63',
      rugA: '#4a1470', rugB: '#3a0f5c',

      deskTop: '#5c3691', deskL: '#42246b', deskR: '#331a54',
      metalTop: '#5a3a80', metalL: '#3d2359', metalR: '#2c1842',
      screenOff: '#0f0a1a',
      chairTop: '#8a2a9e', chairL: '#6a1f7a', chairR: '#4e1459',

      potTop: '#ff5db1', potL: '#cc4a8e', potR: '#a33a72',
      leaf: '#3ff5c0', leafD: '#22b78e',

      sky: '#0a0618', skyLow: '#180a33', building: '#ff5db1', buildingLit: '#3ff5c0',
      frame: '#ff5db1', paper: '#f0e6ff', mug: '#3ff5c0', shelf: '#6a1f7a',
      accent: '#ff5db1',
    },
  },
};

export const DEFAULT_THEME = 'office';
export const themeNames = () => Object.keys(THEMES);
