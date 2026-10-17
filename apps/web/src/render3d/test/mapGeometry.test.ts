import { movementTestMap, type MapDef } from '@military-forge/content';
import { ShapeUtils, Vector3, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { lightingFor } from '../lighting';
import { PLANE_BACK_Z, PLANE_FRONT_Z, buildMapGeometry, cleanContour } from '../mapGeometry';

const light = lightingFor('movement-test');

function triangles(g: BufferGeometry): { a: Vector3; b: Vector3; c: Vector3; n: Vector3 }[] {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const idx = g.getIndex()!;
  const out = [];
  for (let i = 0; i < idx.count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromBufferAttribute(pos, idx.getX(i + k)));
    out.push({ a: a!, b: b!, c: c!, n: new Vector3().fromBufferAttribute(nrm, idx.getX(i)) });
  }
  return out;
}

function polygonArea(points: readonly number[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    a += points[i]! * points[j + 1]! - points[j]! * points[i + 1]!;
  }
  return Math.abs(a) / 2;
}

describe('gameplay-plane geometry (render = collision)', () => {
  const geo = buildMapGeometry(movementTestMap, light);
  const tris = triangles(geo);

  it('winds every triangle toward its normal, so back-face culling keeps the visible side', () => {
    let bad = 0;
    for (const t of tris) {
      const face = new Vector3().subVectors(t.b, t.a).cross(new Vector3().subVectors(t.c, t.a));
      if (face.lengthSq() > 1e-12 && face.dot(t.n) <= 0) bad++;
    }
    expect(bad).toBe(0);
  });

  it('front faces at z = +1 cover exactly the collision polygons (solids + one-way slabs)', () => {
    let front = 0;
    for (const t of tris) {
      if (t.n.z < 0.99 || t.a.z !== PLANE_FRONT_Z || t.b.z !== PLANE_FRONT_Z || t.c.z !== PLANE_FRONT_Z) continue;
      front += new Vector3().subVectors(t.b, t.a).cross(new Vector3().subVectors(t.c, t.a)).length() / 2;
    }
    const solids = movementTestMap.solids.reduce((s, p) => s + polygonArea(p.points), 0);
    const slabs = movementTestMap.oneWays.reduce((s, o) => s + Math.abs(o.bx - o.ax) * 0.22, 0);
    expect(front).toBeCloseTo(solids + slabs, 3); // float32 positions
  });

  it('spans the 2 m gameplay band and never rises above the collision surface', () => {
    const box = geo.boundingBox!;
    expect(box.min.z).toBe(PLANE_BACK_Z);
    expect(box.max.z).toBeCloseTo(PLANE_FRONT_Z + 0.06, 6); // the trims sit 6 cm proud
    const maxY = Math.max(...movementTestMap.solids.flatMap((p) => p.points.filter((_, i) => i % 2 === 1)));
    expect(box.max.y).toBe(maxY);
    // a 1 m block: every vertex stays inside its x-range and at or under its top
    const block: MapDef = { ...movementTestMap, solids: [{ points: [0, 0, 2, 0, 2, 1, 0, 1] }], oneWays: [] };
    const b = buildMapGeometry(block, light).boundingBox!;
    expect([b.min.x, b.max.x, b.min.y, b.max.y]).toEqual([0, 2, 0, 1]);
  });

  it('gives walkable tops the cap colour, walls and undersides darker shades', () => {
    const block: MapDef = { ...movementTestMap, solids: [{ points: [0, 0, 2, 0, 2, 1, 0, 1], material: 3 }], oneWays: [] };
    const g = buildMapGeometry(block, light);
    const nrm = g.getAttribute('normal');
    const col = g.getAttribute('color');
    const brightness = (ny: number) => {
      for (let i = 0; i < nrm.count; i++) if (nrm.getY(i) === ny && nrm.getZ(i) === 0) return col.getX(i) + col.getY(i) + col.getZ(i);
      return NaN;
    };
    expect(brightness(1)).toBeGreaterThan(brightness(-1));
  });
});

describe('cleanContour', () => {
  it('returns counter-clockwise points without repeats or collinear vertices', () => {
    const cw = [0, 0, 0, 1, 1, 1, 2, 1, 2, 0, 2, 0, 1, 0];
    const c = cleanContour(cw);
    expect(ShapeUtils.isClockWise(c)).toBe(false);
    expect(c.map((p) => [p.x, p.y])).toEqual(
      expect.arrayContaining([
        [0, 0],
        [2, 0],
        [2, 1],
        [0, 1],
      ]),
    );
    expect(c).toHaveLength(4);
  });
});
