import { existsSync, readFileSync } from 'node:fs';
import { streetMarketMap } from '@military-forge/content';
import { VIEW_ZOOM_MULTIPLIERS } from '@military-forge/netcode';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../../camera';
import { environmentFor } from '../../environment';
import { projectToPlane, type Rect } from '../../layers';
import { planePose, type PlanePose } from '../../planeCamera';
import {
  AD_POOL_BUDGET,
  AdBoards,
  adsUrl,
  DEFAULT_HOUSE_OPTIONS,
  FORMATS,
  KEY_FADE_MS,
  KEY_MS,
  MAX_KEYS,
  checkManifest,
  crossfade,
  frameIndex,
  houseManifest,
  keyFade,
  keySegment,
  keyframeLayers,
  layerBytes,
  layerTable,
  plannedGpuBytes,
  poolEntries,
  previousFrame,
  referencedCreatives,
  rotationState,
  sponsorTurns,
  type AdManifest,
  type AdSlot,
  type HouseEntry,
  type HouseOptions,
  type HousePool,
} from '..';
import { LitLimiter, MAX_LIT, ON_SCREEN, slotInView } from '../visibility';

const WEB = new URL('../../../../', import.meta.url);
const REPO = new URL('../../', WEB);
const json = <T>(url: URL) => JSON.parse(readFileSync(url, 'utf8')) as T;
const slots = json<AdSlot[]>(new URL('public/assets/kits/street_market/street_market.adslots.json', WEB));
/** what house-ads.py records next to each creative */
type Checked = HouseEntry & { signalHues: Record<string, number>; luminance: number; keyLuminance?: number[] };
const pool = json<Omit<HousePool, 'screens' | 'hoardings' | 'sponsored'> & { screens: Checked[]; hoardings: Checked[]; sponsored: { screens: Checked[]; hoardings: Checked[] } }>(new URL('public/assets/ads/street_market/house.json', WEB));
const studio = [...pool.sponsored.screens, ...pool.sponsored.hoardings];

/** Camera poses across the Street Market at every zoom: x and y across the clamp range. */
function poses(width = 1280, height = 720): { zoom: number; pose: PlanePose }[] {
  const b = streetMarketMap.bounds;
  const out: { zoom: number; pose: PlanePose }[] = [];
  for (let zoom = 0; zoom < VIEW_ZOOM_MULTIPLIERS.length; zoom++) {
    const cam = new Camera();
    cam.resize(width, height);
    cam.setZoom(zoom, VIEW_ZOOM_MULTIPLIERS.length);
    const { halfW, halfH } = cam.halfExtents;
    for (let fx = 0; fx <= 1.0001; fx += 0.05) {
      for (const fy of [0, 0.15, 0.4, 1]) {
        cam.x = b.minX + halfW + fx * (b.maxX - b.minX - 2 * halfW);
        cam.y = b.minY + halfH + fy * (b.maxY - b.minY - 2 * halfH);
        out.push({ zoom, pose: { ...planePose(cam) } });
      }
    }
  }
  return out;
}

describe('ad slots (docs/14 §2.6)', () => {
  it('ships W8’s compiled AdSlots unchanged (re-copy after a recompile)', () => {
    expect(slots).toEqual(json(new URL('art/maps/street_market/street_market.adslots.json', REPO)));
    expect(slots.map((s) => s.slotId)).toEqual(['street-market/S1', 'street-market/S2', 'street-market/S3', 'street-market/S4', 'street-market/H1', 'street-market/H2']);
  });

  it('every surface is in the mid-depth band, never on or in front of the gameplay plane', () => {
    for (const s of slots) {
      expect(s.pos[2], s.slotId).toBeGreaterThanOrEqual(-9);
      expect(s.pos[2], s.slotId).toBeLessThanOrEqual(-4);
      expect(Math.abs(s.yawDeg)).toBeLessThanOrEqual(20);
    }
  });
});

