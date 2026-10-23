import { Material, type MapDef, type MapLabel, type MapOneWay, type MapPolygon, type MapZone } from './types';

/**
 * Vertical test (maps-vertical, the owner's 18 Oct decision: "very big maps with vertical layers:
 * battle zones stacked higher and higher that players fly up to and drop back down from"). A
 * greybox that proves the tall-map tech before the first real one: four stacked tiers, fuel and
 * updrafts so climbing is a choice, one-way drop-downs back, pickups that reward each tier, a soft
 * ceiling over the top. Symmetric about x = 100.
 *
 *   sky deck      y 66   a solid deck (x 80..120) with one-way wings; a power weapon
 *   high          y 42   five platforms; power weapons, grenades
 *   rooftops      y 20   three towers' roofs joined by footbridges; everyday guns, shields
 *   streets       y 0    open streets and arcades under the towers; grenades, everyday guns
 *
 * One full tank climbs about 25 m (tuning fuelMax / fuelBurn), so a tier (20–24 m) costs most of it;
 * perches every 11–12 m make the climb in hops (and give the bots' air links, ≤ 12.5 m up, a way),
 * and updrafts lift you for free, slowly and in plain sight, refuelling on the way. Every one-way is
 * a slab (blocksBullets): drawn solid, it stops bullets (owner, 18 Oct; QA, 23 Oct). The arcade
 * legs and the platforms' struts are thin and bullet-only. Thin air above y 82 cuts jetpacks and
 * pushes you back down; the ceiling at y 100 is solid.
 */

const WIDTH = 200;
const FLOOR_BOTTOM = -6;
const CEILING = 100;
/** the soft ceiling starts here */
const THIN_AIR = 82;

const STREETS = 0;
const ROOFS = 20;
const HIGH = 42;
const SKY = 66;
/** the towers stand on arcades this tall */
const ARCADE = 5;

function rect(x0: number, y0: number, x1: number, y1: number, material: Material = Material.Concrete): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1], material };
}

/** a floor slab you fly up through and land on (drop through with Down); stops bullets */
function slab(x0: number, x1: number, y: number): MapOneWay {
  return { ax: x0, ay: y, bx: x1, by: y, blocksBullets: true };
}

/** mirrors x about the centre line */
const m = (x: number) => WIDTH - x;

const solids: MapPolygon[] = [
  rect(0, FLOOR_BOTTOM, WIDTH, STREETS, Material.Concrete), // the street
  rect(-2, FLOOR_BOTTOM, 0, CEILING), // west wall
  rect(WIDTH, FLOOR_BOTTOM, WIDTH + 2, CEILING), // east wall
  rect(-2, CEILING, WIDTH + 2, CEILING + 2), // the hard ceiling
  // three towers on arcades: their roofs are the rooftop tier
  rect(24, ARCADE, 56, ROOFS),
  rect(84, ARCADE, 116, ROOFS),
  rect(m(56), ARCADE, m(24), ROOFS),
  // street cover (1.2 m)
  rect(12, 0, 13.5, 1.2, Material.Metal),
  rect(m(13.5), 0, m(12), 1.2, Material.Metal),
  rect(76, 0, 77.5, 1.2, Material.Metal),
  rect(m(77.5), 0, m(76), 1.2, Material.Metal),
  rect(99.2, 0, 100.8, 1.2, Material.Metal), // under the centre arcade
  // rooftop cover
  rect(30, ROOFS, 31.5, ROOFS + 1.2, Material.Metal),
  rect(48.5, ROOFS, 50, ROOFS + 1.2, Material.Metal),
  rect(m(31.5), ROOFS, m(30), ROOFS + 1.2, Material.Metal),
  rect(m(50), ROOFS, m(48.5), ROOFS + 1.2, Material.Metal),
  rect(92, ROOFS, 93.5, ROOFS + 1.2, Material.Metal),
  rect(106.5, ROOFS, 108, ROOFS + 1.2, Material.Metal),
  // the sky deck's solid middle (its wings are slabs)
  rect(80, SKY - 1, 120, SKY, Material.Metal),
  // a low wall on the sky deck: the one piece of cover up there
  rect(99.2, SKY, 100.8, SKY + 1.2, Material.Metal),
];

const oneWays: MapOneWay[] = [
  // streets → rooftops: perches on the towers' faces, 11 m up
  slab(20, 24, 11),
  slab(56, 60, 11),
  slab(80, 84, 11),
  slab(m(84), m(80), 11),
  slab(m(60), m(56), 11),
  slab(m(24), m(20), 11),
  // footbridges join the rooftops
  slab(56, 84, ROOFS),
  slab(m(84), m(56), ROOFS),
  // rooftops → high: perches 11 m up
  slab(16, 21, 31),
  slab(44, 49, 31),
  slab(97, 103, 31),
  slab(m(49), m(44), 31),
  slab(m(21), m(16), 31),
  // the high platforms
  slab(4, 16, HIGH),
  slab(30, 50, HIGH),
  slab(90, 110, HIGH),
  slab(m(50), m(30), HIGH),
  slab(m(16), m(4), HIGH),
  // high → sky: perches 12 m up
  slab(54, 60, 54),
  slab(86, 91, 54),
  slab(m(91), m(86), 54),
  slab(m(60), m(54), 54),
  // the sky deck's wings
  slab(72, 80, SKY),
  slab(m(80), m(72), SKY),
];

