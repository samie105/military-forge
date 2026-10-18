/**
 * Street Market: the kit the renderer draws and the collision the sim uses come from the same
 * numbers (render = collision, docs/11 §2), and the environment keeps its dressing out of the
 * gameplay band.
 */
import { readFileSync } from 'node:fs';
import { streetMarketMap, type MapDef } from '@military-forge/content';
import { Box3, Mesh, type BufferGeometry } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { MapEnvironment, environmentFor, withTimeout } from '../index';
import { layoutItems, placePoint, type KitLayout } from '../layout';

const WEB = new URL('../../../../', import.meta.url);
const REPO = new URL('../../', WEB);
const read = (url: URL) => readFileSync(url);
const shipped = JSON.parse(read(new URL('public/assets/kits/street_market/street_market.layout.json', WEB)).toString()) as KitLayout;
const kitBytes = read(new URL('public/assets/kits/street_market/kit_street_market.glb', WEB));
/** The environment's JSON fetches, answered from apps/web/public. */
const fetchPublic = async (url: string): Promise<unknown> => JSON.parse(read(new URL(`public/${url.replace(/^\//, '')}`, WEB)).toString());

/** The GLB's JSON chunk (node extras: collision, layer, adSlot), without decoding any geometry. */
function glbJson(buf: Uint8Array): { nodes: { name?: string; extras?: Record<string, unknown> }[] } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
  const length = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a); // 'JSON'
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + length)));
}

interface PieceExtras {
  layer?: string;
  terrain?: [number, number, number][];
  solids?: number[][];
  oneWays?: [number, number, number, number][];
}

/** compile_map.py's collision for a layout (terrain skyline + ceiling + solids + one-ways), ported. */
function collisionOf(layout: KitLayout, kit: Record<string, PieceExtras>): Pick<MapDef, 'solids' | 'oneWays'> {
  const EPS = 1e-6;
  const b = layout.bounds;
  const intervals: [number, number, number][] = [];
  const solids: number[][] = [];
  const oneWays: [number, number, number, number][] = [];
  for (const item of layout.pieces) {
    const pc = kit[item.piece]!;
    for (const [x0, x1, h] of pc.terrain ?? []) {
      const a = placePoint(item, x0, 0)[0];
      const c = placePoint(item, x1, 0)[0];
      intervals.push([Math.min(a, c), Math.max(a, c), h]);
    }
    for (const poly of pc.solids ?? []) {
      const pts: [number, number][] = [];
      for (let i = 0; i < poly.length; i += 2) pts.push(placePoint(item, poly[i]!, poly[i + 1]!));
      if (item.flip) pts.reverse();
      solids.push(pts.flat());
    }
    for (const [ax, ay, bx, by] of pc.oneWays ?? []) {
      const pa = placePoint(item, ax, ay);
      const pb = placePoint(item, bx, by);
      oneWays.push(pa[0] <= pb[0] ? [...pa, ...pb] : [...pb, ...pa]);
    }
  }
  const xs = [...new Set([b.minX, b.maxX, ...intervals.flatMap(([a, c]) => [a, c])])].filter((v) => v >= b.minX - EPS && v <= b.maxX + EPS).sort((u, v) => u - v);
  const top: [number, number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i]!;
    const c = xs[i + 1]!;
    const m = (a + c) / 2;
    const h = Math.max(...intervals.filter(([u, v]) => u - EPS <= m && m <= v + EPS).map(([, , hh]) => hh));
    const last = top[top.length - 1];
    if (last && Math.abs(last[1] - h) < EPS) last[2] = c;
    else top.push([a, h, c]);
  }
  const terrain: [number, number][] = [[b.minX, b.minY]];
  for (const [a, h, c] of top) terrain.push([a, h], [c, h]);
  terrain.push([b.maxX, b.minY]);
  const clean = terrain.filter((p, i) => i === 0 || Math.abs(p[0] - terrain[i - 1]![0]) > EPS || Math.abs(p[1] - terrain[i - 1]![1]) > EPS);
  const ceil = b.maxY - 2;
  return {
    solids: [{ points: clean.flat() }, { points: [b.minX, ceil, b.maxX, ceil, b.maxX, b.maxY, b.minX, b.maxY] }, ...solids.map((points) => ({ points }))],
    oneWays: oneWays.map(([ax, ay, bx, by]) => ({ ax, ay, bx, by })),
  };
}

const r = (v: number) => Math.round(v * 1000) / 1000;
const polyKey = (p: { points: number[] }) => p.points.map(r).join(',');