describe('rotation (docs/14 §4.4)', () => {
  const screen = slots[0]!;

  it('runs off the match clock: one shared 10 s beat, phase offsets, a 0.5 s crossfade', () => {
    expect(frameIndex(screen, 0)).toBe(screen.phaseIdx % 6);
    expect(frameIndex(screen, 9_999)).toBe(frameIndex(screen, 0));
    expect(frameIndex(screen, 10_000)).toBe((frameIndex(screen, 0) + 1) % 6);
    expect(frameIndex(screen, 60_000)).toBe(frameIndex(screen, 0)); // a 60 s loop of 6 frames
    expect(previousFrame(screen, 10_000)).toBe(frameIndex(screen, 0));
    expect(crossfade(10_000)).toBe(0);
    expect(crossfade(10_250)).toBeCloseTo(0.5, 9);
    expect(crossfade(10_500)).toBe(1);
    expect(crossfade(19_999)).toBe(1);
    // every Screen changes on the same beat
    for (const s of slots) expect(s.dwellMs).toBe(10_000);
  });

  it('house art: no two Screens show the same creative at once; Hoardings differ; nothing is paid', () => {
    for (const seed of [0, 1, 5]) {
      const m = houseManifest('street-market', slots, pool, seed);
      expect(checkManifest(m, slots, (c) => poolEntries(pool).some((e) => e.id === c))).toEqual([]);
      for (const f of m.slots.flatMap((s) => s.frames)) expect(f.paid).toBe(false);
      for (let t = 0; t < 60_000; t += 10_000) {
        const shown = slots.map((s, i) => m.slots[i]!.frames[frameIndex(s, t)]!.c);
        expect(new Set(shown).size, `seed ${seed} at ${t} ms`).toBe(shown.length);
      }
    }
  });

  it('fades between the layers of the previous and current frame, and flags paid frames for the AD chip', () => {
    const screens = slots.filter((s) => s.format === '4:3');
    const layers = layerTable(poolEntries(pool));
    const m = houseManifest('street-market', slots, pool, 0);
    const st = rotationState(screens, m, layers, 10_250);
    expect(st.fade).toBeCloseTo(0.5, 9);
    const s0 = m.slots[0]!.frames;
    expect(st.layers[0]).toBe(layers.get(s0[previousFrame(screens[0]!, 10_250)]!.c));
    expect(st.layers[1]).toBe(layers.get(s0[frameIndex(screens[0]!, 10_250)]!.c));
    expect([...st.paid]).toEqual(new Array(screens.length * 2).fill(0));
    const paid: AdManifest = { ...m, slots: m.slots.map((s) => ({ ...s, frames: s.frames.map((f) => ({ ...f, c: 'qZ8f3kT1mV0bXw2LpR7s9A', adv: 1, paid: true })) })) };
    const ps = rotationState(screens, paid, layers, 0);
    expect(ps.paid[1]).toBe(1);
    expect(ps.layers[1]).toBe(0); // not in the pool yet: house art stands in
  });
});

