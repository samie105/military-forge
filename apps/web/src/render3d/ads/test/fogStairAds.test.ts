/**
 * Fog Stair's billboards (docs/14; the owner, 26 Oct: "the billboards and all, all with the Chinese
 * view"): vertical neon-framed Screens on towers in the gorge, LED Screens over the lower stairs and a
 * Hoarding hung under the monorail's other track, showing the Street Market's sponsored creatives
 * (Deet Studios, WorldStreet) from a pool of Fog Stair's own (house-ads.py --reuse street_market).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fogStairMap } from '@military-forge/content';
import { VIEW_ZOOM_MULTIPLIERS } from '@military-forge/netcode';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../../camera';
import { environmentFor } from '../../environment';
import { layoutItems, placementMatrix, type KitLayout } from '../../environment/layout';
import { kitPieces } from '../../environment/merge';
import { planePose, type PlanePose } from '../../planeCamera';
import { checkManifest, frameIndex, houseManifest, poolEntries, type AdSlot, type HousePool } from '..';
import { LitLimiter, ON_SCREEN, slotInView } from '../visibility';

const WEB = new URL('../../../../', import.meta.url);
const json = <T>(p: string) => JSON.parse(readFileSync(new URL(p, WEB), 'utf8')) as T;
const def = environmentFor('fog-stair')!;
const slots = json<AdSlot[]>(`public/${def.ads!.slots}`);
const pool = json<HousePool & { files?: string }>(`public/${def.ads!.pool}`);
const market = json<HousePool>('public/assets/ads/street_market/house.json');
const layout = json<KitLayout>(`public/${def.layoutUrl!}`);

/** Camera poses across Fog Stair at every zoom, x and y across the clamp range. */
function poses(width = 1280, height = 720, zooms = VIEW_ZOOM_MULTIPLIERS.length): { zoom: number; pose: PlanePose }[] {
  const b = fogStairMap.bounds;
  const out: { zoom: number; pose: PlanePose }[] = [];
  for (let zoom = 0; zoom < zooms; zoom++) {
    const cam = new Camera();
    cam.resize(width, height);
    cam.setZoom(zoom, VIEW_ZOOM_MULTIPLIERS.length);
    const { halfW, halfH } = cam.halfExtents;
    for (let fx = 0; fx <= 1.0001; fx += 0.025) {
      for (let fy = 0; fy <= 1.0001; fy += 0.1) {
        cam.x = b.minX + halfW + fx * (b.maxX - b.minX - 2 * halfW);
        cam.y = b.minY + halfH + fy * (b.maxY - b.minY - 2 * halfH);
        out.push({ zoom, pose: { ...planePose(cam) } });
      }
    }
  }
  return out;
}

