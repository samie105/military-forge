import { BoxGeometry, BufferAttribute, BufferGeometry, Color, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { gradeVertex, luminance, saturate, type MapGrade } from '../grade';
import { placePoint, placementMatrix, type LayoutItem } from '../layout';
import { MARKET_DAY, mapGrade } from '../looks';
import { contactFootprints, mergeLayer, type KitPiece } from '../merge';
import { KERB_Z, streetHeight } from '../street';
import { grimeTexture, hash2, softBoxTexture, tileFbm, tileNoise } from '../textures';

/** One front-facing triangle in piece space (counter-clockwise seen from +z), right of the pivot. */
function trianglePiece(name: string, layer: KitPiece['layer'] = 'gameplay'): KitPiece {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([1, 0, 0.5, 2, 0, 0.5, 1, 1, 0.5]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), 3));
  g.setIndex([0, 1, 2]);
  return { name, layer, geometry: g, extras: {} };
}

/** The winding normal of triangle `t` of an indexed geometry. */
function windingNormal(g: BufferGeometry, t: number): Vector3 {
  const p = g.attributes.position!;
  const idx = g.index!;
  const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(p, idx.getX(t * 3 + k)));
  return new Vector3().subVectors(b!, a!).cross(new Vector3().subVectors(c!, a!)).normalize();
}

const NO_GRADE: MapGrade = {
  hazeColor: new Color(1, 1, 1),
  tint: new Color(1, 1, 1),
  aoHeight: 0,
  aoFloor: 1,
  floorSaturation: 1,
  layers: {
    gameplay: { saturation: 1, gain: 1, haze: 0, hazePerM: 0, hazeMax: 0 },
    mid: { saturation: 1, gain: 1, haze: 0, hazePerM: 0, hazeMax: 0 },
    far: { saturation: 1, gain: 1, haze: 0, hazePerM: 0, hazeMax: 0 },
  },
};

describe('kit placement (render = collision)', () => {
  it('places a piece the way compile_map.py places its collision, mirrored about the pivot', () => {
    const item: LayoutItem = { piece: 'p', x: 10, y: 2, flip: true };
    const m = placementMatrix(item, new Matrix4());
    const v = new Vector3(1.5, 3, 0.25).applyMatrix4(m);
    expect([v.x, v.y, v.z]).toEqual([8.5, 5, 0.25]);
    expect(placePoint(item, 1.5, 3)).toEqual([8.5, 5]);
    expect(placePoint({ piece: 'p', x: 10 }, 1.5, 3)).toEqual([11.5, 3]);
    const decor = new Vector3(0, 0, 0).applyMatrix4(placementMatrix({ piece: 'p', x: -4, z: -6 }));
    expect([decor.x, decor.y, decor.z]).toEqual([-4, 0, -6]);
  });

  it('merges every placement of a layer into one geometry; mirrored copies keep their front facing the camera', () => {
    const pieces = new Map([
      ['tri', trianglePiece('tri')],
      ['back', trianglePiece('back', 'mid')],
    ]);
    const items: LayoutItem[] = [
      { piece: 'tri', x: 0 },
      { piece: 'tri', x: 20, flip: true },
      { piece: 'back', x: 0, z: -5 },
      { piece: 'missing', x: 0 },
    ];
    const missing = new Set<string>();
    const g = mergeLayer(pieces, items, 'gameplay', { grade: NO_GRADE, uvTile: 2 }, missing)!;
    expect(g.attributes.position!.count).toBe(6);
    expect(g.index!.count).toBe(6);
    expect([...missing]).toEqual(['missing']);
    // the mirrored copy sits left of x = 20, its winding still faces +z
    const xs = [3, 4, 5].map((i) => g.attributes.position!.getX(i));
    expect(xs).toEqual([19, 18, 19]);
    expect(windingNormal(g, 0).z).toBeCloseTo(1, 6);
    expect(windingNormal(g, 1).z).toBeCloseTo(1, 6);
    // the stored normals follow the mirror (x negated: z untouched here)
    expect(g.attributes.normal!.getZ(4)).toBeCloseTo(1, 6);
    // walls facing the camera get (x, y) / tile as UVs
    expect([g.attributes.uv!.getX(1), g.attributes.uv!.getY(1)]).toEqual([1, 0]);
    expect(mergeLayer(pieces, items, 'far')).toBeNull();
  });

  it('finds contact footprints where a piece meets the floor: one per leg run, none for floor slabs or raised placements', () => {
    const legs = new BoxGeometry(0.2, 3, 0.2).translate(-1.5, 1.5, 0);
    const legs2 = new BoxGeometry(0.2, 3, 0.2).translate(1.5, 1.5, 0);
    const g = new BufferGeometry();
    const merged = [legs, legs2].map((b) => b.toNonIndexed());
    const pos = new Float32Array([...merged[0]!.attributes.position!.array, ...merged[1]!.attributes.position!.array]);
    g.setAttribute('position', new BufferAttribute(pos, 3));
    const stall: KitPiece = { name: 'stall', layer: 'gameplay', geometry: g, extras: {} };
    const runs = contactFootprints(stall, { piece: 'stall', x: 10 });
    expect(runs).toHaveLength(2);
    expect(runs[0]!.x0).toBeCloseTo(8.4, 6);
    expect(runs[1]!.x1).toBeCloseTo(11.6, 6);
    expect(contactFootprints(stall, { piece: 'stall', x: 10, y: 4 })).toEqual([]);
    const slab: KitPiece = { name: 'slab', layer: 'gameplay', geometry: new BoxGeometry(4, 1.5, 2).translate(0, -0.75, 0), extras: {} };
    expect(contactFootprints(slab, { piece: 'slab', x: 0 })).toEqual([]);
  });
});

