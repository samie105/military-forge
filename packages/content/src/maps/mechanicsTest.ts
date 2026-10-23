import { zonePoints } from './mechanics';
import { Material, type MapDef, type MapLabel, type MapPolygon, type MapZone } from './types';

/**
 * Mechanics test map (docs/02 §20): every zone kind and every event kind, for golden replays and
 * playtests. A flat 240 m strip, left to right:
 *   low-g · zero-g · reversed-gravity pocket · long flight · wind · mud · water · jump pad ·
 *   boost pad · EMP field · bullet-fog gallery (from the x 172 spawn, a Hammer can't reach the
 *   dummy behind the fog, a Widow can, except during the fog event) · knockback ×2 pit ·
 *   two gravity-pocket sites (the "pocket" event switches one on)
 * Map rules: fuel refills 25 % faster everywhere. Events run on a 49 s loop, every kind once, with
 * short warnings so replays reach them quickly.
 */

const WIDTH = 240;
const FLOOR_BOTTOM = -6;
const CEILING = 30;

function rect(x0: number, y0: number, x1: number, y1: number, material: Material = Material.Concrete): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1], material };
}

const zones: MapZone[] = [
  { id: 'low-g', kind: 'lowG', rect: [4, 0, 20, CEILING], label: 'low-g' },
  { id: 'zero-g', kind: 'zeroG', rect: [22, 0, 38, CEILING], label: 'zero-g (Down dives)' },
  { id: 'reverse', kind: 'reverseG', rect: [40, 0, 56, 8], label: 'reversed gravity' },
  { id: 'long-flight', kind: 'longFlight', rect: [58, 0, 74, CEILING], label: 'long flight' },
  { id: 'wind', kind: 'wind', rect: [76, 0, 92, CEILING], label: 'wind →' },
  { id: 'mud', kind: 'slow', rect: [94, 0, 110, 2], label: 'mud' },
  { id: 'water', kind: 'water', rect: [112, 0, 128, 3.5], label: 'deep water' },
  { id: 'jump-pad', kind: 'jumpPad', rect: [131, 0, 134, 1.2], label: 'jump pad' },
  { id: 'boost-pad', kind: 'boostPad', rect: [138, 0, 140, 1.2], label: 'boost pad →' },
  { id: 'emp', kind: 'emp', rect: [150, 0, 166, CEILING], label: 'EMP field' },
  { id: 'fog', kind: 'damping', points: [178, 0, 184, 0, 184, 12, 181, 15, 178, 12], label: 'bullet fog' },
  { id: 'heavy-hits', kind: 'custom', rect: [202, 0, 214, CEILING], knockbackMul: 2, label: 'knockback ×2' },
  { id: 'pocket-a', kind: 'reverseG', rect: [218, 0, 226, 10], event: 'pocket', label: 'pocket site A' },
  { id: 'pocket-b', kind: 'reverseG', rect: [229, 0, 237, 10], event: 'pocket', label: 'pocket site B' },
];

/** each zone's label over its middle, near the floor */
const labels: MapLabel[] = zones.map((z) => {
  const pts = zonePoints(z);
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]!);
    maxX = Math.max(maxX, pts[i]!);
  }
  return { x: (minX + maxX) / 2, y: 2.6, text: z.label ?? z.id };
});

export const mechanicsTestMap: MapDef = {
  id: 'mechanics-test',
  name: 'Mechanics Test',
  bounds: { minX: -2, minY: FLOOR_BOTTOM, maxX: WIDTH + 2, maxY: CEILING + 2 },
  solids: [
    rect(-2, FLOOR_BOTTOM, WIDTH + 2, 0, Material.Dirt), // floor
    rect(-2, 0, 0, CEILING), // left wall
    rect(WIDTH, 0, WIDTH + 2, CEILING), // right wall
    rect(-2, CEILING, WIDTH + 2, CEILING + 2), // ceiling
    rect(168, 0, 169, 1.1, Material.Wood), // gallery cover
  ],
  oneWays: [{ ax: 58, ay: 6, bx: 64, by: 6, blocksBullets: true }],
  spawns: [
    { x: 2, y: 0 },
    { x: 146, y: 0 },
    { x: 172, y: 0 },
    { x: 216, y: 0 },
  ],
  dummies: [
    { name: 'Behind fog', x: 194, y: 0, script: { kind: 'idle' } },
    { name: 'Fog strafer', x: 197, y: 0, script: { kind: 'strafe', minX: 196, maxX: 200 } },
    { name: 'Heavy', x: 208, y: 0, script: { kind: 'idle' } },
    { name: 'Floater', x: 30, y: 0, script: { kind: 'jet', periodTicks: 240, burstTicks: 20 } },
    { name: 'Bouncer', x: 132.5, y: 0, script: { kind: 'idle' } },
  ],
  labels,
  // weapon crates (owner: "more guns") and the test armory's rack; both need pickups on (rooms, local mode)
  spawners: [
    // a random gun, everyday ones three times as often as power weapons
    {
      id: 'weapons',
      pool: 'weapons',
      spots: [
        { x: 145, y: 0 },
        { x: 175, y: 0 },
        { x: 188, y: 0 },
      ],
      first: [3, 6],
      respawn: [12, 18],
      maxActive: 2,
    },
  ],
  armory: { x: 141.2, y: 1.5, dir: 1 },
  rules: { fuelRegenMul: 1.25 },
  zones,
  events: {
    defs: [
      { id: 'surge', kind: 'gravitySurge', duration: 5, warning: 1 },
      { id: 'floaty', kind: 'lowGravity', duration: 5, warning: 1 },
      { id: 'emp', kind: 'emp', duration: 4, warning: 1 },
      { id: 'fog', kind: 'fog', duration: 5, warning: 1 },
      { id: 'gusts', kind: 'gust', duration: 6, warning: 1, gustPeriod: 2 },
      { id: 'pocket', kind: 'flip', duration: 5, warning: 1 },
      { id: 'molasses', kind: 'custom', name: 'MOLASSES', description: 'Thick air, soft hits', duration: 4, warning: 1, drag: 2, knockbackMul: 0.5, moveSpeedMul: 0.8 },
    ],
    schedule: {
      kind: 'timeline',
      start: 2,
      loop: 49,
      entries: [
        { at: 1, event: 'surge' },
        { at: 8, event: 'floaty' },
        { at: 15, event: 'emp' },
        { at: 21, event: 'fog' },
        { at: 28, event: 'gusts' },
        { at: 36, event: 'pocket' },
        { at: 43, event: 'molasses' },
      ],
    },
  },
};
