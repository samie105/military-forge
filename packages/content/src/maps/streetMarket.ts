import json from './streetMarket.map.json';
import { parseMapJson } from './mapJson';
import type { MapDef } from './types';

/**
 * Street Market (docs/01 §7, map 4): a market street between two rows of houses, with stalls,
 * minibuses, crates, a water-tank tower and a billboard catwalk in the middle. Mirrored halves,
 * 120 m of play between the edge walls, walkable heights 0 → 12 m, 14 spawns.
 *
 * Compiled by the art pipeline (art/pipeline/compile_map.py) from art/maps/street_market/layout.json
 * and the Street Market kit's collision extras, so the kit the renderer draws and the collision here
 * come from the same numbers (render = collision, docs/11 §2). Re-copy street_market.map.json after
 * a recompile; content.test.ts fails while the two differ (spawners and the armory rack are gameplay,
 * added here on top).
 *
 * One exception, until the kit marks slabs: the floors among its one-ways (the house balconies, the
 * tank tower's deck and the billboard catwalk, concrete and steel) carry `blocksBullets` here, so
 * they stop bullets while staying one-way for bodies (owner's playtest, 18 Oct: "bullets go through
 * buildings"). Stall awnings and umbrella canopies (sheet and cloth) still let bullets through, like
 * railings. Keep the 13 flags when re-copying; content.test.ts lists them.
 */
export const streetMarketMap: MapDef = {
  ...parseMapJson(json, 'streetMarket.map.json'),
  // gameplay on top of the compiled geometry (not the art pipeline's): weapon crates (owner: "more
  // guns") between the crates of each yard, in the middle under the sign and on the two stalls;
  // the test armory's rack along the west yard (GameOptions.armory)
  spawners: [
    {
      id: 'weapons',
      pool: 'weapons',
      spots: [
        { x: -35.6, y: 0 },
        { x: 35.6, y: 0 },
        { x: 0, y: 0 },
        { x: -9, y: 2.3 },
        { x: 9, y: 2.3 },
      ],
      first: [3, 6],
      respawn: [12, 18],
      maxActive: 3,
    },
  ],
  armory: { x: -43.2, y: 2.5, dir: 1 },
};
