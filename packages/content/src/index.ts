import { movementTestMap } from './maps/movementTest';
import type { MapDef } from './maps/types';

export * from './cosmetics';
export * from './grenades';
export * from './hitboxes';
export * from './maps/types';
export * from './tuning';
export * from './weapons';
export { movementTestMap };

export const maps: Readonly<Record<string, MapDef>> = {
  [movementTestMap.id]: movementTestMap,
};

export function getMap(id: string): MapDef {
  const map = maps[id];
  if (!map) throw new Error(`Unknown map "${id}"`);
  return map;
}
