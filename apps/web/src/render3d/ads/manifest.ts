/**
 * In-world billboard ads (docs/14): the data side. AdSlots come from the compiled map (W8's
 * compile_map.py writes <map>.adslots.json, docs/14 §4.2); what each slot shows comes from an
 * ad manifest (§4.3). Today there is no ad sale, network or backend: every manifest is the
 * map's house pool (§4.5 fallback chain: paid → programmatic → house pool → baked).
 *
 * The paid flow is a stub only: `fetchAdManifest` has the shape the client will use (signed
 * manifest from the CDN, §4.3) and always answers null. Nothing here talks to a server.
 */
import { checkClick, type AdClick, type Advertiser } from './click';
import { MAX_AFFINITY, affinity } from './audience';
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
  /** where a player who saves this creative goes after the match (tap-to-save, click.ts); absent = not savable */
  click?: AdClick;
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
  /** a sponsored creative's advertiser (HousePool.advertisers): it can be saved for after the match */
  advertiser?: string;
  /** its own destination (https), else the advertiser's */
  url?: string;
  /** e.g. "finance" (trading, forex, crypto): such creatives can be switched off per region or audience */
  category?: string;
  /**
   * The audiences it suits (audience.ts: "device:touch", "time:evening", "mode:team", "tenure:new",
   * "session:short"…): with the segments flag on and the player's yes, each match gives it an extra
   * turn within its advertiser's share. Absent: one turn, whoever is watching.
   */
  prefer?: string[];
}

/** The map's shared house pool (apps/web/scripts/house-ads.py writes it next to the art). */
export interface HousePool {
  version: number;
  map: string;
  screens: HouseEntry[];
  hoardings: HouseEntry[];
  /**
   * Sponsored creatives (Deet Studios, who make the game, and WorldStreet): house art, never paid and
   * never chipped, outside the ≤ 8-per-format local pool (docs/14 §2.6 lint 6). With any, they fill
   * every frame, the advertisers sharing the boards by weight (houseManifest); the local pool is then
   * not shown (the Street Market's is empty since 23 Oct: the owner removed the dummy ads).
   */
  sponsored?: { screens: HouseEntry[]; hoardings: HouseEntry[] };
  /** the sponsored lists' name before 23 Oct (a pool cached from then): read as `sponsored` */
  studio?: { screens: HouseEntry[]; hoardings: HouseEntry[] };
  /** who the sponsored creatives are for: name, default destination, UTM tag (house-ads.py ADVERTISERS) */
  advertisers?: Record<string, Advertiser>;
}

/** Every entry of a pool, the sponsored ones included. */
export function poolEntries(pool: HousePool): HouseEntry[] {
  const sponsored = sponsoredOf(pool);
  return [...pool.screens, ...pool.hoardings, ...(sponsored?.screens ?? []), ...(sponsored?.hoardings ?? [])];
}

/** A pool's sponsored lists, under either name (`studio` before 23 Oct). */
export function sponsoredOf(pool: Pick<HousePool, 'sponsored' | 'studio'>): HousePool['sponsored'] {
  return pool.sponsored ?? pool.studio;
}

/** Which sponsored creatives a match may show (a region or audience without finance ads, later). */
export interface HouseOptions {
  /** categories left off the boards, e.g. new Set(['finance']) */
  blockedCategories?: ReadonlySet<string>;
  /** a creative's turns within its advertiser's share (audience.ts; default: the viewer's context, else 1 each) */
  affinity?: (e: HouseEntry) => number;
}

/**
 * What the boards leave out unless told otherwise: nothing. The owner approved WorldStreet's trading
 * creatives (category "finance", with "Trading involves risk. 18+." on the art) on 23 Oct 2026; a
 * region or audience can still leave them out with `{ blockedCategories: new Set(['finance']) }`
 * (docs/14 §3.7).
 */
export const DEFAULT_HOUSE_OPTIONS: Readonly<HouseOptions> = { blockedCategories: new Set() };

/**
 * The advertisers' turns, by weight (smooth weighted round-robin): the advertiser of each of `n` turns.
 * Weights 2 and 1 give 0 1 0 0 1 0 …: the larger share spread out, never bunched. With integer weights
 * the sequence repeats every Σ weights turns.
 */
export function sponsorTurns(weights: readonly number[], n: number): number[] {
  const total = weights.reduce((a, w) => a + w, 0);
  const current = weights.map(() => 0);
  const out: number[] = [];
  for (let t = 0; t < n; t++) {
    let best = 0;
    for (let i = 0; i < weights.length; i++) {
      current[i]! += weights[i]!;
      if (current[i]! > current[best]!) best = i;
    }
    current[best]! -= total;
    out.push(best);
  }
  return out;
}

/** A pool entry's click-through, or none (local house art, an unknown advertiser, no https destination). */
export function clickOf(pool: Pick<HousePool, 'advertisers'>, e: HouseEntry): AdClick | undefined {
  const adv = e.advertiser ? pool.advertisers?.[e.advertiser] : undefined;
  const url = e.url ?? adv?.url ?? null;
  if (!adv || !url) return undefined;
  const click: AdClick = { advertiser: e.advertiser!, name: adv.name, url };
  if (adv.utm) click.utm = adv.utm;
  if (e.category) click.category = e.category;
  return checkClick(click).length ? undefined : click;
}

