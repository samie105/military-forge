/**
 * Billboards are unlit (docs/14 §4.5), so a look's `adTint` alone sets how bright they are, while
 * the kit around them darkens with the look's light. docs/14 §3.4 wants a creative no brighter than
 * the kit around it, and players the highest-contrast thing on screen (§1.3 rule 4).
 *
 * The model: every camera-facing kit surface within a slot's neighbourhood is shaded on the CPU the
 * way three's Lambert material shades it (graded vertex colour × the weathering map's mean ×
 * (hemisphere + sun) / π, plus the mid layer's haze lift); its p95 is "the kit around the board".
 * The board is the brightest house creative's mean luminance × the tint. Fog is left out (it only
 * brightens the kit at dusk), so the model is on the strict side.
 *
 * Day is the reference: the review measured its boards at 0.86× the nearby kit on screen, which
 * reads fine. Every other look must keep the median board/kit ratio at most day's, and not more
 * than 20% under it (the boards stay readable).
 */
import { readFileSync } from 'node:fs';
import { Color, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { environmentFor } from '../../environment';
import { layoutItems, type KitLayout } from '../../environment/layout';
import { mapGrade, type EnvironmentLook } from '../../environment/looks';
import { kitPieces, mergeLayer, type KitPiece } from '../../environment/merge';
import type { AdSlot } from '..';

const WEB = new URL('../../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, WEB));
const json = <T>(p: string) => JSON.parse(read(p).toString()) as T;
type Lum = { luminance: number };
/** the weathering map's mean (textures.ts grimeTexture: ≈ 0.92) */
const GRIME_MEAN = 0.92;

const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** A map's kit, layout and ad slots, and its pool's creatives (local house art and sponsored). */
interface Scene {
  pieces: Map<string, KitPiece>;
  layout: KitLayout;
  slots: AdSlot[];
  creatives: Lum[];
}

async function scene(folder: string, pool: string): Promise<Scene> {
  const buf = read(`public/assets/kits/${folder}/kit_${folder}.glb`);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const p = json<{ screens: Lum[]; hoardings: Lum[]; sponsored?: { screens: Lum[]; hoardings: Lum[] } }>(`public/assets/ads/${pool}/house.json`);
  return {
    pieces: kitPieces(gltf.scene),
    layout: json<KitLayout>(`public/assets/kits/${folder}/${folder}.layout.json`),
    slots: json<AdSlot[]>(`public/assets/kits/${folder}/${folder}.adslots.json`),
    creatives: [...p.screens, ...p.hoardings, ...(p.sponsored?.screens ?? []), ...(p.sponsored?.hoardings ?? [])],
  };
}

let market: Scene;
let fog: Scene;
beforeAll(async () => {
  market = await scene('street_market', 'street_market');
  fog = await scene('fog_stair', 'fog_stair');
});

/** board / kit-p95 per slot under `look`. */
function ratios(look: EnvironmentLook, { pieces, layout, slots, creatives }: Scene = market): number[] {
  const grade = mapGrade(look);
  const items = layoutItems(layout);
  const sky = new Color(look.hemi.sky);
  const ground = new Color(look.hemi.ground);
  const sun = new Color(look.sun.color);
  const dir = new Vector3(...look.sun.dir).normalize();
  const lift = new Color(look.grade.haze).multiplyScalar(look.midLift);
  const layers = (['gameplay', 'mid'] as const).map((layer) => ({ layer, g: mergeLayer(pieces, items, layer, { grade })! }));
  const brightest = Math.max(...creatives.map((e) => e.luminance));
  const board = brightest * lum(new Color(look.adTint));
  const irr = new Color();
  const out = new Color();
  return slots.map((slot) => {
    const vals: number[] = [];
    for (const { layer, g } of layers) {
      const p = g.attributes.position!;
      const n = g.attributes.normal!;
      const c = g.attributes.color!;
      for (let i = 0; i < p.count; i++) {
        if (n.getZ(i) < 0.5) continue; // facing the camera
        if (Math.abs(p.getX(i) - slot.pos[0]) > 14 || Math.abs(p.getY(i) - slot.pos[1]) > 10 || p.getZ(i) < slot.pos[2] - 3) continue;
        const up = 0.5 * n.getY(i) + 0.5;
        irr.copy(ground).lerp(sky, up).multiplyScalar(look.hemi.intensity);
        const dot = Math.max(0, n.getX(i) * dir.x + n.getY(i) * dir.y + n.getZ(i) * dir.z);
        irr.r += sun.r * look.sun.intensity * dot;
        irr.g += sun.g * look.sun.intensity * dot;
        irr.b += sun.b * look.sun.intensity * dot;
        out.setRGB(c.getX(i), c.getY(i), c.getZ(i)).multiplyScalar(GRIME_MEAN / Math.PI).multiply(irr);
        if (layer === 'mid') out.add(lift);
        vals.push(lum(out));
      }
    }
    vals.sort((a, b) => a - b);
    return board / vals[Math.floor(vals.length * 0.95)]!;
  });
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
};

describe('billboard brightness per look (docs/14 §3.4)', () => {
  it('no look makes the boards stand out more against the kit than daylight does, nor fade them out', () => {
    const looks = environmentFor('street-market')!.looks;
    const day = median(ratios(looks.day!));
    for (const [name, look] of Object.entries(looks)) {
      const m = median(ratios(look));
      expect(m, `${name}: median board/kit ${m.toFixed(2)} vs day ${day.toFixed(2)}`).toBeLessThanOrEqual(day * 1.03);
      expect(m, `${name}: median board/kit ${m.toFixed(2)} vs day ${day.toFixed(2)}`).toBeGreaterThanOrEqual(day * 0.8);
    }
  });

  it('Fog Stair’s boards sit in its fog as the market’s sit in daylight: no brighter against the kit around them, nor faded out', () => {
    const day = median(ratios(environmentFor('street-market')!.looks.day!));
    const m = median(ratios(environmentFor('fog-stair')!.looks.fog!, fog));
    expect(m, `fog: median board/kit ${m.toFixed(2)} vs the market's day ${day.toFixed(2)}`).toBeLessThanOrEqual(day * 1.03);
    expect(m, `fog: median board/kit ${m.toFixed(2)} vs the market's day ${day.toFixed(2)}`).toBeGreaterThanOrEqual(day * 0.8);
  });

  it('the house art records its luminance (house-ads.py), so the model reads the real creatives', () => {
    for (const e of market.creatives) {
      // real pixels, not a missing value: the darkest is Deet's ink-black Hoarding (≈ 0.09)
      expect(e.luminance).toBeGreaterThan(0.05);
      expect(e.luminance).toBeLessThan(0.9);
    }
  });

  it('no creative is brighter than the street’s old house art was (0.48: an advertiser never outshines the street)', () => {
    // the brightest local house art before the owner removed it (23 Oct): Harbour Fish Market, 0.4797
    for (const e of market.creatives) expect(e.luminance).toBeLessThanOrEqual(0.48);
  });
});
