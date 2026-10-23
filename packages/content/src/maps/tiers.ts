/**
 * Tiers of a tall map (MapDef.tiers): which stacked battle zone a point is on. Shared by the sim
 * (respawns spread across tiers) and the HUD (the minimap names your tier).
 */
import type { MapDef, MapTier } from './types';

/** Feet this far under a tier's line still count as on it (a body on a ledge just below the roofline). */
export const TIER_SLACK = 1.5;

/** The map's tiers when it has at least two (bottom to top), else null: a one-tier map has none. */
export function mapTiers(map: MapDef): readonly MapTier[] | null {
  const t = map.tiers;
  return t && t.length >= 2 ? t : null;
}

/** Index of the tier feet at height `y` are on (0 = the lowest), or −1 for a map without tiers. */
export function tierIndexAt(map: MapDef, y: number): number {
  const tiers = mapTiers(map);
  if (!tiers) return -1;
  let at = 0;
  for (let i = 1; i < tiers.length; i++) if (y >= tiers[i]!.y - TIER_SLACK) at = i;
  return at;
}
