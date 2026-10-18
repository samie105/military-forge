/**
 * Life on the street, behind the play plane: power lines sagging between the kit's poles, bunting
 * strung between the houses over the stalls, trees and palms between the blocks. All of it sits
 * at z ≤ −1.3 (behind the gameplay band: players always draw over it), is graded toward the haze
 * by depth, and merges into one mesh (one draw call). Nothing here collides or reads as cover.
 */
import { BufferAttribute, Color, IcosahedronGeometry, type BufferGeometry } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { QuadBuilder } from './shapes';
import { hash2 } from './textures';

export type Vec3 = [number, number, number];

export interface Fade {
  haze: Color;
  base: number;
  perM: number;
}

export function faded(hex: number | Color, z: number, f: Fade): Color {
  const c = typeof hex === 'number' ? new Color(hex) : hex.clone();
  return c.lerp(f.haze, Math.min(0.8, f.base + f.perM * Math.max(0, -z)));
}

/** A point on a sagging wire from a to b at t ∈ [0, 1] (a parabola: close to a catenary at this sag). */
export function wirePoint(a: Vec3, b: Vec3, sag: number, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - 4 * sag * t * (1 - t), a[2] + (b[2] - a[2]) * t];
}

/** A wire as a ribbon facing the camera (+z), `width` metres wide. */
export function wire(q: QuadBuilder, a: Vec3, b: Vec3, sag: number, width: number, color: Color, segments = 14): void {
  let prev = wirePoint(a, b, sag, 0);
  for (let i = 1; i <= segments; i++) {
    const p = wirePoint(a, b, sag, i / segments);
    const dx = p[0] - prev[0];
    const dy = p[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const ox = (-dy / len) * (width / 2);
    const oy = (dx / len) * (width / 2);
    q.quad([prev[0] - ox, prev[1] - oy, prev[2]], [p[0] - ox, p[1] - oy, p[2]], [p[0] + ox, p[1] + oy, p[2]], [prev[0] + ox, prev[1] + oy, prev[2]], color, [1, 1, 1, 1], 'xy');
    prev = p;
  }
}

/** Triangular flags hanging from a wire, cycling through `colours`. */
export function bunting(q: QuadBuilder, a: Vec3, b: Vec3, sag: number, colours: readonly Color[], line: Color, spacing = 0.5, seed = 1): void {
  wire(q, a, b, sag, 0.03, line, 18);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.floor(length / spacing);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = wirePoint(a, b, sag, t);
    const c = colours[(i + Math.floor(hash2(i, 0, seed) * 1.999)) % colours.length]!;
    const w = 0.17;
    const h = 0.34 + 0.05 * hash2(i, 1, seed);
    const sway = 0.06 * (hash2(i, 2, seed) - 0.5);
    q.tri([p[0] - w, p[1], p[2]], [p[0] + sway, p[1] - h, p[2]], [p[0] + w, p[1], p[2]], c, 0.92 + 0.12 * hash2(i, 3, seed));
  }
}

