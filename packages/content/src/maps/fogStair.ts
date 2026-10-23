import { Material, type MapDef, type MapLabel, type MapOneWay, type MapPolygon, type MapZone } from './types';

/**
 * FOG STAIR: a mountain city on a river gorge (the owner's pick, 23 Oct: "fog stair"). Its own
 * place: a stacked hillside city in south-west China, where one street's ground floor is another's
 * twentieth, long public stairs climb the slope, a monorail runs through a tower, and footbridges
 * join the rooftops over a river that fog rolls up. No Lagos styling; an original place.
 *
 * Tall-map rules (NOTES §48): four stacked battle zones, bottom to top, mirrored about the river
 * (x 120) so neither bank has the high ground:
 *
 *   rooftops   y 62   the towers' roofs, a footbridge across the gorge, the hill pavilions; power weapons
 *   monorail   y 38   the hilltop lanes, the track's viaducts, the station inside each tower, the
 *                     river bridge with a parked car for cover; shields
 *   stairs     y 20   the terraces between the two long public stairs; everyday guns
 *   riverside  y 0    the quays, the tower arcades and the river (deep water: slow, bullets die)
 *
 * The stairs (45°) are the walking way up: free, slow and in the open. Jets are the fast way, a
 * tier for most of a tank; perches every 11–12 m on the towers' faces make it in hops (and give
 * the bots' air links, ≤ 12.5 m up, a way). Updrafts rise from the river to the monorail bridge
 * and from the hilltops to the pavilions. Thin air above y 82 turns fliers back; the ceiling at
 * 100 is solid. A seeded river fog shortens every bullet for a while.
 *
 * Every one-way is a slab (blocksBullets: drawn solid, it stops bullets). The arcade legs, the
 * viaduct's pillars, the pavilions' posts and the roof masts are bullet-only.
 */

const W = 240;
const MID = W / 2;
const FLOOR_BOTTOM = -6;
const CEILING = 100;
const THIN_AIR = 82;

const RIVERSIDE = 0;
const STAIRS = 20;
const MONORAIL = 38;
const ROOFTOPS = 62;
/** the river's bed */
const RIVERBED = -4;
/** the towers stand on arcades this tall */
const ARCADE = 4;
/** the station: the gap in each tower the track runs through */
const STATION_TOP = 43.5;

/** mirrors x about the river */
const m = (x: number) => W - x;

function rect(x0: number, y0: number, x1: number, y1: number, material: Material = Material.Concrete): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1], material };
}

function slab(x0: number, x1: number, y: number): MapOneWay {
  return { ax: x0, ay: y, bx: x1, by: y, blocksBullets: true };
}

/** thin steel or timber: stops bullets, not bodies */
function post(x: number, y0: number, y1: number, half = 0.2): MapPolygon {
  return rect(x - half, y0, x + half, y1, Material.Metal);
}

/** the west bank's ground, left to right: the hilltop lane, the upper stair, the terrace, the lower stair, the quay */
const WEST_PROFILE: readonly [number, number][] = [
  [0, MONORAIL],
  [22, MONORAIL],
  [40, STAIRS],
  [56, STAIRS],
  [76, RIVERSIDE],
  [104, RIVERSIDE],
  [104, RIVERBED],
];