describe('Street Market: render = collision', () => {
  const kitJson = glbJson(kitBytes);
  const kit = Object.fromEntries(kitJson.nodes.filter((n) => n.extras?.kitPiece).map((n) => [n.name!, n.extras as PieceExtras]));

  it('ships the art pipeline’s layout unchanged (re-copy art/maps/street_market/layout.json after a recompile)', () => {
    const art = JSON.parse(read(new URL('art/maps/street_market/layout.json', REPO)).toString()) as KitLayout;
    expect(shipped).toEqual(art);
  });

  it('every placed piece is in the kit, gameplay pieces in `pieces`, dressing in `decor`', () => {
    for (const item of layoutItems(shipped)) expect(kit[item.piece], item.piece).toBeDefined();
    for (const item of shipped.pieces) expect(kit[item.piece]!.layer ?? 'gameplay').toBe('gameplay');
    for (const item of shipped.decor ?? []) expect(kit[item.piece]!.layer).not.toBe('gameplay');
  });

  it('the registered map is exactly the collision the kit carries where the layout places it', () => {
    const expected = collisionOf(shipped, kit);
    expect(streetMarketMap.solids.map(polyKey).sort()).toEqual(expected.solids.map(polyKey).sort());
    const owKey = (o: { ax: number; ay: number; bx: number; by: number }) => [o.ax, o.ay, o.bx, o.by].map(r).join(',');
    expect(streetMarketMap.oneWays.map(owKey).sort()).toEqual(expected.oneWays.map(owKey).sort());
    expect(streetMarketMap.bounds).toEqual(shipped.bounds);
  });
});

describe('Street Market: the environment', () => {
  const def = environmentFor('street-market')!;

  async function build(): Promise<MapEnvironment> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const ab = kitBytes.buffer.slice(kitBytes.byteOffset, kitBytes.byteOffset + kitBytes.byteLength);
    const env = new MapEnvironment(def, streetMarketMap, '/', { loadAsync: () => loader.parseAsync(ab, '') }, fetchPublic);
    await env.ready;
    return env;
  }

  it('builds the kit into a few merged layers and then draws the gameplay plane itself', async () => {
    const env = await build();
    expect(env.drawsPlane).toBe(true);
    const names: string[] = [];
    env.background.traverse((o) => (o as Mesh).isMesh && names.push(o.name));
    for (const n of ['kit-gameplay', 'kit-mid', 'kit-far', 'contact-shadows', 'dressing', 'street', 'yard', 'sky', 'sky-art', 'backdrop-far', 'backdrop-mid', 'ads-4:3', 'ads-6:1']) expect(names).toContain(n);
    // docs/11 §3: ≤ 80 draw calls on Low in a 12-player fight. The static environment: the painted sky,
    // 4 skyline panels, street, yard, 3 kit layers, contact shadows, dressing, shop signs and the two
    // billboard formats = 15 (the gradient sky hides once the painted one is in; signs need a DOM,
    // so there are none here)
    expect(names.filter((n) => n !== 'sky').length).toBeLessThanOrEqual(15);
    expect(env.boards?.meshes).toHaveLength(2);
    env.dispose();
  });

  it('keeps the dressing behind the gameplay band and the foreground in front of it', async () => {
    const env = await build();
    const box = (g: BufferGeometry) => (g.computeBoundingBox(), g.boundingBox!);
    const dressing = env.background.getObjectByName('dressing') as Mesh;
    // wires, bunting, trees, palms and the city: all behind z −1.3
    expect(box(dressing.geometry).max.z).toBeLessThanOrEqual(-1.3);
    const gameplay = env.background.getObjectByName('kit-gameplay') as Mesh;
    const g = box(gameplay.geometry);
    expect(g.min.z).toBeGreaterThan(-1.2);
    expect(g.max.z).toBeLessThan(1.3);
    // the yard behind, the street in front
    expect(box((env.background.getObjectByName('yard') as Mesh).geometry).max.z).toBeLessThanOrEqual(-0.97);
    expect(box((env.background.getObjectByName('street') as Mesh).geometry).min.z).toBeGreaterThanOrEqual(1.1 - 1e-6);
    for (const f of env.foreground) {
      expect(f.z).toBeGreaterThan(1);
      expect(f.z).toBeLessThanOrEqual(6.5);
      const world = new Box3().setFromObject(f.mesh);
      expect(world.min.z).toBeGreaterThan(1);
    }
    env.dispose();
  });

  it('the view waits for the kit only, and not for ever: a stalled request times out', async () => {
    const stalled = new MapEnvironment(def, streetMarketMap, '/', { loadAsync: () => new Promise<never>(() => {}) }, () => new Promise<never>(() => {}));
    const t0 = Date.now();
    await withTimeout(stalled.kitReady, 50);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(stalled.drawsPlane).toBe(false); // the extruded collision stands in
    expect(await withTimeout(Promise.resolve('kit'), 10_000)).toBe('kit');
    stalled.dispose();
  });

  it('falls back to the extruded collision when the kit can’t load', async () => {
    const env = new MapEnvironment(def, streetMarketMap, '/', { loadAsync: () => Promise.reject(new Error('offline')) }, fetchPublic);
    const err = console.error;
    console.error = () => {};
    await env.ready;
    console.error = err;
    expect(env.drawsPlane).toBe(false);
    env.dispose();
  });
});
