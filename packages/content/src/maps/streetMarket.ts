import json from './streetMarket.map.json';
import { parseMapJson } from './mapJson';

/**
 * Street Market (docs/01 §7, map 4): a market street between two rows of houses, with stalls,
 * minibuses, crates, a water-tank tower and a billboard catwalk in the middle. Mirrored halves,
 * 120 m of play between the edge walls, walkable heights 0 → 12 m, 14 spawns.
 *
 * Compiled by the art pipeline (art/pipeline/compile_map.py) from art/maps/street_market/layout.json
 * and the Street Market kit's collision extras, so the kit the renderer draws and the collision here
 * come from the same numbers (render = collision, docs/11 §2). Re-copy street_market.map.json after
 * a recompile; content.test.ts fails while the two differ.
 *
 * One exception, until the kit marks slabs: the floors among its one-ways (the house balconies, the
 * tank tower's deck and the billboard catwalk, concrete and steel) carry `blocksBullets` here, so
 * they stop bullets while staying one-way for bodies (owner's playtest, 18 Oct: "bullets go through
 * buildings"). Stall awnings and umbrella canopies (sheet and cloth) still let bullets through, like
 * railings. Keep the 13 flags when re-copying; content.test.ts lists them.
 */
export const streetMarketMap = parseMapJson(json, 'streetMarket.map.json');