describe('palette discipline (grade)', () => {
  const grade = mapGrade(MARKET_DAY);

  it('quiets the background: mid and far layers are less saturated and nearer the haze than the gameplay plane', () => {
    const paint = () => new Color(0.6, 0.25, 0.1);
    const chroma = (c: Color) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    const gameplay = gradeVertex(paint(), grade, 'gameplay', 6, 1, 0);
    const mid = gradeVertex(paint(), grade, 'mid', 6, -6, 0);
    const far = gradeVertex(paint(), grade, 'far', 6, -28, 0);
    expect(chroma(mid)).toBeLessThan(chroma(gameplay));
    expect(chroma(far)).toBeLessThan(chroma(mid));
    const toHaze = (c: Color) => Math.hypot(c.r - grade.hazeColor.r, c.g - grade.hazeColor.g, c.b - grade.hazeColor.b);
    expect(toHaze(far)).toBeLessThan(toHaze(mid));
    expect(toHaze(mid)).toBeLessThan(toHaze(gameplay));
  });

  it('darkens wall feet (baked AO) but not floors, and keeps the pavement quieter than what stands on it', () => {
    const wallFoot = gradeVertex(new Color(0.5, 0.5, 0.5), grade, 'gameplay', 0, 1, 0);
    const wallHigh = gradeVertex(new Color(0.5, 0.5, 0.5), grade, 'gameplay', 5, 1, 0);
    expect(luminance(wallFoot)).toBeLessThan(luminance(wallHigh) * 0.8);
    const floor = gradeVertex(new Color(0.6, 0.2, 0.1), grade, 'gameplay', 0, 0.5, 1);
    const crate = gradeVertex(new Color(0.6, 0.2, 0.1), grade, 'gameplay', 0.5, 0.5, 1);
    expect(floor.r - floor.b).toBeLessThan(crate.r - crate.b);
  });

  it('desaturates toward luminance without changing it', () => {
    const c = new Color(0.8, 0.2, 0.1);
    const l = luminance(c);
    saturate(c, 0.5);
    expect(luminance(c)).toBeCloseTo(l, 9);
    expect(saturate(new Color(0.8, 0.2, 0.1), 0).r).toBeCloseTo(l, 9);
  });
});

describe('procedural textures', () => {
  it('are a pure function of their seed (no Math.random) and tile seamlessly', () => {
    expect(hash2(3, 4, 5)).toBe(hash2(3, 4, 5));
    for (const v of [0, 0.25, 0.7]) {
      expect(tileNoise(0, v, 8, 8, 1)).toBeCloseTo(tileNoise(1, v, 8, 8, 1), 9);
      expect(tileFbm(v, 0, 4, 3, 2)).toBeCloseTo(tileFbm(v, 1, 4, 3, 2), 9);
    }
    const a = grimeTexture(32).image.data as Uint8Array;
    const b = grimeTexture(32).image.data as Uint8Array;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const mean = a.reduce((s, v) => s + v, 0) / a.length / 255;
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(0.98);
  });

  it('the contact-shadow mask is opaque in the middle and clear at the edges', () => {
    const t = softBoxTexture(16);
    const d = t.image.data as Uint8Array;
    const at = (x: number, y: number) => d[(y * 16 + x) * 4 + 3]!;
    expect(at(8, 8)).toBeGreaterThan(200);
    expect(at(0, 8)).toBeLessThan(20);
    expect(at(8, 0)).toBeLessThan(20);
  });
});

describe('the street in front of the band', () => {
  it('never rises above the market floor (the play space ends at y = 0)', () => {
    for (let z = KERB_Z; z <= 13; z += 0.05) expect(streetHeight(z)).toBeLessThanOrEqual(0);
    expect(streetHeight(KERB_Z)).toBe(0);
    expect(streetHeight(12.3)).toBeLessThan(-1);
  });
});
