/**
 * In-world billboard ads (docs/14): the data side. AdSlots come from the compiled map (W8's
 * compile_map.py writes <map>.adslots.json, docs/14 §4.2); what each slot shows comes from an
 * ad manifest (§4.3). Today there is no ad sale, network or backend: every manifest is the
 * map's house pool (§4.5 fallback chain: paid → programmatic → house pool → baked).
 *
 * The paid flow is a stub only: `fetchAdManifest` has the shape the client will use (signed
 * manifest from the CDN, §4.3) and always answers null. Nothing here talks to a server.
 */
import { MAX_KEYS } from './rotation';

/** docs/14 §4.2: one ad surface in the compiled map. */
export interface AdSlot {
  /** stable, e.g. "street-market/S1" */
  slotId: string;
  kind: 'screen' | 'hoarding' | 'wrap' | 'airship' | 'yard';
  format: '4:3' | '6:1';
  /** rotation capacity: 6 for Screens, 1 for Hoardings */
  frames: number;
  dwellMs: number;
  /** frame offset: Screens that share a view get different offsets */
  phaseIdx: number;
  /** centre of the creative, metres; z ∈ [−9, −4] (§2.6 lint 1) */
  pos: [number, number, number];
  /** width, height, metres */
  size: [number, number];
  yawDeg: number;
  houseSet: string[];
  tags: string[];
}

/** One frame of a slot: a creative id ("house:…" or a content hash), its advertiser, paid or not. */
export interface AdFrame {
  c: string;
  /** keyframes of a Motion creative (docs/14 §3.3: 2…MAX_KEYS); absent or 1 = a still */
  k?: number;
  adv?: number;
  /** paid frames carry the "AD" chip (§1.3 rule 7); house art never does */
  paid: boolean;
}

/** docs/14 §4.3 (compact: creative URLs are derived from ids, advertisers are numbers). */
export interface AdManifest {
  id: string;
  map: string;
  geo: string;
  validFrom?: string;
  validTo?: string;
  slots: { slot: string; frames: AdFrame[] }[];
  /** "ed25519:…" over the rest; absent on the house manifest, which never leaves the client */
  sig?: string;
}

export interface HouseEntry {
  id: string;
  /** WebP (the fallback where the runtime can't transcode) */
  file: string;
  /** ETC1S KTX2 layer at the format's size (house-ads.py ktx2Size) */
  ktx2?: string;
  /**
   * A Motion creative's keyframes after the first (docs/14 §3.3): the entry's own image is keyframe
   * 0 (and the still wherever keyframes don't play), these are 1, 2, …, uploaded as layers
   * `${id}#1`, `${id}#2`, … Only the KTX2 path plays them (boards.ts).
   */
  keys?: { file: string; ktx2?: string }[];
  title: string;
}

/** The map's shared house pool (apps/web/scripts/house-ads.py writes it next to the art). */
export interface HousePool {
  version: number;
  map: string;
  screens: HouseEntry[];
  hoardings: HouseEntry[];
  /**
   * The studio's own creatives (Deet Studios, who make the game): house art, never paid and never
   * chipped, outside the ≤ 8-per-format local pool (docs/14 §2.6 lint 6). Every match's set takes
   * STUDIO_SCREENS of them and one Hoarding (houseManifest).
   */
  studio?: { screens: HouseEntry[]; hoardings: HouseEntry[] };
}

/** Studio Screens in every match's six-creative set (the other four are local house art). */
export const STUDIO_SCREENS = 2;

/** Every entry of a pool, the studio's included. */
export function poolEntries(pool: HousePool): HouseEntry[] {
  return [...pool.screens, ...pool.hoardings, ...(pool.studio?.screens ?? []), ...(pool.studio?.hoardings ?? [])];
}

/**
 * The manifest when nothing is sold: house art on every frame.
 * - Screens share one six-creative set, and their different `phaseIdx` keep any two Screens from
 *   showing the same creative at once (§4.4). With a studio list, STUDIO_SCREENS of the set are the
 *   studio's (frames 0 and 3: spread across the loop), the rest the local pool's; each list is
 *   taken at an offset of `seed`.
 * - Hoardings (one frame) take distinct pool images, also turned by `seed`; with a studio list the
 *   first Hoarding shows a studio creative.
 * - A Motion creative's frame carries its keyframe count (`k`).
 * The boards pass the frame's `matchSeed` (the room's seed plus the match number), so every client
 * in a match builds the same manifest and the next match shows the next set: over matches the whole
 * pool gets airtime, while only one match's creatives are ever uploaded.
 */
export function houseManifest(mapId: string, slots: readonly AdSlot[], pool: HousePool, seed = 0): AdManifest {
  const pick = (list: readonly HouseEntry[], i: number) => list[(((seed + i) % list.length) + list.length) % list.length]!;
  const frame = (e: HouseEntry): AdFrame => (e.keys?.length ? { c: e.id, k: e.keys.length + 1, paid: false } : { c: e.id, paid: false });
  const studio = pool.studio ?? { screens: [], hoardings: [] };
  let hoarding = 0;
  return {
    id: `${mapId}-house`,
    map: mapId,
    geo: 'XX',
    slots: slots.map((s) => {
      const list = s.format === '4:3' ? pool.screens : pool.hoardings;
      if (!list.length) return { slot: s.slotId, frames: [] };
      if (s.frames > 1) {
        const own = Math.min(STUDIO_SCREENS, studio.screens.length, s.frames - 1);
        const at = new Map(Array.from({ length: own }, (_, j) => [Math.floor((j * s.frames) / own), j]));
        let local = 0;
        return { slot: s.slotId, frames: Array.from({ length: s.frames }, (_, f) => frame(at.has(f) ? pick(studio.screens, at.get(f)!) : pick(list, local++))) };
      }
      const i = hoarding++;
      if (studio.hoardings.length) return { slot: s.slotId, frames: [frame(i === 0 ? pick(studio.hoardings, 0) : pick(list, i - 1))] };
      return { slot: s.slotId, frames: [frame(pick(list, i))] };
    }),
  };
}

/**
 * The paid flow (docs/14 §4.3), not wired: the CDN manifest for (map, geo, week, version), its
 * Ed25519 signature checked with the ad key, then creatives fetched by id after first spawn.
 * There is no ads backend yet, so this always resolves null and the house manifest stands.
 */
export async function fetchAdManifest(_url: string): Promise<AdManifest | null> {
  return null;
}

/** Problems with a manifest against the map's slots and what the client has; empty = usable. */
export function checkManifest(m: AdManifest, slots: readonly AdSlot[], known: (creative: string) => boolean): string[] {
  const problems: string[] = [];
  const byId = new Map(slots.map((s) => [s.slotId, s]));
  for (const entry of m.slots) {
    const slot = byId.get(entry.slot);
    if (!slot) {
      problems.push(`${entry.slot}: no such slot`);
      continue;
    }
    if (entry.frames.length !== slot.frames) problems.push(`${entry.slot}: ${entry.frames.length} frames for a ${slot.frames}-frame slot`);
    for (const f of entry.frames) {
      if (!known(f.c)) problems.push(`${entry.slot}: unknown creative ${f.c}`);
      if (f.c.startsWith('house:') && f.paid) problems.push(`${entry.slot}: house art marked paid`);
      if (f.k !== undefined && (!Number.isInteger(f.k) || f.k < 1 || f.k > MAX_KEYS)) problems.push(`${entry.slot}: ${f.c} has ${f.k} keyframes (1…${MAX_KEYS})`);
    }
  }
  return problems;
}