/** thin steel: stops bullets, not bodies (the arcades' legs, the platforms' struts) */
function post(x: number, y0: number, y1: number): MapPolygon {
  return rect(x - 0.2, y0, x + 0.2, y1, Material.Metal);
}

const bulletOnly: MapPolygon[] = [
  // arcade legs
  ...[24.6, 40, 55.4, m(55.4), m(40), m(24.6), 84.6, 115.4].map((x) => post(x, STREETS, ARCADE)),
  // high platforms' struts down to the roofs or the street
  post(10, STREETS, HIGH),
  post(m(10), STREETS, HIGH),
  post(40, ROOFS, HIGH),
  post(m(40), ROOFS, HIGH),
  post(91, ROOFS, HIGH),
  post(109, ROOFS, HIGH),
];

const zones: MapZone[] = [
  // the outer streets' updrafts lift you to the outer high platforms (A and G)
  { id: 'updraft-west', kind: 'updraft', rect: [7, 0.5, 13, HIGH + 2.5], label: 'updraft' },
  { id: 'updraft-east', kind: 'updraft', rect: [m(13), 0.5, m(7), HIGH + 2.5], label: 'updraft' },
  // over the footbridges, up past the sky deck's wings
  { id: 'updraft-sky-west', kind: 'updraft', rect: [62, 30, 67, SKY + 4], label: 'updraft' },
  { id: 'updraft-sky-east', kind: 'updraft', rect: [m(67), 30, m(62), SKY + 4], label: 'updraft' },
  // the soft ceiling
  { id: 'thin-air', kind: 'thinAir', rect: [0, THIN_AIR, WIDTH, CEILING], label: 'thin air' },
];

const labels: MapLabel[] = [
  { x: 100, y: STREETS + 6.5, text: 'STREETS' },
  { x: 40, y: ROOFS + 3, text: 'ROOFTOPS' },
  { x: 100, y: HIGH + 3, text: 'HIGH' },
  { x: 100, y: SKY + 3, text: 'SKY DECK' },
  { x: 100, y: THIN_AIR + 2, text: 'thin air: jets cut out' },
];

export const verticalTestMap: MapDef = {
  id: 'vertical-test',
  name: 'Vertical Test',
  bounds: { minX: -2, minY: FLOOR_BOTTOM, maxX: WIDTH + 2, maxY: CEILING + 2 },
  solids,
  oneWays,
  bulletOnly,
  spawns: [
    // streets
    { x: 4, y: STREETS },
    { x: m(4), y: STREETS },
    { x: 64, y: STREETS },
    { x: m(64), y: STREETS },
    { x: 32, y: STREETS },
    { x: m(32), y: STREETS },
    // rooftops
    { x: 27, y: ROOFS },
    { x: m(27), y: ROOFS },
    { x: 53, y: ROOFS },
    { x: m(53), y: ROOFS },
    { x: 88, y: ROOFS },
    { x: m(88), y: ROOFS },
    // high
    { x: 14, y: HIGH },
    { x: m(14), y: HIGH },
    { x: 34, y: HIGH },
    { x: m(34), y: HIGH },
  ],
  dummies: [],
  labels,
  zones,
  tiers: [
    { id: 'streets', name: 'Streets', y: STREETS },
    { id: 'roofs', name: 'Rooftops', y: ROOFS },
    { id: 'high', name: 'High', y: HIGH },
    { id: 'sky', name: 'Sky deck', y: SKY },
  ],
  // each tier pays for the climb: grenades and everyday guns low, shields on the bridges, power
  // weapons up high, and the best spot on the sky deck
  spawners: [
    {
      id: 'streets-grenades',
      pool: 'grenades',
      spots: [
        { x: 10, y: STREETS },
        { x: 70, y: STREETS },
        { x: 100, y: 1.2 },
        { x: m(70), y: STREETS },
        { x: m(10), y: STREETS },
      ],
      first: [2, 5],
      respawn: [16, 22],
      maxActive: 2,
    },
    {
      id: 'streets-guns',
      pool: 'common',
      spots: [
        { x: 40, y: STREETS },
        { x: m(40), y: STREETS },
      ],
      first: [3, 6],
      respawn: [12, 18],
      maxActive: 1,
    },
    {
      id: 'roofs-guns',
      pool: 'common',
      spots: [
        { x: 36, y: ROOFS },
        { x: 100, y: ROOFS },
        { x: m(36), y: ROOFS },
      ],
      first: [4, 8],
      respawn: [12, 18],
      maxActive: 2,
    },
    {
      id: 'bridge-shields',
      pool: 'shield',
      spots: [
        { x: 70, y: ROOFS },
        { x: m(70), y: ROOFS },
      ],
      first: [8, 12],
      respawn: [18, 26],
    },
    {
      id: 'high-power',
      pool: 'power',
      spots: [
        { x: 40, y: HIGH },
        { x: 100, y: HIGH },
        { x: m(40), y: HIGH },
      ],
      first: [10, 16],
      respawn: [22, 32],
      maxActive: 1,
    },
    {
      id: 'high-grenades',
      pool: 'grenades',
      spots: [
        { x: 6, y: HIGH },
        { x: m(6), y: HIGH },
      ],
      first: [6, 10],
      respawn: [18, 24],
    },
    {
      id: 'sky-power',
      pool: 'power',
      spots: [
        { x: 94, y: SKY },
        { x: 106, y: SKY },
      ],
      first: [20, 30],
      respawn: [30, 40],
    },
  ],
  armory: { x: 66, y: 1.5, dir: 1 },
};