describe('readability (docs/14 §1.3)', () => {
  it('every surface in view shows its creative, at any camera position and zoom, laptop or phone (the owner, 24 Oct)', () => {
    let maxVisible = 0;
    for (const size of [[1280, 720], [812, 375]] as const) {
      for (const { pose } of poses(...size)) {
        const limiter = new LitLimiter(slots);
        for (let i = 0; i < 40; i++) limiter.update(pose, 1 / 60);
        const inView = slots.filter((s) => slotInView(s, pose).visible >= ON_SCREEN).length;
        expect(limiter.litOnScreen(pose)).toBe(inView);
        maxVisible = Math.max(maxVisible, inView);
      }
    }
    // the wide zooms see more than two: once switched off past two, now all lit
    expect(maxVisible).toBeGreaterThan(2);
    expect(MAX_LIT).toBe(Number.POSITIVE_INFINITY);
  });

  it('lights the surfaces taking most of the view, and keeps them while panning (no flicker)', () => {
    const cam = new Camera();
    cam.resize(1280, 720);
    cam.setZoom(6, 7);
    let flips = 0;
    const limiter = new LitLimiter(slots);
    let prev: number[] | null = null;
    for (let x = -22; x <= 22; x += 0.25) {
      cam.x = x;
      cam.y = 20;
      const pose = planePose(cam);
      limiter.update(pose, 1 / 60);
      const now = [...limiter.choose(pose)];
      if (prev && now.some((v, i) => v !== prev![i])) flips++;
      prev = now;
    }
    expect(flips).toBeLessThan(10);
  });

  it('house art keeps clear of the signal hues: team blue and orange, damage red (house-ads.py, on the shipped pixels)', () => {
    for (const e of [...pool.screens, ...pool.hoardings, ...studio]) {
      expect(Object.keys(e.signalHues).sort(), e.id).toEqual(['damageRed', 'teamBlue', 'teamOrange']);
      for (const [hue, share] of Object.entries(e.signalHues)) {
        expect(share, `${e.id} ${hue}`).toBeLessThan(0.15); // docs/14 §3.5's reviewer line
        expect(share, `${e.id} ${hue}`).toBeLessThan(0.1); // the script's own margin
      }
    }
    expect(pool.screens.length).toBeLessThanOrEqual(8);
    expect(pool.hoardings.length).toBeLessThanOrEqual(8);
  });

  it('the environment’s dressing never covers a billboard (trees, bunting, street lamps), from any camera', () => {
    const d = environmentFor('street-market')!;
    const blockers: { r: Rect; z: number; what: string }[] = [];
    for (const t of d.dressing?.trees ?? []) blockers.push({ r: { x0: t.x - 0.4 * t.h, x1: t.x + 0.4 * t.h, y0: 0, y1: 1.02 * t.h }, z: t.z + 1, what: `tree ${t.x}` });
    for (const b of d.dressing?.bunting ?? []) blockers.push({ r: { x0: Math.min(b.a[0], b.b[0]), x1: Math.max(b.a[0], b.b[0]), y0: Math.min(b.a[1], b.b[1]) - b.sag - 0.45, y1: Math.max(b.a[1], b.b[1]) }, z: b.a[2], what: `bunting ${b.a[0]}` });
    for (const x of d.lamps ?? []) {
      blockers.push({ r: { x0: x - 0.12, x1: x + 0.12, y0: -2, y1: 6.6 }, z: 6.15, what: `lamp ${x}` });
      blockers.push({ r: { x0: x - 0.2, x1: x + 0.2, y0: 6.2, y1: 6.6 }, z: 4.3, what: `lamp head ${x}` });
    }
    const a: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const o: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    for (const { pose } of poses()) {
      for (const s of slots) {
        const [w, h] = s.size;
        projectToPlane({ x0: s.pos[0] - w / 2, x1: s.pos[0] + w / 2, y0: s.pos[1] - h / 2, y1: s.pos[1] + h / 2 }, s.pos[2], pose.x, pose.y, pose.z, a);
        const area = (a.x1 - a.x0) * (a.y1 - a.y0);
        for (const bl of blockers) {
          if (bl.z <= s.pos[2]) continue; // behind the billboard
          projectToPlane(bl.r, bl.z, pose.x, pose.y, pose.z, o);
          const ov = Math.max(0, Math.min(a.x1, o.x1) - Math.max(a.x0, o.x0)) * Math.max(0, Math.min(a.y1, o.y1) - Math.max(a.y0, o.y0));
          expect(ov / area, `${bl.what} over ${s.slotId}`).toBeLessThan(0.02);
        }
      }
    }
  });
});

