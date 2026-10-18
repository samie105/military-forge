import { Material, type MapDef, type MapPolygon } from './types';

/**
 * Demo map (docs/01 §7 "Lunar", docs/02 §20): a moon base. Low gravity everywhere and jet fuel that
 * lasts longer (map rules), a zero-g hab dome in the middle, jump pads in two craters, and now and
 * then a solar flare (EMP: jetpacks off) or the base's gravity generator kicking in (Earth gravity
 * for a while).
 *
 *   x 0 ─ tower ─ crater (pad) ─ ridge ─ HAB DOME (zero-g) ─ crater (pad) ─ tower ─ 120
 */

const WIDTH = 120;
const FLOOR_BOTTOM = -6;
const CEILING = 48;

function rect(x0: number, y0: number, x1: number, y1: number, material: Material = Material.Metal): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1], material };
}

/** top of the regolith, left → right: two craters and a ridge */
const top = [
  0, 0,
  16, 0,
  19, -3,
  25, -3,
  28, 0,
  40, 0,
  44, 3,
  48, 3,
  51, 0,
  80, 0,
  83, -3.5,
  89, -3.5,
  92, 0,
  WIDTH, 0,
];
const terrain: number[] = [0, FLOOR_BOTTOM, WIDTH, FLOOR_BOTTOM];
for (let i = top.length - 2; i >= 0; i -= 2) terrain.push(top[i]!, top[i + 1]!);

export const lunarOutpostMap: MapDef = {
  id: 'lunar-outpost',
  name: 'Lunar Outpost',
  bounds: { minX: -2, minY: FLOOR_BOTTOM, maxX: WIDTH + 2, maxY: CEILING + 2 },
  solids: [
    { points: terrain, material: Material.Dirt },
    rect(-2, FLOOR_BOTTOM, 0, CEILING, Material.Concrete),
    rect(WIDTH, FLOOR_BOTTOM, WIDTH + 2, CEILING, Material.Concrete),
    rect(-2, CEILING, WIDTH + 2, CEILING + 2, Material.Concrete),
    // launch towers
    rect(6, 0, 10, 10),
    rect(110, 0, 114, 10),
    // floating pads either side of the dome, and a deck over it
    rect(30, 12, 38, 12.6),
    rect(82, 12, 90, 12.6),
    rect(52, 22, 68, 22.6),
  ],
  oneWays: [
    { ax: 20, ay: 6, bx: 26, by: 6 },
    { ax: 94, ay: 6, bx: 100, by: 6 },
    { ax: 10, ay: 5, bx: 14, by: 5 },
    { ax: 106, ay: 5, bx: 110, by: 5 },
  ],
  spawns: [
    { x: 4, y: 0 },
    { x: 13, y: 0 },
    { x: 34, y: 0 },
    { x: 46, y: 3 },
    { x: 74, y: 0 },
    { x: 98, y: 0 },
    { x: 116, y: 0 },
    { x: 8, y: 10 },
    { x: 112, y: 10 },
    { x: 34, y: 12.6 },
    { x: 86, y: 12.6 },
    { x: 60, y: 22.6 },
  ],
  dummies: [
    { name: 'Moonwalker', x: 70, y: 0, script: { kind: 'strafe', minX: 68, maxX: 78 } },
    { name: 'Hopper', x: 102, y: 0, script: { kind: 'jet', periodTicks: 200, burstTicks: 25 } },
    { name: 'Dome drifter', x: 60, y: 0, script: { kind: 'jet', periodTicks: 300, burstTicks: 12 } },
    { name: 'Deck sentry', x: 64, y: 22.6, script: { kind: 'idle' } },
  ],
  // the test armory's rack (GameOptions.armory): one of every gun, by the spawn at x 98
  armory: { x: 92.6, y: 1.5, dir: 1 },
  // grenade pairs (then weapon crates) in the craters by the pads and on the deck's west end (contested, away from spawns)
  spawners: [
    {
      id: 'grenades',
      pool: 'grenades',
      spots: [
        { x: 24.2, y: -3 },
        { x: 88.4, y: -3.5 },
        { x: 53.5, y: 22.6 },
      ],
      first: [6, 10],
      respawn: [18, 24],
      maxActive: 2,
    },
    // weapon crates: a random gun (owner: "more guns"), on the floor by the west tower, short of the ridge, on the east pad and the deck
    {
      id: 'weapons',
      pool: 'weapons',
      spots: [
        { x: 14.5, y: 0 },
        { x: 37.5, y: 0 },
        { x: 83, y: 12.6 },
        { x: 57, y: 22.6 },
      ],
      first: [3, 6],
      respawn: [12, 18],
      maxActive: 2,
    },
  ],
  labels: [
    { x: 60, y: 15, text: 'hab dome: zero-g' },
    { x: 22, y: -1.4, text: 'jump pad' },
    { x: 86, y: -1.9, text: 'jump pad' },
  ],
  rules: { gravityMul: 0.45, fuelBurnMul: 0.75 },
  zones: [
    { id: 'hab-dome', kind: 'zeroG', points: [52, 0, 68, 0, 68, 6, 66, 10, 62, 13, 58, 13, 54, 10, 52, 6], label: 'hab dome' },
    { id: 'crater-pad-west', kind: 'jumpPad', rect: [20.5, -3, 23.5, -1.8], launch: [0, 13] },
    { id: 'crater-pad-east', kind: 'jumpPad', rect: [84.5, -3.5, 87.5, -2.3], launch: [0, 13] },
  ],
  events: {
    defs: [
      { id: 'solar-flare', kind: 'emp', name: 'SOLAR FLARE', description: 'Jetpacks offline: the low gravity is all you have', duration: 8, warning: 4 },
      {
        id: 'gravity-generator',
        kind: 'gravitySurge',
        name: 'GRAVITY GENERATOR',
        description: 'Earth gravity for 15 s',
        gravityMul: 2.2, // × the map's 0.45: about 1
        duration: 15,
      },
    ],
    schedule: { kind: 'random', start: 20, cycle: 45, chance: 0.85, weights: { 'solar-flare': 2, 'gravity-generator': 1 } },
  },
};