/** Sponsored entries grouped by advertiser, in first-appearance order. */
function byAdvertiser(list: readonly HouseEntry[]): HouseEntry[][] {
  const groups = new Map<string, HouseEntry[]>();
  for (const e of list) {
    const k = e.advertiser ?? '';
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.values()];
}

/**
 * The manifest when nothing is sold: house art on every frame.
 * - Screens share one six-creative set, and their different `phaseIdx` keep any two Screens from
 *   showing the same creative at once (§4.4).
 * - With sponsored creatives, they fill every frame, and the advertisers share the boards by their
 *   weight (house-ads.py ADVERTISERS: Deet 2, WorldStreet 1, the owner's two thirds and one third):
 *   the set's frames go in weighted turns (sponsorTurns), and the Hoardings take the next turns of
 *   the same sequence, continued match after match. Each advertiser walks through its own creatives
 *   (`seed` moves it on), so no creative repeats within a match while it has enough of them.
 * - Without sponsors, the local pool: Screens' set and Hoardings' distinct images, turned by `seed`.
 * - A Motion creative's frame carries its keyframe count (`k`); a sponsored one its click-through.
 * - `opts.blockedCategories` leaves those sponsored creatives out (an advertiser left with none drops
 *   out of the turns).
 * The boards pass the frame's `matchSeed` (the room's seed plus the match number), so every client
 * in a match builds the same manifest and the next match shows the next set: over matches the whole
 * pool gets airtime, while only one match's creatives are ever uploaded.
 */
export function houseManifest(mapId: string, slots: readonly AdSlot[], pool: HousePool, seed = 0, opts: HouseOptions = DEFAULT_HOUSE_OPTIONS): AdManifest {
  const mod = (i: number, n: number) => ((i % n) + n) % n;
  const pick = (list: readonly HouseEntry[], i: number) => list[mod(seed + i, list.length)]!;
  const frame = (e: HouseEntry): AdFrame => {
    const f: AdFrame = e.keys?.length ? { c: e.id, k: e.keys.length + 1, paid: false } : { c: e.id, paid: false };
    const click = clickOf(pool, e);
    if (click) f.click = click;
    return f;
  };
  const allowed = (e: HouseEntry) => !e.category || !opts.blockedCategories?.has(e.category);
  const weightOf = (g: HouseEntry[]) => Math.max(1, Math.round(pool.advertisers?.[g[0]!.advertiser ?? '']?.weight ?? 1));
  /** A format's sponsored creatives by advertiser and their turns: `count(n)` turns this match from turn `from`. */
  const turnsOf = opts.affinity ?? ((e: HouseEntry) => affinity(e));
  /** An advertiser's creatives with their turns spread out (all 1: the list as it is). */
  const spread = (g: HouseEntry[]): HouseEntry[] => {
    const w = g.map((e) => Math.max(1, Math.min(MAX_AFFINITY, Math.round(turnsOf(e)))));
    return w.every((x) => x === 1) ? g : sponsorTurns(w, w.reduce((a, x) => a + x, 0)).map((i) => g[i]!);
  };
  const sponsorsOf = (list: readonly HouseEntry[]) => {
    const groups = byAdvertiser(list.filter(allowed)).map(spread);
    const weights = groups.map(weightOf);
    const period = weights.reduce((a, w) => a + w, 0);
    const cycle = sponsorTurns(weights, period);
    /** the creatives of turns from…from+n−1 of the endless sequence (turn t: its advertiser's occurrence number t walks its list) */
    return (from: number, n: number): HouseEntry[] =>
      Array.from({ length: n }, (_, i) => {
        const t = from + i;
        const a = cycle[mod(t, period)]!;
        const before = Math.floor(t / period) * weights[a]! + cycle.slice(0, mod(t, period)).filter((x) => x === a).length;
        const list = groups[a]!;
        return list[mod(before, list.length)]!;
      });
  };
  const sponsored = sponsoredOf(pool);
  const screens = sponsored?.screens.some(allowed) ? sponsorsOf(sponsored.screens) : null;
  const banners = sponsored?.hoardings.some(allowed) ? sponsorsOf(sponsored.hoardings) : null;
  const hoardingCount = slots.filter((s) => s.frames <= 1).length;
  let hoarding = 0;
  return {
    id: `${mapId}-house`,
    map: mapId,
    geo: 'XX',
    slots: slots.map((s) => {
      if (s.frames > 1) {
        // one shared set: match `seed` takes turns seed·frames … of the endless sequence
        if (screens) return { slot: s.slotId, frames: screens(seed * s.frames, s.frames).map(frame) };
        if (!pool.screens.length) return { slot: s.slotId, frames: [] };
        return { slot: s.slotId, frames: Array.from({ length: s.frames }, (_, f) => frame(pick(pool.screens, f))) };
      }
      const i = hoarding++;
      if (banners) return { slot: s.slotId, frames: [frame(banners(seed * hoardingCount + i, 1)[0]!)] };
      if (!pool.hoardings.length) return { slot: s.slotId, frames: [] };
      return { slot: s.slotId, frames: [frame(pick(pool.hoardings, i))] };
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
      if (f.click) for (const p of checkClick(f.click)) problems.push(`${entry.slot}: ${f.c} ${p}`);
    }
  }
  return problems;
}