describe('sponsored creatives (Deet Studios, WorldStreet) and Motion keyframes (docs/14 §3.3)', () => {
  const advOf = new Map(studio.map((e) => [e.id, e.advertiser]));
  it('only real advertisers: no local house art left, every frame sponsored, never paid', () => {
    expect(pool.screens).toEqual([]);
    expect(pool.hoardings).toEqual([]);
    expect(new Set(advOf.values())).toEqual(new Set(['deet', 'worldstreet']));
    for (const seed of [0, 1, 2, 3, 4, 99]) {
      const m = houseManifest('street-market', slots, pool, seed);
      for (const s of m.slots) for (const f of s.frames) {
        expect(advOf.has(f.c), f.c).toBe(true);
        expect(f.paid).toBe(false);
        expect(f.click).toBeDefined();
      }
      for (const s of m.slots.slice(0, 4)) expect(s.frames).toEqual(m.slots[0]!.frames); // one shared set
    }
  });

  it('every board on the Street Market shows a sponsor’s creative, whose files ship: 4 Screens and 2 Hoardings, at every moment', () => {
    expect(slots.filter((s) => s.format === '4:3')).toHaveLength(4);
    expect(slots.filter((s) => s.format === '6:1')).toHaveLength(2);
    const ads = new URL('public/assets/ads/street_market/', WEB);
    let deet = 0;
    let shown = 0;
    for (let seed = 0; seed < 30; seed++) {
      const m = houseManifest('street-market', slots, pool, seed);
      expect(m.slots.map((s) => s.slot)).toEqual(slots.map((s) => s.slotId));
      for (let t = 0; t < 60_000; t += 2_500) {
        slots.forEach((slot, i) => {
          const f = m.slots[i]!.frames[frameIndex(slot, t)];
          expect(f, `${slot.slotId} seed ${seed} at ${t}`).toBeDefined();
          const e = studio.find((x) => x.id === f!.c)!;
          expect(e, f!.c).toBeDefined();
          for (const file of [e.file, e.ktx2!, ...(e.keys ?? []).flatMap((k) => [k.file, k.ktx2!])]) expect(existsSync(new URL(file, ads)), file).toBe(true);
          shown++;
          if (e.advertiser === 'deet') deet++;
        });
      }
    }
    expect(deet / shown).toBeGreaterThan(0.6);
    expect(deet / shown).toBeLessThan(0.72);
  });

  it('a pool cached from before 23 Oct (its sponsors under `studio`, local art beside them) still shows only sponsors', () => {
    const old = { ...pool, sponsored: undefined, studio: pool.sponsored, screens: [{ id: 'house:sm-bakery', file: 'sm-bakery.webp', title: 'gone' }], hoardings: [{ id: 'house:sm-trees', file: 'sm-trees.webp', title: 'gone' }] } as unknown as HousePool;
    for (let seed = 0; seed < 10; seed++) {
      const m = houseManifest('street-market', slots, old, seed);
      for (const f of m.slots.flatMap((s) => s.frames)) expect(advOf.has(f.c), f.c).toBe(true);
    }
    expect(adsUrl('/assets/ads/street_market/house.json', 'abc123')).toBe('/assets/ads/street_market/house.json?v=abc123');
  });

  it('Deet gets two thirds of the boards and WorldStreet a third, spread out, on Screens and Hoardings alike', () => {
    expect(sponsorTurns([2, 1], 6)).toEqual([0, 1, 0, 0, 1, 0]);
    expect(pool.advertisers?.deet?.weight).toBe(2);
    expect(pool.advertisers?.worldstreet?.weight).toBe(1);
    const screens = new Map<string, number>();
    const hoardings = new Map<string, number>();
    const add = (m: Map<string, number>, c: string) => m.set(advOf.get(c)!, (m.get(advOf.get(c)!) ?? 0) + 1);
    for (let seed = 1000; seed < 1300; seed++) {
      const m = houseManifest('street-market', slots, pool, seed);
      const f = m.slots[0]!.frames;
      // every match: 4 Deet frames and 2 WorldStreet, never two WorldStreet in a row
      expect(f.map((x) => advOf.get(x.c))).toEqual(['deet', 'worldstreet', 'deet', 'deet', 'worldstreet', 'deet']);
      for (const x of f) add(screens, x.c);
      for (const s of m.slots.slice(4)) add(hoardings, s.frames[0]!.c);
    }
    expect(screens.get('deet')).toBe(1200);
    expect(screens.get('worldstreet')).toBe(600);
    expect(hoardings.get('deet')).toBe(400);
    expect(hoardings.get('worldstreet')).toBe(200);
  });

  it('Deet’s frames don’t repeat: a match never shows one creative twice, and the next match moves on', () => {
    const deet = pool.sponsored.screens.filter((e) => e.advertiser === 'deet');
    expect(deet.length).toBeGreaterThanOrEqual(12);
    let prev: string[] = [];
    for (let seed = 0; seed < 30; seed++) {
      const m = houseManifest('street-market', slots, pool, seed);
      const ids = m.slots[0]!.frames.map((f) => f.c);
      expect(new Set(ids).size).toBe(ids.length);
      const hoard = m.slots.slice(4).map((s) => s.frames[0]!.c);
      expect(new Set(hoard).size).toBe(hoard.length);
      const shownDeet = ids.filter((c) => advOf.get(c) === 'deet');
      expect(shownDeet.some((c) => prev.includes(c)), `match ${seed} repeats the last match's Deet frames`).toBe(false);
      prev = shownDeet;
    }
  });

  it('a category can be left off the boards (finance per region or audience); the advertiser keeps its share with the rest', () => {
    expect(DEFAULT_HOUSE_OPTIONS.blockedCategories?.size ?? 0).toBe(0); // the owner approved finance, 23 Oct
    const blocked = new Set(['finance']);
    const finance = new Set(studio.filter((e) => e.category === 'finance').map((e) => e.id));
    expect(finance.size).toBeGreaterThanOrEqual(2);
    for (let seed = 0; seed < 40; seed++) {
      const m = houseManifest('street-market', slots, pool, seed, { blockedCategories: blocked });
      for (const f of m.slots.flatMap((s) => s.frames)) expect(finance.has(f.c), f.c).toBe(false);
      expect(m.slots[0]!.frames.filter((f) => advOf.get(f.c) === 'worldstreet')).toHaveLength(2);
      expect(checkManifest(m, slots, (c) => poolEntries(pool).some((e) => e.id === c))).toEqual([]);
    }
    // only one advertiser left: it takes every frame, all different
    const deetOnly: HousePool = { ...pool, sponsored: { screens: pool.sponsored.screens.filter((e) => e.advertiser === 'deet'), hoardings: pool.sponsored.hoardings.filter((e) => e.advertiser === 'deet') } };
    for (let seed = 0; seed < 10; seed++) {
      const f = houseManifest('street-market', slots, deetOnly, seed).slots[0]!.frames;
      expect(f.every((x) => advOf.get(x.c) === 'deet')).toBe(true);
      expect(new Set(f.map((x) => x.c)).size).toBe(6);
    }
  });

  it('Motion frames carry their keyframe count; the manifest check bounds it (≤ 4 keyframes)', () => {
    const motion = pool.sponsored.screens.filter((e) => e.keys?.length);
    expect(motion.length).toBeGreaterThanOrEqual(2);
    const frames = Array.from({ length: 40 }, (_, seed) => houseManifest('street-market', slots, pool, seed, {}).slots[0]!.frames).flat();
    for (const e of motion) expect(frames.find((f) => f.c === e.id)?.k).toBe(e.keys!.length + 1);
    const m = houseManifest('street-market', slots, pool, 0);
    const bad: AdManifest = { ...m, slots: m.slots.map((s, i) => (i === 0 ? { ...s, frames: s.frames.map((f, j) => (j === 0 ? { ...f, k: MAX_KEYS + 1 } : f)) } : s)) };
    expect(checkManifest(bad, slots, () => true)).toHaveLength(1);
  });

  it('keyframes: each shown ≥ 1.5 s, crossfades ≤ 0.3 s, far under 3 changes a second, restarting at every beat', () => {
    expect(KEY_MS).toBeGreaterThanOrEqual(1_500);
    expect(KEY_FADE_MS).toBeLessThanOrEqual(300);
    expect(MAX_KEYS).toBe(4);
    // segment lengths over one 10 s dwell, sampled every ms
    const lengths = new Map<number, number>();
    for (let t = 0; t < 10_000; t++) lengths.set(keySegment(t), (lengths.get(keySegment(t)) ?? 0) + 1);
    expect([...lengths.keys()]).toEqual([0, 1, 2, 3, 4, 5]);
    for (const n of lengths.values()) expect(n).toBeGreaterThanOrEqual(1_500);
    expect(keySegment(10_000)).toBe(0);
    expect(keyFade(500)).toBe(1); // no keyframe change inside the first segment
    expect(keyFade(1_500)).toBe(0);
    expect(keyFade(1_650)).toBeCloseTo(0.5, 9);
    expect(keyFade(1_800)).toBe(1);
    // changes per second in any 1 s window: the beat's or a keyframe's start, never more than one
    for (let t = 0; t < 20_000; t += 50) {
      let changes = 0;
      for (let u = t + 1; u <= t + 1_000; u++) if (keySegment(u) !== keySegment(u - 1) || frameIndex(slots[0]!, u) !== frameIndex(slots[0]!, u - 1)) changes++;
      expect(changes).toBeLessThanOrEqual(1);
    }
  });

  it('a keyframe change is never a flash: keyframes of a Motion creative stay within 0.1 of each other’s mean luminance', () => {
    for (const e of studio.filter((x) => x.keys?.length)) {
      const l = e.keyLuminance!;
      expect(l).toHaveLength(e.keys!.length + 1);
      expect(Math.max(...l) - Math.min(...l), e.id).toBeLessThan(0.1);
      expect(e.luminance).toBe(Math.max(...l));
    }
  });

  it('rotation fades a Motion creative between its keyframe layers, and from the last keyframe at the beat', () => {
    const screens = slots.filter((s) => s.format === '4:3');
    // a match whose frame 0 is a Motion creative
    const seed = Array.from({ length: 40 }, (_, i) => i).find((i) => houseManifest('street-market', slots, pool, i).slots[0]!.frames[0]!.k === 2)!;
    const m = houseManifest('street-market', slots, pool, seed);
    const f0 = m.slots[0]!.frames[0]!;
    expect(f0.k).toBe(2);
    const keyed = keyframeLayers(referencedCreatives(m, slots, '4:3'), (id) => (poolEntries(pool).find((e) => e.id === id)?.keys?.length ?? 0) + 1);
    expect(keyed).toContain(`${f0.c}#1`);
    const layers = layerTable(keyed);
    const k0 = layers.get(f0.c)!;
    const k1 = layers.get(`${f0.c}#1`)!;
    const s1 = screens[0]!; // phase 0: frame 0 during the first beat
    let st = rotationState(screens, m, layers, 1_000);
    expect([st.layers[0], st.layers[1], st.fade]).toEqual([k0, k0, 1]);
    st = rotationState(screens, m, layers, 1_650);
    expect([st.layers[0], st.layers[1]]).toEqual([k0, k1]);
    expect(st.fade).toBeCloseTo(0.5, 9);
    st = rotationState(screens, m, layers, 2_000);
    expect([st.layers[0], st.layers[1], st.fade]).toEqual([k1, k1, 1]);
    // the dwell ends on segment 5 (keyframe 1); the next beat fades from it into the next frame
    st = rotationState(screens, m, layers, 10_250);
    expect(st.layers[0]).toBe(k1);
    expect(st.layers[1]).toBe(layers.get(m.slots[0]!.frames[frameIndex(s1, 10_250)]!.c));
    expect(st.fade).toBeCloseTo(0.5, 9);
    // the decoded fallback has no keyframe layers: the first keyframe stands as a still
    const stills = layerTable(referencedCreatives(m, slots, '4:3'));
    st = rotationState(screens, m, stills, 2_000);
    expect([st.layers[0], st.layers[1]]).toEqual([stills.get(f0.c), stills.get(f0.c)]);
  });
});

