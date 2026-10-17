/**
 * Gameplay-plane geometry generated from the map's collision polygons (docs/11 §2), so what you
 * see at z = 0 is exactly what you collide with:
 * - front faces at z = +1 (earcut via three's ShapeUtils) with a bottom-dark "AO" gradient;
 * - side walls through the 2 m gameplay band (z −1…+1): walkable tops get the cap colour,
 *   walls and undersides darker;
 * - a bevelled trim along every walkable edge: a lip 6 cm proud of the front face whose bevel ends
 *   exactly on the collision edge, so it never raises the silhouette;
 * - one-way platforms as thin slabs under their line.
 * Everything is one vertex-coloured BufferGeometry: one draw call for the whole plane.
 */
import type { MapDef } from '@military-forge/content';
import { BufferAttribute, BufferGeometry, Color, ShapeUtils, Vector2 } from 'three';
import type { LightingPreset } from './lighting';

/** front and back of the gameplay band (W8's kit pieces are 2 m deep, z −1…+1) */
export const PLANE_FRONT_Z = 1;
export const PLANE_BACK_Z = -1;
/** walkable slope limit (docs/02: 50°) as the minimum up-component of an edge normal */
export const WALKABLE_NY = Math.cos((50 * Math.PI) / 180);
const ONE_WAY_THICKNESS = 0.22;
const TRIM_HEIGHT = 0.16;
const TRIM_PROUD = 0.06;

class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Color, shade = 1): number {
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.colors.push(c.r * shade, c.g * shade, c.b * shade);
    return this.positions.length / 3 - 1;
  }

  /** quad a-b-c-d, counter-clockwise when seen from the side its normal points to */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    g.setIndex(this.indices);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Polygon points as Vector2s, counter-clockwise, without repeated or collinear vertices. */
export function cleanContour(flat: readonly number[]): Vector2[] {
  const pts: Vector2[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const p = new Vector2(flat[i]!, flat[i + 1]!);
    if (!pts.length || pts[pts.length - 1]!.distanceToSquared(p) > 1e-10) pts.push(p);
  }
  if (pts.length > 1 && pts[0]!.distanceToSquared(pts[pts.length - 1]!) <= 1e-10) pts.pop();
  if (ShapeUtils.isClockWise(pts)) pts.reverse();
  // drop collinear middle vertices: fewer, longer wall quads and trims
  for (let i = 0; i < pts.length && pts.length > 3; ) {
    const a = pts[(i + pts.length - 1) % pts.length]!;
    const b = pts[i]!;
    const c = pts[(i + 1) % pts.length]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) pts.splice(i, 1);
    else i++;
  }
  return pts;
}

function extrude(mb: MeshBuilder, contour: Vector2[], front: Color, cap: Color): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of contour) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  // baked AO: 60% at the polygon's bottom, full brightness from 6 m (or the full height) above it
  const aoSpan = Math.min(6, maxY - minY) || 1;
  const shade = (y: number) => 0.6 + 0.4 * Math.min(1, (y - minY) / aoSpan);

  // front face
  const base = contour.map((p) => mb.vertex(p.x, p.y, PLANE_FRONT_Z, 0, 0, 1, front, shade(p.y)));
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) mb.indices.push(base[a!]!, base[b!]!, base[c!]!);

  // side walls and trims, edge by edge (CCW: the outward normal is the edge's right side)
  const side = front.clone().multiplyScalar(0.8);
  const under = front.clone().multiplyScalar(0.55);
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    const len = a.distanceTo(b);
    const nx = (b.y - a.y) / len;
    const ny = -(b.x - a.x) / len;
    const walkable = ny >= WALKABLE_NY;
    const color = walkable ? cap : ny < -0.5 ? under : side;
    const s = walkable ? 1 : 0.85;
    mb.quad(
      mb.vertex(a.x, a.y, PLANE_FRONT_Z, nx, ny, 0, color, s),
      mb.vertex(a.x, a.y, PLANE_BACK_Z, nx, ny, 0, color, s),
      mb.vertex(b.x, b.y, PLANE_BACK_Z, nx, ny, 0, color, s),
      mb.vertex(b.x, b.y, PLANE_FRONT_Z, nx, ny, 0, color, s),
    );
    if (!walkable) continue;
    // trim: a vertical band TRIM_HEIGHT tall, TRIM_PROUD in front of the face, then a 45° bevel
    // that lands on the collision edge itself at the front of the band
    const zt = PLANE_FRONT_Z + TRIM_PROUD;
    const bevelN = new Vector2(nx, ny).multiplyScalar(Math.SQRT1_2);
    const trimDark = cap.clone().multiplyScalar(0.72);
    // (walkable edges of a CCW polygon run right → left, hence a before b going up)
    mb.quad(
      mb.vertex(a.x, a.y - TRIM_HEIGHT, zt, 0, 0, 1, trimDark),
      mb.vertex(a.x, a.y - TRIM_PROUD, zt, 0, 0, 1, trimDark),
      mb.vertex(b.x, b.y - TRIM_PROUD, zt, 0, 0, 1, trimDark),
      mb.vertex(b.x, b.y - TRIM_HEIGHT, zt, 0, 0, 1, trimDark),
    );
    mb.quad(
      mb.vertex(a.x, a.y - TRIM_PROUD, zt, bevelN.x, bevelN.y, Math.SQRT1_2, cap, 1.1),
      mb.vertex(a.x, a.y, PLANE_FRONT_Z, bevelN.x, bevelN.y, Math.SQRT1_2, cap, 1.1),
      mb.vertex(b.x, b.y, PLANE_FRONT_Z, bevelN.x, bevelN.y, Math.SQRT1_2, cap, 1.1),
      mb.vertex(b.x, b.y - TRIM_PROUD, zt, bevelN.x, bevelN.y, Math.SQRT1_2, cap, 1.1),
    );
  }
}

/** The whole gameplay plane: solids + one-way platforms, one geometry. */
export function buildMapGeometry(map: MapDef, light: LightingPreset): BufferGeometry {
  const mb = new MeshBuilder();
  const pal = light.palette;
  for (const poly of map.solids) {
    const m = poly.material ?? 0;
    const contour = cleanContour(poly.points);
    if (contour.length >= 3) extrude(mb, contour, new Color(pal.front[m] ?? pal.front[0]), new Color(pal.cap[m] ?? pal.cap[0]));
  }
  const oneWay = new Color(pal.oneWay);
  for (const ow of map.oneWays) {
    const slab = [ow.ax, ow.ay - ONE_WAY_THICKNESS, ow.bx, ow.by - ONE_WAY_THICKNESS, ow.bx, ow.by, ow.ax, ow.ay];
    extrude(mb, cleanContour(slab), oneWay.clone().multiplyScalar(0.8), oneWay);
  }
  return mb.build();
}
