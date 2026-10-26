/**
 * Fog Stair (maps-vertical; the owner's pick, 23 Oct; the kit, 26 Oct: "it should look bespoke …
 * Chinese surroundings, the billboards and all"): its kit draws the play plane, and the kit's pieces,
 * where the layout places them, collide exactly like the map registered in packages/content
 * (render = collision, docs/11 §2: fogStair.ts came first, the kit was fitted to it). Behind the
 * plane everything sinks into the river fog; lettered pieces are never mirrored.
 */
import { readFileSync } from 'node:fs';
import { fogStairMap, maps, type MapDef } from '@military-forge/content';
import { Vector3, type BufferGeometry, type Mesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { MapEnvironment, environmentFor } from '../index';
import { layoutItems, placePoint, placementMatrix, type KitLayout } from '../layout';
import { mapGrade } from '../looks';
import { kitPieces } from '../merge';

const WEB = new URL('../../../../', import.meta.url);
const REPO = new URL('../../', WEB);
const read = (url: URL) => readFileSync(url);
const json = <T>(url: URL) => JSON.parse(read(url).toString()) as T;
const shipped = json<KitLayout>(new URL('public/assets/kits/fog_stair/fog_stair.layout.json', WEB));
const kitBytes = read(new URL('public/assets/kits/fog_stair/kit_fog_stair.glb', WEB));
const fetchPublic = async (url: string): Promise<unknown> => JSON.parse(read(new URL(`public/${url.replace(/^\//, '').replace(/\?.*$/, '')}`, WEB)).toString());

interface PieceExtras {
  layer?: string;
  material?: number;
  solids?: number[][];
  oneWays?: [number, number, number, number][];
  blocksBullets?: boolean;
  bulletOnly?: number[][];
  bulletOnlyMaterial?: number;
  noFlip?: boolean;
}

/** The GLB's JSON chunk (node extras), without decoding any geometry. */
function glbJson(buf: Uint8Array): { nodes: { name?: string; extras?: Record<string, unknown> }[] } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const length = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + length)));
}

const kit = Object.fromEntries(
  glbJson(kitBytes)
    .nodes.filter((n) => n.extras?.kitPiece)
    .map((n) => [n.name!, n.extras as PieceExtras]),
);

type Pt = [number, number];
const pairs = (flat: readonly number[]): Pt[] => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i]!, flat[2 * i + 1]!]);

function inside(px: number, py: number, pts: readonly Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The collision the layout's gameplay pieces carry, placed the way compile_map.py places it. */
function kitCollision(layout: KitLayout) {
  const solids: { pts: Pt[]; material: number }[] = [];
  const oneWays: string[] = [];
  const bulletOnly: string[] = [];
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const rectKey = (pts: readonly Pt[], material: number) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), material].map(r).join(',');
  };
  for (const item of layout.pieces) {
    const pc = kit[item.piece]!;
    for (const poly of pc.solids ?? []) solids.push({ pts: pairs(poly).map(([x, y]) => placePoint(item, x, y)), material: pc.material ?? 0 });
    for (const [ax, ay, bx, by] of pc.oneWays ?? []) {
      const a = placePoint(item, ax, ay);
      const b = placePoint(item, bx, by);
      const [p, q] = a[0] <= b[0] ? [a, b] : [b, a];
      oneWays.push([...p, ...q].map(r).join(',') + (pc.blocksBullets ? ' slab' : ''));
    }
    for (const poly of pc.bulletOnly ?? []) bulletOnly.push(rectKey(pairs(poly).map(([x, y]) => placePoint(item, x, y)), pc.bulletOnlyMaterial ?? pc.material ?? 0));
  }
  return { solids, oneWays: oneWays.sort(), bulletOnly: bulletOnly.sort(), rectKey, r };
}