/** the ground's height at x on the west bank (the stairs interpolate) */
function groundAt(x: number): number {
  for (let i = 1; i < WEST_PROFILE.length; i++) {
    const [x0, y0] = WEST_PROFILE[i - 1]!;
    const [x1, y1] = WEST_PROFILE[i]!;
    if (x >= x0 && x <= x1 && x1 > x0) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return RIVERSIDE;
}

// The terrain: one polygon, the bottom edge left → right, then the skyline right → left (CCW).
const top: [number, number][] = [...WEST_PROFILE, ...[...WEST_PROFILE].reverse().map(([x, y]) => [m(x), y] as [number, number])];
const terrain: number[] = [0, FLOOR_BOTTOM, W, FLOOR_BOTTOM];
for (let i = top.length - 1; i >= 0; i--) terrain.push(top[i]![0], top[i]![1]);

/** one bank's pieces; the other bank mirrors them */
function bank(flip: boolean) {
  const X = (x: number) => (flip ? m(x) : x);
  const r = (x0: number, y0: number, x1: number, y1: number, material?: Material) => rect(Math.min(X(x0), X(x1)), y0, Math.max(X(x0), X(x1)), y1, material);
  const s = (x0: number, x1: number, y: number) => slab(Math.min(X(x0), X(x1)), Math.max(X(x0), X(x1)), y);
  const solids: MapPolygon[] = [
    // the tower on the quay: arcade, the lower floors, the station gap, the upper floors
    r(80, ARCADE, 98, MONORAIL),
    r(80, STATION_TOP, 98, ROOFTOPS),
    // a shop-house on the terrace (its roof a perch toward the track)
    r(44, STAIRS, 50, STAIRS + 6.5),
    // a water tank on the tower's roof
    r(83, ROOFTOPS, 86, ROOFTOPS + 2.5, Material.Metal),
    // the quay's bollards and crates (1.2 m)
    r(100.5, RIVERSIDE, 102, RIVERSIDE + 1.2, Material.Metal),
  ];
  const oneWays: MapOneWay[] = [
    // the monorail's viaduct from the hilltop to the tower
    s(22.5, 80, MONORAIL),
    // balconies on the tower's faces, every 11–12 m
    s(76, 80, 10),
    s(98, 102, 14),
    s(98, 102, 26),
    s(76, 80, 50),
    s(98, 102, 50),
    // the hill's perch, and the pavilion over the hilltop lane
    s(18, 22, 50),
    s(2, 18, ROOFTOPS),
  ];
  const bulletOnly: MapPolygon[] = [
    // arcade legs
    post(X(80.6), RIVERSIDE, ARCADE),
    post(X(89), RIVERSIDE, ARCADE),
    post(X(97.4), RIVERSIDE, ARCADE),
    // the viaduct's pillars, down to the stair, the terrace and the stair below
    ...[31, 53, 66].map((x) => post(X(x), groundAt(x), MONORAIL, 0.3)),
    // the pavilion's posts
    post(X(4), MONORAIL, ROOFTOPS),
    post(X(16), MONORAIL, ROOFTOPS),
    // a radio mast on the tower's roof
    post(X(95), ROOFTOPS, ROOFTOPS + 8, 0.15),
  ];
  return { solids, oneWays, bulletOnly };
}

const west = bank(false);
const east = bank(true);

const solids: MapPolygon[] = [
  { points: terrain, material: Material.Concrete },
  rect(-2, FLOOR_BOTTOM, 0, CEILING), // west wall
  rect(W, FLOOR_BOTTOM, W + 2, CEILING), // east wall
  rect(-2, CEILING, W + 2, CEILING + 2), // the hard ceiling
  ...west.solids,
  ...east.solids,
  // the monorail car parked on the river bridge: the one piece of cover over the gorge at that height
  rect(MID - 4, MONORAIL, MID + 4, MONORAIL + 3.2, Material.Metal),
];

const oneWays: MapOneWay[] = [
  ...west.oneWays,
  ...east.oneWays,
  // the monorail's bridge over the river, tower to tower
  slab(98, m(98), MONORAIL),
  // the footbridge between the towers' roofs, across the gorge
  slab(98, m(98), ROOFTOPS),
];

const zones: MapZone[] = [
  // the river: deep water, slow and floaty; bullets die in it
  { id: 'river', kind: 'water', rect: [104, RIVERBED, m(104), -1], label: 'river' },
  // the gorge breathes: rising air off the water lifts you to the monorail bridge
  { id: 'updraft-river-west', kind: 'updraft', rect: [109, -3.5, 114, MONORAIL + 3], label: 'updraft' },
  { id: 'updraft-river-east', kind: 'updraft', rect: [m(114), -3.5, m(109), MONORAIL + 3], label: 'updraft' },
  // and off the hilltops to the pavilions
  { id: 'updraft-hill-west', kind: 'updraft', rect: [8, MONORAIL + 0.5, 12, ROOFTOPS + 4], label: 'updraft' },
  { id: 'updraft-hill-east', kind: 'updraft', rect: [m(12), MONORAIL + 0.5, m(8), ROOFTOPS + 4], label: 'updraft' },
  // the soft ceiling
  { id: 'thin-air', kind: 'thinAir', rect: [0, THIN_AIR, W, CEILING], label: 'thin air' },
];

const labels: MapLabel[] = [
  { x: MID, y: RIVERBED + 1.5, text: 'RIVER' },
  { x: 90, y: RIVERSIDE + 5.5, text: 'QUAY' },
  { x: 66, y: 12, text: 'LOWER STAIR' },
  { x: 31, y: 31, text: 'UPPER STAIR' },
  { x: 89, y: MONORAIL + 2.5, text: 'STATION' },
  { x: MID, y: ROOFTOPS + 3, text: 'ROOF BRIDGE' },
  { x: 10, y: ROOFTOPS + 3, text: 'PAVILION' },
];

/** spots on one bank, mirrored to the other */
const both = (spots: { x: number; y: number }[]) => [...spots, ...spots.map((s) => ({ x: m(s.x), y: s.y }))];

export const fogStairMap: MapDef = {
  id: 'fog-stair',
  name: 'Fog Stair',
  bounds: { minX: -2, minY: FLOOR_BOTTOM, maxX: W + 2, maxY: CEILING + 2 },
  solids,
  oneWays,
  bulletOnly: [...west.bulletOnly, ...east.bulletOnly],
  spawns: both([
    // riverside: the quay, the arcade
    { x: 103, y: RIVERSIDE },
    { x: 89, y: RIVERSIDE },
    // the terrace
    { x: 42, y: STAIRS },
    { x: 53, y: STAIRS },
    // the hilltop lane, the station
    { x: 16, y: MONORAIL },
    { x: 89, y: MONORAIL },
    // the tower's roof
    { x: 91, y: ROOFTOPS },
  ]),
  dummies: [],
  labels,
  zones,
  events: {
    defs: [{ id: 'river-fog', kind: 'fog', name: 'RIVER FOG', description: 'Fog rolls up the gorge: bullets fall short' }],
    schedule: { kind: 'random', start: 45, cycle: 75, chance: 0.6 },
  },
  tiers: [
    { id: 'riverside', name: 'Riverside', y: RIVERSIDE },
    { id: 'stairs', name: 'The Stairs', y: STAIRS },
    { id: 'monorail', name: 'Monorail', y: MONORAIL },
    { id: 'rooftops', name: 'Rooftops', y: ROOFTOPS },
  ],
  // each tier pays for the climb
  spawners: [
    {
      id: 'riverside-grenades',
      pool: 'grenades',
      spots: both([{ x: 84, y: RIVERSIDE }]),
      first: [2, 5],
      respawn: [16, 22],
      maxActive: 1,
    },
    {
      id: 'riverside-guns',
      pool: 'common',
      spots: both([{ x: 79, y: RIVERSIDE }]),
      first: [3, 6],
      respawn: [12, 18],
    },
    {
      id: 'terrace-guns',
      pool: 'common',
      spots: both([
        { x: 47, y: STAIRS + 6.5 },
        { x: 55, y: STAIRS },
      ]),
      first: [4, 8],
      respawn: [12, 18],
      maxActive: 2,
    },
    {
      id: 'station-shields',
      pool: 'shield',
      spots: both([{ x: 93, y: MONORAIL }]),
      first: [8, 12],
      respawn: [18, 26],
    },
    {
      id: 'monorail-grenades',
      pool: 'grenades',
      spots: [{ x: MID, y: MONORAIL + 3.2 }, ...both([{ x: 6, y: MONORAIL }])],
      first: [6, 10],
      respawn: [18, 24],
      maxActive: 2,
    },
    {
      id: 'rooftop-power',
      pool: 'power',
      spots: [{ x: MID, y: ROOFTOPS }, ...both([{ x: 6, y: ROOFTOPS }])],
      first: [12, 18],
      respawn: [24, 34],
      maxActive: 1,
    },
  ],
  // the test armory's rack: along the west quay, under the arcade
  armory: { x: 77, y: 1.5, dir: 1 },
};
