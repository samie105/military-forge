/**
 * In-world billboard ads (docs/14), house art only: no ad sales, network or backend yet. See
 * manifest.ts (slots, manifests, the paid-flow stub), rotation.ts (the shared beat), visibility.ts
 * (≤ 2 lit on screen) and boards.ts (the ≤ 2-draw renderer). The map environment owns the boards
 * of a map with ad slots (environment/index.ts, `EnvironmentDef.ads`).
 */
export { AD_POOL_BUDGET, AdBoards, CREATIVE_Z, FORMATS, layerBytes, layerTable, plannedGpuBytes, referencedCreatives, rotationState, type FormatSpec, type InstanceState } from './boards';
export { checkManifest, fetchAdManifest, houseManifest, type AdFrame, type AdManifest, type AdSlot, type HouseEntry, type HousePool } from './manifest';
export { CROSSFADE_MS, DWELL_MS, TICK_MS, crossfade, frameIndex, previousFrame } from './rotation';
export { LitLimiter, MAX_LIT, ON_SCREEN, slotInView } from './visibility';

/** Where a map's slots and house pool are, under BASE_URL. */
export interface AdsDef {
  /** the compiled AdSlot list (W8's <map>.adslots.json, shipped next to the kit) */
  slots: string;
  /** the house pool (apps/web/scripts/house-ads.py) */
  pool: string;
  /** folder the pool's files are in, ending in '/' */
  base: string;
}