function blob(x: number, y: number, z: number, r: number, sy: number, color: Color, detail = 1): BufferGeometry {
  // smooth normals on the indexed sphere first: soft, rounded canopies rather than facets
  const src = new IcosahedronGeometry(r, detail);
  src.scale(1, sy, 0.85);
  src.translate(x, y, z);
  src.deleteAttribute('uv');
  const merged = mergeVertices(src);
  merged.computeVertexNormals();
  const g = merged.toNonIndexed();
  src.dispose();
  merged.dispose();
  const pos = g.attributes.position!;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // darker underneath: the canopy shades itself
    const k = 0.72 + 0.28 * Math.min(1, Math.max(0, (pos.getY(i) - (y - r * sy)) / (2 * r * sy)));
    col[i * 3] = color.r * k;
    col[i * 3 + 1] = color.g * k;
    col[i * 3 + 2] = color.b * k;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

/** A broadleaf street tree: a trunk and a few canopy blobs. */
export function tree(q: QuadBuilder, x: number, z: number, height: number, fade: Fade, seed: number): BufferGeometry[] {
  const trunk = faded(0x5a4a3a, z, fade);
  const trunkSide = trunk.clone().multiplyScalar(0.75);
  const w = 0.16 + 0.04 * hash2(seed, 0, 1);
  // trunk: two boxes, the upper one leaning a little
  const lean = 0.25 * (hash2(seed, 1, 1) - 0.5);
  boxQuads(q, x - w, 0, z - w, x + w, height * 0.55, z + w, trunk, trunkSide);
  boxQuads(q, x - w * 0.8 + lean, height * 0.5, z - w * 0.8, x + w * 0.8 + lean, height * 0.75, z + w * 0.8, trunk, trunkSide);
  const leaves = [0x5d7c3c, 0x71904a, 0x506d35, 0x678542];
  const parts: BufferGeometry[] = [];
  const n = 5 + Math.floor(3 * hash2(seed, 2, 1));
  for (let i = 0; i < n; i++) {
    // a crown of overlapping clumps, the biggest in the middle, smaller ones around the rim
    const a = (i / n) * Math.PI * 2 + hash2(seed, 5, 1) * 6;
    const rim = i === 0 ? 0 : 0.5 + 0.4 * hash2(seed, 50 + i, 1);
    const r = height * (i === 0 ? 0.24 : 0.13 + 0.07 * hash2(seed, 10 + i, 1));
    const bx = x + lean + Math.cos(a) * rim * height * 0.26;
    const by = height * 0.72 + Math.sin(a) * rim * height * 0.14 + height * 0.05 * hash2(seed, 30 + i, 1);
    const bz = z + 0.5 * (hash2(seed, 40 + i, 1) - 0.5);
    parts.push(blob(bx, by, bz, r, 0.8, faded(leaves[i % leaves.length]!, z, fade)));
  }
  return parts;
}

/** A palm: a slightly curved trunk and drooping fronds. */
export function palm(q: QuadBuilder, x: number, z: number, height: number, fade: Fade, seed: number): void {
  const trunk = faded(0x6b5d4c, z, fade);
  const side = trunk.clone().multiplyScalar(0.75);
  const segs = 6;
  const bend = (0.6 + 0.6 * hash2(seed, 0, 2)) * (hash2(seed, 1, 2) < 0.5 ? -1 : 1);
  let px = x;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const x1 = x + bend * t1 * t1;
    const w = 0.2 - 0.06 * t0;
    boxQuads(q, Math.min(px, x1) - w, height * t0, z - w, Math.max(px, x1) + w, height * t1 + 0.05, z + w, trunk, side);
    px = x1;
  }
  const top: Vec3 = [px, height, z];
  const frond = faded(0x55703a, z, fade);
  const frondDark = faded(0x435a2e, z, fade);
  const count = 8;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + hash2(seed, 2 + i, 2);
    const dx = Math.cos(ang);
    const dz = Math.sin(ang) * 0.45;
    const len = 2.6 + 0.8 * hash2(seed, 20 + i, 2);
    // a frond: a strip that rises, then droops, narrowing to a point
    const pts: Vec3[] = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      pts.push([top[0] + dx * len * t, top[1] + 0.6 * t - 1.9 * t * t, top[2] + dz * len * t]);
    }
    for (let k = 0; k < 4; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const wa = 0.42 * (1 - k / 4);
      const wb = 0.42 * (1 - (k + 1) / 4);
      const c = k % 2 ? frond : frondDark;
      q.quad([a[0], a[1] - wa, a[2]], [b[0], b[1] - wb, b[2]], [b[0], b[1] + wb * 0.3, b[2]], [a[0], a[1] + wa * 0.3, a[2]], c, [0.85, 0.85, 1, 1], 'xy');
    }
  }
}

/** Visible faces (front, top, sides) of a box. */
export function boxQuads(q: QuadBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, front: Color, side: Color): void {
  q.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], front, [0.85, 0.85, 1, 1], 'xy');
  q.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], front);
  q.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side, [0.85, 0.85, 1, 1], 'xy');
  q.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side, [0.85, 0.85, 1, 1], 'xy');
}

/** Merges the canopy blobs (position, normal, color). */
export function mergeBlobs(parts: BufferGeometry[]): BufferGeometry | null {
  if (!parts.length) return null;
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}
