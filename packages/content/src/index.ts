import { fluxLabMap } from './maps/fluxLab';
import { lunarOutpostMap } from './maps/lunarOutpost';
import { mechanicsTestMap } from './maps/mechanicsTest';
import { movementTestMap } from './maps/movementTest';
import { stormFrontMap } from './maps/stormFront';
import type { MapDef } from './maps/types';

export * from './attachments';
export * from './cosmetics';
export * from './grenades';
export * from './hitboxes';
export * from './maps/mapJson';
export * from './maps/mechanics';
export * from './maps/types';
export * from './pickups';
export * from './shield';
export * from './tuning';
export * from './weapons';
export { fluxLabMap, lunarOutpostMap, mechanicsTestMap, movementTestMap, stormFrontMap };

export const maps: Readonly<Record<string, MapDef>> = {
  [movementTestMap.id]: movementTestMap,
  [mechanicsTestMap.id]: mechanicsTestMap,
  [lunarOutpostMap.id]: lunarOutpostMap,
  [stormFrontMap.id]: stormFrontMap,
  [fluxLabMap.id]: fluxLabMap,
};

/** Maps that show off map mechanics (docs/02 §20), for map pickers. */
export const DEMO_MAPS: readonly string[] = [lunarOutpostMap.id, stormFrontMap.id, fluxLabMap.id];

export function getMap(id: string): MapDef {
  const map = maps[id];
  if (!map) throw new Error(`Unknown map "${id}"`);
  return map;
}