describe('Fog Stair: render = collision', () => {
  it('ships the art pipeline’s layout and ad slots unchanged, and the map copy the kit was checked against is the registered map', () => {
    expect(shipped).toEqual(json(new URL('art/maps/fog_stair/layout.json', REPO)));
    expect(json(new URL('public/assets/kits/fog_stair/fog_stair.adslots.json', WEB))).toEqual(json(new URL('art/maps/fog_stair/fog_stair.adslots.json', REPO)));
    // pnpm --filter @military-forge/content export-map fog-stair ../../art/maps/fog_stair/fog_stair.map.json (then compile_map.py)
    expect(json(new URL('art/maps/fog_stair/fog_stair.map.json', REPO))).toEqual(JSON.parse(JSON.stringify(fogStairMap)));
    expect(shipped.bounds).toEqual(fogStairMap.bounds);
  });

  it('every placed piece is in the kit; gameplay pieces in `pieces`, the rest in `decor`; nothing with lettering is mirrored', () => {
    for (const item of layoutItems(shipped)) {
      expect(kit[item.piece], item.piece).toBeDefined();
      if (kit[item.piece]!.noFlip) expect(item.flip ?? false, `${item.piece} at x ${item.x}`).toBe(false);
    }
    for (const item of shipped.pieces) expect(kit[item.piece]!.layer ?? 'gameplay', item.piece).toBe('gameplay');
    for (const item of shipped.decor ?? []) expect(kit[item.piece]!.layer, item.piece).not.toBe('gameplay');
  });

  it('the kit collides exactly like fogStair.ts: the same one-ways (slabs), bullet-only parts and solids (the ceiling left undrawn)', () => {
    const { solids, oneWays, bulletOnly, rectKey, r } = kitCollision(shipped);
    const map: MapDef = fogStairMap;
    expect(oneWays).toEqual(map.oneWays.map((o) => [o.ax, o.ay, o.bx, o.by].map(r).join(',') + (o.blocksBullets ? ' slab' : '')).sort());
    expect(bulletOnly).toEqual((map.bulletOnly ?? []).map((p) => rectKey(pairs(p.points), p.material ?? 1)).sort());
    const b = map.bounds;
    const ceiling = (pts: readonly Pt[]) => Math.max(...pts.map((p) => p[1])) === b.maxY && Math.min(...pts.map((p) => p[0])) <= b.minX && Math.max(...pts.map((p) => p[0])) >= b.maxX;
    const mapSolids = map.solids.map((s) => ({ pts: pairs(s.points), material: s.material ?? 0 })).filter((s) => !ceiling(s.pts));
    expect(mapSolids.length).toBe(map.solids.length - 1);
    const materialAt = (list: readonly { pts: Pt[]; material: number }[], x: number, y: number) => list.find((s) => inside(x, y, s.pts))?.material ?? null;
    let checked = 0;
    for (let y = b.minY + 0.137; y < b.maxY; y += 0.5) {
      for (let x = b.minX + 0.061; x < b.maxX; x += 0.5) {
        expect(materialAt(solids, x, y), `(${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(materialAt(mapSolids, x, y));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });

  it('what has no collision and stands on the gameplay plane (signs, lights) is drawn on a solid’s face', async () => {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(kitBytes.buffer.slice(kitBytes.byteOffset, kitBytes.byteOffset + kitBytes.byteLength), '');
    const pieces = kitPieces(gltf.scene);
    const solids = fogStairMap.solids.map((s) => pairs(s.points));
    const near = (x: number, y: number) => solids.some((pts) => [[0, 0], [0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]].some(([dx, dy]) => inside(x + dx!, y + dy!, pts)));
    const [a, b, c, v] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    let onPlane = 0;
    for (const item of layoutItems(shipped)) {
      const piece = pieces.get(item.piece)!;
      const ex = piece.extras as PieceExtras;
      // the river's surface is a zone's top (water), drawn flat
      if ((ex.solids?.length ?? 0) + (ex.oneWays?.length ?? 0) + (ex.bulletOnly?.length ?? 0) > 0 || piece.layer === 'mid' || item.piece === 'fs_river') continue;
      const m = placementMatrix(item);
      const g = piece.geometry;
      const p = g.attributes.position!;
      const idx = g.index!;
      // every triangle, sampled on a barycentric grid: what lies within the capsule radius of the plane
      for (let t = 0; t < idx.count; t += 3) {
        a.fromBufferAttribute(p, idx.getX(t)).applyMatrix4(m);
        b.fromBufferAttribute(p, idx.getX(t + 1)).applyMatrix4(m);
        c.fromBufferAttribute(p, idx.getX(t + 2)).applyMatrix4(m);
        if (Math.min(a.z, b.z, c.z) >= 0.35 || Math.max(a.z, b.z, c.z) <= -0.35) continue;
        for (let i = 0; i <= 6; i++) {
          for (let j = 0; i + j <= 6; j++) {
            v.copy(a).multiplyScalar(1 - (i + j) / 6).addScaledVector(b, i / 6).addScaledVector(c, j / 6);
            if (Math.abs(v.z) >= 0.35) continue;
            onPlane++;
            expect(near(v.x, v.y), `${item.piece} at (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`).toBe(true);
          }
        }
      }
    }
    expect(onPlane).toBeGreaterThan(0); // the station's and the arcade's ceiling lights
  });
});

describe('Fog Stair: the environment', () => {
  const def = environmentFor('fog-stair')!;

  async function build(): Promise<MapEnvironment> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const ab = kitBytes.buffer.slice(kitBytes.byteOffset, kitBytes.byteOffset + kitBytes.byteLength);
    const env = new MapEnvironment(def, maps['fog-stair']!, '/', { loadAsync: () => loader.parseAsync(ab, '') }, fetchPublic);
    await env.ready;
    return env;
  }

  it('has its own look, painted layers, kit and billboards; no street in front, no yard behind', () => {
    expect(def.kitUrl).toBe('assets/kits/fog_stair/kit_fog_stair.glb');
    expect(def.street).toBe(false);
    expect(def.defaultLook).toBe('fog');
    expect(def.backdrop!.skies.fog).toBe('sky.webp');
    expect(def.backdrop!.layers.map((l) => l.name)).toEqual(['far', 'mid']);
    expect(def.ads!.slots).toBe('assets/kits/fog_stair/fog_stair.adslots.json');
  });

  it('draws the play plane from the kit in a few merged meshes: the neon unlit, the billboards in two draws', async () => {
    const env = await build();
    expect(env.drawsPlane).toBe(true);
    const names: string[] = [];
    env.background.traverse((o) => (o as Mesh).isMesh && names.push(o.name));
    for (const n of ['kit-gameplay', 'kit-mid', 'kit-glow', 'sky-art', 'ads-4:3', 'ads-6:1']) expect(names).toContain(n);
    for (const n of ['street', 'yard', 'street-lamp', 'kit-far']) expect(names).not.toContain(n);
    expect(env.foreground).toHaveLength(0); // the no-kit path's railings (one draw each) are gone
    // the static environment: the painted sky, 7 skyline panels, 3 kit layers, contact shadows and the
    // two billboard formats (the gradient sky hides once the painted one is in)
    expect(names.filter((n) => n !== 'sky').length, names.join(' ')).toBeLessThanOrEqual(14);
    const glow = env.background.getObjectByName('kit-glow') as Mesh;
    expect((glow.material as { type: string }).type).toBe('MeshBasicMaterial');
    // the triangle budget: under the Street Market's frame on a phone (docs/11 §3: ≤ 150K visible on Low)
    let tris = 0;
    for (const n of ['kit-gameplay', 'kit-mid', 'kit-glow']) tris += ((env.background.getObjectByName(n) as Mesh).geometry as BufferGeometry).index!.count / 3;
    expect(tris).toBeLessThan(60_000);
    env.dispose();
  });

  it('what is drawn behind the play plane with no collision reads as background: hazed ≥ 40% from the nearest decor back', async () => {
    const env = await build();
    for (const b of env.decorBoxes) expect(b.max[2], b.piece).toBeLessThan(-1);
    const solidLooking = env.decorBoxes.filter((b) => b.max[1] - b.min[1] >= 2 && b.max[0] - b.min[0] >= 2);
    const nearest = Math.max(...solidLooking.map((b) => b.max[2]));
    const mid = mapGrade(def.looks.fog!).layers.mid;
    expect(Math.min(mid.hazeMax, mid.haze - mid.hazePerM * nearest)).toBeGreaterThanOrEqual(0.4);
    // and the river fog swallows the far side sooner than the Street Market's day
    expect(def.looks.fog!.fog.far).toBeLessThan(environmentFor('street-market')!.looks.day!.fog.far);
    env.dispose();
  });

  it('a painted layer close behind the play plane is hazed toward the river fog', () => {
    const look = def.looks[def.defaultLook]!;
    for (const layer of def.backdrop!.layers) if (layer.z > -16) expect(look.backdropHaze?.amount[layer.name] ?? 0, layer.name).toBeGreaterThanOrEqual(0.3);
  });
});