describe('GPU memory and airtime (review M1)', () => {
  it('a match uploads only the creatives it shows: 6 Screens + 2 Hoardings, under the 5.1 MB pool plan, no chip for house art', () => {
    for (const seed of [0, 1, 1234, 4_000_000_000]) {
      const m = houseManifest('street-market', slots, pool, seed);
      expect(referencedCreatives(m, slots, '4:3')).toHaveLength(6);
      expect(referencedCreatives(m, slots, '6:1')).toHaveLength(2);
      const bytes = plannedGpuBytes(m, slots);
      expect(bytes).toBe(6 * layerBytes(FORMATS['4:3']) + 2 * layerBytes(FORMATS['6:1']));
      expect(bytes).toBeLessThanOrEqual(AD_POOL_BUDGET);
      expect(bytes / 1e6).toBeCloseTo(4.87, 1); // decimal MB, as the review counts
    }
    // a paid frame adds only the small chip texture
    const house = houseManifest('street-market', slots, pool, 0);
    const paid: AdManifest = { ...house, slots: house.slots.map((s, i) => (i === 0 ? { ...s, frames: s.frames.map((f, k) => (k === 0 ? { ...f, paid: true } : f)) } : s)) };
    expect(plannedGpuBytes(paid, slots) - plannedGpuBytes(house, slots)).toBeLessThan(70 * 1024);
  });

  it('every client in a match builds the same set, and over matches every pool creative is shown (and every allowed one with a category blocked)', () => {
    expect(houseManifest('street-market', slots, pool, 77)).toEqual(houseManifest('street-market', slots, pool, 77));
    for (const opts of [DEFAULT_HOUSE_OPTIONS, { blockedCategories: new Set(['finance']) }] as HouseOptions[]) {
      const seen = new Set<string>();
      for (let match = 0; match < 24; match++) {
        const m = houseManifest('street-market', slots, pool, 1234 + match, opts);
        for (const f of ['4:3', '6:1'] as const) for (const c of referencedCreatives(m, slots, f)) seen.add(c);
      }
      const want = poolEntries(pool).filter((e) => !e.category || !opts.blockedCategories?.has(e.category));
      expect([...seen].sort()).toEqual(want.map((e) => e.id).sort());
    }
    // nothing is held back by default (the owner approved WorldStreet's finance creatives, 23 Oct)
    expect(DEFAULT_HOUSE_OPTIONS.blockedCategories).toEqual(new Set());
  });

  it('the boards follow the match seed, unless a manifest was set from outside (the paid flow)', () => {
    const boards = new AdBoards('street-market', slots, pool, '/');
    const cam = new Camera();
    cam.resize(1280, 720);
    const pose = planePose(cam);
    boards.update(0, pose, 1 / 60, 5);
    expect(boards.manifest).toEqual(houseManifest('street-market', slots, pool, 5));
    boards.update(16, pose, 1 / 60, 6);
    expect(boards.manifest).toEqual(houseManifest('street-market', slots, pool, 6));
    const pinned = houseManifest('street-market', slots, pool, 2);
    boards.setManifest(pinned);
    boards.update(32, pose, 1 / 60, 9);
    expect(boards.manifest).toBe(pinned);
    expect(boards.gpuBytes()).toBeLessThanOrEqual(AD_POOL_BUDGET);
    boards.dispose();
  });
});

describe('the renderer', () => {
  it('draws every ad with at most two draw calls: one instanced mesh per format', () => {
    const boards = new AdBoards('street-market', slots, pool, '/');
    expect(boards.meshes).toHaveLength(2);
    expect(boards.meshes.map((m) => m.count).sort()).toEqual([2, 4]);
    for (const m of boards.meshes) {
      expect(m.material.fog).toBe(false);
      expect(m.material.userData.noBloom).toBe(true);
    }
    expect(FORMATS['4:3'].width / FORMATS['4:3'].height).toBeCloseTo(4 / 3, 9);
    expect(FORMATS['6:1'].width / FORMATS['6:1'].height).toBeCloseTo(6, 9);
    boards.dispose();
  });
});
