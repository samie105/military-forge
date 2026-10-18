import { Material, type MapDef, type MapLabel, type MapPolygon } from './types';

/**
 * Movement test map (docs/02 §19, docs/12 §5 week 2). Left to right:
 *   A. ledges 0.2 / 0.5 / 1 / 2 / 4 m          (step-up, jet-up)
 *   B. hills with 30° / 45° / 50° / 55° slopes  (walkable limit is 50°)
 *   C. a 60° wedge pit                          (no jitter in wedge corners)
 *   D. corridors: crouch-only (1.25 m), 2 m, and an overhang for ceiling corner correction
 *   E. one-way platforms stacked at 2.5 / 5 / 7.5 m, a solid platform and a 12 m tower
 *   F. shooting range with cover, a thin wall (muzzle-in-wall guard) and dummies
 *
 * Geometry must be bit-identical on every JS engine, so no Math.tan here: slope runs are
 * precomputed literals (height / tan(angle)).
 */

const WIDTH = 170;
const FLOOR_BOTTOM = -6;
const CEILING = 44;

/** height / tan(angle) for a 3 m hill */
const RUN_3M: Record<number, number> = {
  30: 5.196152422706632,
  45: 3,
  50: 2.51729889353184,
  55: 2.1006226146291294,
};

function rect(x0: number, y0: number, x1: number, y1: number, material: Material = Material.Concrete): MapPolygon {
  return { points: [x0, y0, x1, y0, x1, y1, x0, y1], material };
}

const labels: MapLabel[] = [];
/** top surface of the terrain, strictly left → right */
const top: number[] = [0, 0];

function to(x: number, y: number): void {
  top.push(x, y);
}

function block(x0: number, x1: number, height: number, label: string): void {
  to(x0, 0);
  to(x0, height);
  to(x1, height);
  to(x1, 0);
  labels.push({ x: (x0 + x1) / 2, y: height + 0.6, text: label });
}

function hill(x0: number, slopeDeg: 30 | 45 | 50 | 55, plateau: number): void {
  const run = RUN_3M[slopeDeg]!;
  to(x0, 0);
  to(x0 + run, 3);
  to(x0 + run + plateau, 3);
  to(x0 + 2 * run + plateau, 0);
  labels.push({ x: x0 + run + plateau / 2, y: 3.8, text: `${slopeDeg}°${slopeDeg > 50 ? ' (too steep)' : ''}` });
}

// A. ledges
block(4, 7, 0.2, '0.2 m');
block(10, 13, 0.5, '0.5 m');
block(16, 19, 1.0, '1 m');
block(22, 25, 2.0, '2 m');
block(28, 31, 4.0, '4 m');

// B. slopes
hill(35, 30, 2);
hill(50, 45, 2);
hill(61, 50, 2);
hill(71, 55, 2);

// C. 60° wedge pit (rise 2.598 over 1.5 → 60°)
to(80, 0);
to(81.5, -2.598076211353316);
to(83, 0);
labels.push({ x: 81.5, y: 1, text: 'wedge 60°' });

// E. 12 m tower (one-way ledge attached on its right)
block(142, 144, 12, 'tower 12 m');

// F. shooting range: low cover and a thin wall for the muzzle-in-wall guard
block(154, 155, 1.2, 'cover');
block(160, 160.4, 6, 'thin wall');

to(WIDTH, 0);

// Terrain polygon: bottom edge left → right, then the top profile right → left (CCW).
const terrain: number[] = [0, FLOOR_BOTTOM, WIDTH, FLOOR_BOTTOM];
for (let i = top.length - 2; i >= 0; i -= 2) terrain.push(top[i]!, top[i + 1]!);

labels.push(
  { x: 92, y: 2.0, text: 'crouch corridor 1.25 m' },
  { x: 104, y: 2.8, text: 'corridor 2 m' },
  { x: 114, y: 5.8, text: 'overhang (corner correction)' },
  { x: 127, y: 8.6, text: 'one-way platforms' },
  { x: 137, y: 5.2, text: 'solid platform' },
  { x: 164, y: 7, text: 'shooting range' },
);

export const movementTestMap: MapDef = {
  id: 'movement-test',
  name: 'Movement Test',
  bounds: { minX: -2, minY: FLOOR_BOTTOM, maxX: WIDTH + 2, maxY: CEILING + 2 },
  solids: [
    { points: terrain, material: Material.Dirt },
    rect(-2, FLOOR_BOTTOM, 0, CEILING), // left wall
    rect(WIDTH, FLOOR_BOTTOM, WIDTH + 2, CEILING), // right wall
    rect(-2, CEILING, WIDTH + 2, CEILING + 2), // ceiling
    // D. corridors and overhang
    rect(88, 1.25, 96, 4),
    rect(100, 2.0, 108, 4),
    rect(112, 4, 116, 5, Material.Metal),
    // E. solid floating platform
    rect(134, 4, 140, 4.5, Material.Wood),
  ],
  oneWays: [
    { ax: 124, ay: 2.5, bx: 130, by: 2.5 },
    { ax: 126, ay: 5, bx: 132, by: 5 },
    { ax: 124, ay: 7.5, bx: 130, by: 7.5 },
    { ax: 144, ay: 12, bx: 148, by: 12 },
  ],
  spawns: [
    { x: 2, y: 0 },
    { x: 148, y: 0 },
    { x: 120, y: 0 },
    { x: 85, y: 0 },
  ],
  dummies: [
    { name: 'Strafer', x: 157, y: 0, script: { kind: 'strafe', minX: 156, maxX: 159 } },
    { name: 'Jetter', x: 163, y: 0, script: { kind: 'jet', periodTicks: 150, burstTicks: 70 } },
    { name: 'Idle', x: 165.5, y: 0, script: { kind: 'idle' } },
    { name: 'Croucher', x: 168, y: 0, script: { kind: 'crouch', periodTicks: 120 } },
  ],
  labels,
  // F. a riot shield turns up at one of three spots in front of the range, out of the dummies' reach
  spawners: [
    {
      id: 'range-shield',
      pool: 'shield',
      spots: [
        { x: 150.5, y: 0 },
        { x: 152.5, y: 0 },
        { x: 154.5, y: 1.2 }, // on top of the cover
      ],
      first: [2, 4],
      respawn: [10, 16],
    },
    // grenade pairs up where you jet to (E): the solid platform, the top one-way and the tower
    {
      id: 'range-grenades',
      pool: 'grenades',
      spots: [
        { x: 135.5, y: 4.5 },
        { x: 138.5, y: 4.5 },
        { x: 127, y: 7.5 },
        { x: 143, y: 12 },
      ],
      first: [3, 6],
      respawn: [8, 14],
      maxActive: 2,
    },
  ],
};
