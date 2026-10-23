/**
 * In-world billboard ads (docs/14), house art only: no ad sales, network or backend yet. See
 * manifest.ts (slots, manifests, the paid-flow stub), rotation.ts (the shared beat), visibility.ts
 * (≤ 2 lit on screen) and boards.ts (the ≤ 2-draw renderer). The map environment owns the boards
 * of a map with ad slots (environment/index.ts, `EnvironmentDef.ads`).
 */
export { AD_POOL_BUDGET, AdBoards, drawnBoards, type SavedPick, CREATIVE_Z, FORMATS, keyframeLayers, layerBytes, layerTable, plannedGpuBytes, referencedCreatives, rotationState, type FormatSpec, type InstanceState } from './boards';
export { FINANCE_NOTE, LIT_TO_SAVE, checkClick, creativeAt, visitUrl, type AdClick, type Advertiser, type BoardHit } from './click';
export { DEFAULT_HOUSE_OPTIONS, checkManifest, sponsorTurns, clickOf, fetchAdManifest, houseManifest, poolEntries, type AdFrame, type HouseOptions, type AdManifest, type AdSlot, type HouseEntry, type HousePool } from './manifest';
export { CROSSFADE_MS, DWELL_MS, KEY_FADE_MS, KEY_MS, MAX_KEYS, TICK_MS, crossfade, frameIndex, keyFade, keySegment, lastKeySegment, previousFrame } from './rotation';
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