describe('Fog Stair’s ad slots (docs/14 §2.6, §4.2)', () => {
  it('six surfaces: four Screens (two vertical neon cabinets in the gorge, two LED Screens over the stairs) and two Hoardings', () => {
    expect(slots.map((s) => s.slotId)).toEqual(['fog-stair/S1', 'fog-stair/S2', 'fog-stair/S3', 'fog-stair/S4', 'fog-stair/H1', 'fog-stair/H2']);
    expect(slots.filter((s) => s.format === '4:3' && s.frames === 6)).toHaveLength(4);
    expect(slots.filter((s) => s.format === '6:1' && s.frames === 1)).toHaveLength(2);
    for (const s of slots) {
      expect(s.pos[2], s.slotId).toBeGreaterThanOrEqual(-9);
      expect(s.pos[2], s.slotId).toBeLessThanOrEqual(-4);
      expect(Math.abs(s.yawDeg)).toBeLessThanOrEqual(20);
    }
    // the map is mirrored about the river: so are its boards
    expect(slots[1]!.pos[0]).toBeCloseTo(240 - slots[0]!.pos[0], 6);
    expect(slots[3]!.pos[0]).toBeCloseTo(240 - slots[2]!.pos[0], 6);
    expect(slots[5]!.pos[0]).toBeCloseTo(240 - slots[4]!.pos[0], 6);
  });

  it('at 1× no view shows more than two surfaces, laptop or phone; every surface in view is lit', () => {
    for (const size of [[1280, 720], [812, 375]] as const) {
      for (const { zoom, pose } of poses(...size)) {
        const inView = slots.filter((s) => slotInView(s, pose).visible >= ON_SCREEN).length;
        if (zoom === 0) expect(inView, `1× at ${pose.x.toFixed(0)}, ${pose.y.toFixed(0)}`).toBeLessThanOrEqual(2);
        const limiter = new LitLimiter(slots);
        for (let i = 0; i < 40; i++) limiter.update(pose, 1 / 60);
        expect(limiter.litOnScreen(pose)).toBe(inView);
      }
    }
  });

  it('nothing of the kit in front of a board covers it: no lantern, pillar, arch or sign (≤ 2% of any board, from any camera)', async () => {
    const buf = readFileSync(new URL(`public/${def.kitUrl!}`, WEB));
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    const pieces = kitPieces(gltf.scene);
    // every placed triangle in world space
    const tris: number[] = [];
    const v = new Vector3();
    for (const item of layoutItems(layout)) {
      const piece = pieces.get(item.piece)!;
      const m = placementMatrix(item);
      const p = piece.geometry.attributes.position!;
      const idx = piece.geometry.index!;
      for (let k = 0; k < idx.count; k++) {
        v.fromBufferAttribute(p, idx.getX(k)).applyMatrix4(m);
        tris.push(v.x, v.y, v.z);
      }
    }
    const N = 24;
    const over: string[] = [];
    for (const s of slots) {
      const [w, h] = s.size;
      const [sx, sy, sz] = s.pos;
      // the camera centred on the board and offset around it, at 1× and the widest zoom
      for (const [dx, dy, cz] of [[0, 0, 32.1], [-12, -6, 32.1], [12, 6, 32.1], [-12, 8, 32.1], [12, -8, 32.1], [0, 0, 73.8]] as const) {
        const cx = sx + dx;
        const cy = sy + dy;
        const covered = new Uint8Array(N * N);
        // each triangle in front of the board, projected from the camera onto the board's plane
        for (let t = 0; t < tris.length; t += 9) {
          const z0 = tris[t + 2]!;
          const z1 = tris[t + 5]!;
          const z2 = tris[t + 8]!;
          if (Math.min(z0, z1, z2) <= sz + 0.25) continue;
          const pr = (k: number): [number, number] => {
            const f = (cz - sz) / (cz - tris[k + 2]!);
            return [cx + (tris[k]! - cx) * f, cy + (tris[k + 1]! - cy) * f];
          };
          const [a, b, c] = [pr(t), pr(t + 3), pr(t + 6)];
          const x0 = Math.min(a[0], b[0], c[0]);
          const x1 = Math.max(a[0], b[0], c[0]);
          const y0 = Math.min(a[1], b[1], c[1]);
          const y1 = Math.max(a[1], b[1], c[1]);
          if (x1 < sx - w / 2 || x0 > sx + w / 2 || y1 < sy - h / 2 || y0 > sy + h / 2) continue;
          const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
          if (Math.abs(d) < 1e-9) continue;
          for (let j = 0; j < N; j++) {
            const py = sy - h / 2 + ((j + 0.5) * h) / N;
            if (py < y0 || py > y1) continue;
            for (let i = 0; i < N; i++) {
              const px = sx - w / 2 + ((i + 0.5) * w) / N;
              if (px < x0 || px > x1) continue;
              const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d;
              const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
              if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) covered[j * N + i] = 1;
            }
          }
        }
        const share = covered.reduce((n, x) => n + x, 0) / (N * N);
        if (share > 0.02) over.push(`${s.slotId} from (${cx}, ${cy}, ${cz}): ${(share * 100).toFixed(1)}%`);
      }
    }
    expect(over).toEqual([]);
  });
});

describe('Fog Stair’s house pool: the Street Market’s sponsors, its own campaign tag', () => {
  it('names the market’s sponsored creatives, whose files ship in the market’s folder (no copies)', () => {
    expect(def.ads!.base).toBe('assets/ads/street_market/');
    expect(pool.map).toBe('fog-stair');
    expect(pool.screens).toEqual([]);
    expect(pool.hoardings).toEqual([]);
    expect(pool.sponsored).toEqual(market.sponsored);
    for (const e of poolEntries(pool)) {
      for (const f of [e.file, e.ktx2, ...(e.keys ?? []).flatMap((k) => [k.file, k.ktx2])]) {
        if (f) expect(existsSync(new URL(`public/${def.ads!.base}${f}`, WEB)), f).toBe(true);
      }
    }
    for (const [k, a] of Object.entries(pool.advertisers ?? {})) {
      expect(a.utm, k).toBe('fog-stair');
      expect({ ...a, utm: undefined }).toEqual({ ...market.advertisers![k], utm: undefined });
    }
  });

  it('every board shows a sponsor, never paid; no two Screens show the same creative at once', () => {
    for (const seed of [0, 1, 2, 7, 99]) {
      const m = houseManifest('fog-stair', slots, pool, seed);
      expect(checkManifest(m, slots, (c) => poolEntries(pool).some((e) => e.id === c))).toEqual([]);
      for (let t = 0; t < 60_000; t += 10_000) {
        const shown = slots.filter((s) => s.frames > 1).map((s) => m.slots.find((x) => x.slot === s.slotId)!.frames[frameIndex(s, t)]!);
        for (const f of shown) expect(f.paid).toBe(false);
        expect(new Set(shown.map((f) => f.c)).size, `seed ${seed} at ${t} ms`).toBe(shown.length);
      }
    }
  });
});
