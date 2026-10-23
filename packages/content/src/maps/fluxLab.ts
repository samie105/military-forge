import { Material, type MapDef, type MapPolygon } from './types';

/**
 * Demo map (docs/02 §20): a physics lab where the building messes with you. Jump pads up to the
 * catwalks, boost pads that throw you at the updraft shaft (long flight, wind blowing up), an EMP
 * field over the east deck, and events: a gravity surge, low gravity, and gravity pockets that open
 * over one of the two catwalks.
 *
 *   catwalk (pocket site) · upper deck + gantry · (open) · upper deck (EMP) + gantry · catwalk (pocket site)
 *   pad ·   boost →   ·   UPDRAFT SHAFT   ·   ← boost   · pad
 */

const WIDTH = 110;
const FLOOR_BOTTOM = -6;
const CEILING = 36;

function rect(x0: number, y0: number, x1: number, y1: number, material: Material = Material.Metal): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1], material };
}

export const fluxLabMap: MapDef = {
  id: 'flux-lab',
  name: 'Flux Lab',
  bounds: { minX: -2, minY: FLOOR_BOTTOM, maxX: WIDTH + 2, maxY: CEILING + 2 },
  solids: [
    rect(-2, FLOOR_BOTTOM, WIDTH + 2, 0, Material.Concrete),
    rect(-2, 0, 0, CEILING, Material.Concrete),
    rect(WIDTH, 0, WIDTH + 2, CEILING, Material.Concrete),
    rect(-2, CEILING, WIDTH + 2, CEILING + 2, Material.Concrete),
    // upper decks either side of the shaft, the top gantry over them (open above the shaft)
    rect(30, 16, 46, 16.6),
    rect(64, 16, 80, 16.6),
    rect(36, 26, 47, 26.6),
    rect(63, 26, 74, 26.6),
    // shaft walls (gaps at the bottom to run in, open at the top)
    rect(48, 3, 49, 22),
    rect(61, 3, 62, 22),
    // crates
    rect(22, 0, 24, 1.2, Material.Wood),
    rect(86, 0, 88, 1.2, Material.Wood),
  ],
  oneWays: [
    { ax: 4, ay: 7, bx: 24, by: 7, blocksBullets: true },
    { ax: 86, ay: 7, bx: 106, by: 7, blocksBullets: true },
  ],
  spawns: [
    { x: 4, y: 0 },
    { x: 18, y: 0 },
    { x: 36, y: 0 },
    { x: 55, y: 0 },
    { x: 74, y: 0 },
    { x: 92, y: 0 },
    { x: 106, y: 0 },
    { x: 8, y: 7 },
    { x: 102, y: 7 },
    { x: 34, y: 16.6 },
    { x: 76, y: 16.6 },
    { x: 40, y: 26.6 },
    { x: 70, y: 26.6 },
  ],
  dummies: [
    { name: 'Pad rider', x: 13.5, y: 0, script: { kind: 'idle' } },
    { name: 'Shaft flyer', x: 55, y: 0, script: { kind: 'jet', periodTicks: 240, burstTicks: 30 } },
    { name: 'Deck guard', x: 72, y: 16.6, script: { kind: 'strafe', minX: 66, maxX: 78 } },
    { name: 'Runner', x: 40, y: 0, script: { kind: 'strafe', minX: 34, maxX: 46 } },
  ],
  // the test armory's rack (GameOptions.armory): one of every gun, by the spawn at x 74
  armory: { x: 63, y: 1.5, dir: 1 },
  // grenade pairs (then weapon crates) on the crates by the jump pads and at the gantries' shaft ends
  spawners: [
    {
      id: 'grenades',
      pool: 'grenades',
      spots: [
        { x: 23, y: 1.2 },
        { x: 87, y: 1.2 },
        { x: 46.4, y: 26.6 },
        { x: 63.6, y: 26.6 },
      ],
      first: [5, 9],
      respawn: [18, 24],
      maxActive: 2,
    },
    // weapon crates: a random gun (owner: "more guns"), on the catwalks, by the west boost pad and on the west deck
    {
      id: 'weapons',
      pool: 'weapons',
      spots: [
        { x: 20, y: 7 },
        { x: 90, y: 7 },
        { x: 26.5, y: 0 },
        { x: 42, y: 16.6 },
      ],
      first: [3, 6],
      respawn: [12, 18],
      maxActive: 2,
    },
  ],
  labels: [
    { x: 55, y: 23, text: 'updraft shaft' },
    { x: 72, y: 21, text: 'EMP field' },
    { x: 13.5, y: 2, text: 'jump pad' },
    { x: 96.5, y: 2, text: 'jump pad' },
  ],
  zones: [
    // 17.5 m/s: a 7.8 m apex, onto the 7 m catwalks above (the default 16 peaks at 6.6 m)
    { id: 'pad-west', kind: 'jumpPad', rect: [12, 0, 15, 1.2], launch: [0, 17.5] },
    { id: 'pad-east', kind: 'jumpPad', rect: [95, 0, 98, 1.2], launch: [0, 17.5] },
    { id: 'boost-west', kind: 'boostPad', rect: [30, 0, 32, 1.2], label: 'boost →' },
    { id: 'boost-east', kind: 'boostPad', rect: [78, 0, 80, 1.2], launch: [-16, 9], label: '← boost' },
    { id: 'updraft', kind: 'longFlight', rect: [49, 0, 61, 34], wind: [0, 9], label: 'updraft' },
    { id: 'emp-deck', kind: 'emp', rect: [64, 16.6, 80, 24], label: 'EMP field' },
    { id: 'pocket-west', kind: 'reverseG', rect: [4, 7.5, 24, 15], event: 'pocket', label: 'gravity pocket' },
    { id: 'pocket-east', kind: 'reverseG', rect: [86, 7.5, 106, 15], event: 'pocket', label: 'gravity pocket' },
  ],
  events: {
    defs: [
      { id: 'pocket', kind: 'flip', name: 'GRAVITY POCKET', description: 'Gravity flips over a catwalk: watch the marked zone' },
      { id: 'surge', kind: 'gravitySurge' },
      { id: 'floaty', kind: 'lowGravity', name: 'CONTAINMENT FAILURE', description: 'Low gravity everywhere' },
    ],
    schedule: { kind: 'random', start: 15, cycle: 35, chance: 0.9 },
  },
};
