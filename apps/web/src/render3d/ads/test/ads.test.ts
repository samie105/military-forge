import { readFileSync } from 'node:fs';
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
  FORMATS,
  KEY_FADE_MS,
  KEY_MS,
  MAX_KEYS,
  STUDIO_SCREENS,
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
  type AdManifest,
  type AdSlot,
  type HouseEntry,
  type HousePool,
} from '..';
import { LitLimiter, MAX_LIT, ON_SCREEN, slotInView } from '../visibility';

const WEB = new URL('../../../../', import.meta.url);
const REPO = new URL('../../', WEB);
const json = <T>(url: URL) => JSON.parse(readFileSync(url, 'utf8')) as T;
const slots = json<AdSlot[]>(new URL('public/assets/kits/street_market/street_market.adslots.json', WEB));
/** what house-ads.py records next to each creative */
type Checked = HouseEntry & { signalHues: Record<string, number>; luminance: number; keyLuminance?: number[] };
const pool = json<Omit<HousePool, 'screens' | 'hoardings' | 'studio'> & { screens: Checked[]; hoardings: Checked[]; studio: { screens: Checked[]; hoardings: Checked[] } }>(new URL('public/assets/ads/street_market/house.json', WEB));
const studio = [...pool.studio.screens, ...pool.studio.hoardings];

/** Camera poses across the Street Market at every zoom: x and y across the clamp range. */
function poses(): { zoom: number; pose: PlanePose }[] {
  const b = streetMarketMap.bounds;
  const out: { zoom: number; pose: PlanePose }[] = [];
  for (let zoom = 0; zoom < VIEW_ZOOM_MULTIPLIERS.length; zoom++) {
    const cam = new Camera();
    cam.resize(1280, 720);
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
  it('never more than two surfaces show a creative on screen, at any camera position and zoom', () => {
    let maxVisible = 0;
    for (const { pose } of poses()) {
      const limiter = new LitLimiter(slots);
      for (let i = 0; i < 40; i++) limiter.update(pose, 1 / 60);
      expect(limiter.litOnScreen(pose)).toBeLessThanOrEqual(MAX_LIT);
      maxVisible = Math.max(maxVisible, slots.filter((s) => slotInView(s, pose).visible >= ON_SCREEN).length);
    }
    // the wide zooms do see more than two surfaces: the limiter is what keeps it to two
    expect(maxVisible).toBeGreaterThan(MAX_LIT);
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
    expect(pool.screens.length).toBeGreaterThanOrEqual(2);
    expect(pool.hoardings.length).toBeGreaterThanOrEqual(2);
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

describe('the studio’s creatives (Deet Studios) and Motion keyframes (docs/14 §3.3)', () => {
  it('every match shows two studio Screens, spread across the loop, and a studio creative on the first Hoarding; never paid', () => {
    expect(pool.studio.screens.length).toBeGreaterThanOrEqual(STUDIO_SCREENS);
    const ids = new Set(studio.map((e) => e.id));
    for (const seed of [0, 1, 2, 3, 4, 99]) {
      const m = houseManifest('street-market', slots, pool, seed);
      for (const s of m.slots.slice(0, 4)) {
        expect(s.frames.map((f) => ids.has(f.c))).toEqual([true, false, false, true, false, false]);
        expect(s.frames).toEqual(m.slots[0]!.frames); // one shared set
      }
      expect(ids.has(m.slots[4]!.frames[0]!.c)).toBe(true);
      expect(ids.has(m.slots[5]!.frames[0]!.c)).toBe(false);
      for (const f of m.slots.flatMap((s) => s.frames)) expect(f.paid).toBe(false);
    }
  });

  it('Motion frames carry their keyframe count; the manifest check bounds it (≤ 4 keyframes)', () => {
    const motion = pool.studio.screens.filter((e) => e.keys?.length);
    expect(motion.length).toBeGreaterThanOrEqual(2);
    const frames = [0, 1, 2, 3, 4].flatMap((seed) => houseManifest('street-market', slots, pool, seed).slots[0]!.frames);
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
    for (const e of pool.studio.screens.filter((x) => x.keys?.length)) {
      const l = e.keyLuminance!;
      expect(l).toHaveLength(e.keys!.length + 1);
      expect(Math.max(...l) - Math.min(...l), e.id).toBeLessThan(0.1);
      expect(e.luminance).toBe(Math.max(...l));
    }
  });

  it('rotation fades a Motion creative between its keyframe layers, and from the last keyframe at the beat', () => {
    const screens = slots.filter((s) => s.format === '4:3');
    const m = houseManifest('street-market', slots, pool, 1); // seed 1: frame 0 is the first Motion creative
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

  it('every client in a match builds the same set, and over matches every pool creative is shown', () => {
    expect(houseManifest('street-market', slots, pool, 77)).toEqual(houseManifest('street-market', slots, pool, 77));
    const seen = new Set<string>();
    for (let match = 0; match < 8; match++) {
      const m = houseManifest('street-market', slots, pool, 1234 + match);
      for (const f of ['4:3', '6:1'] as const) for (const c of referencedCreatives(m, slots, f)) seen.add(c);
    }
    expect([...seen].sort()).toEqual(poolEntries(pool).map((e) => e.id).sort());
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
