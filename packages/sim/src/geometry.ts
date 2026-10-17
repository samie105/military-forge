/**
 * 2D geometry kernels. All functions are allocation-free: results go into caller-provided
 * scratch objects. Only + − × ÷ and Math.sqrt, so results are identical on every engine.
 */
import { clamp01 } from '@military-forge/shared';

export interface ClosestPair {
  /** closest point on the first segment */
  ax: number;
  ay: number;
  /** closest point on the second segment */
  bx: number;
  by: number;
  distSq: number;
}

export function createClosestPair(): ClosestPair {
  return { ax: 0, ay: 0, bx: 0, by: 0, distSq: 0 };
}

const EPS = 1e-12;

/** Closest points between segments P1Q1 and P2Q2 (Ericson, Real-Time Collision Detection §5.1.9). */
export function closestSegSeg(
  p1x: number,
  p1y: number,
  q1x: number,
  q1y: number,
  p2x: number,
  p2y: number,
  q2x: number,
  q2y: number,
  out: ClosestPair,
): number {
  const d1x = q1x - p1x;
  const d1y = q1y - p1y;
  const d2x = q2x - p2x;
  const d2y = q2y - p2y;
  const rx = p1x - p2x;
  const ry = p1y - p2y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  out.ax = p1x + d1x * s;
  out.ay = p1y + d1y * s;
  out.bx = p2x + d2x * t;
  out.by = p2y + d2y * t;
  const dx = out.ax - out.bx;
  const dy = out.ay - out.by;
  out.distSq = dx * dx + dy * dy;
  return out.distSq;
}

/** Closest point on segment AB to P; returns the segment parameter in [0, 1]. */
export function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  out: { x: number; y: number },
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  const u = len2 > EPS ? clamp01(((px - ax) * ex + (py - ay) * ey) / len2) : 0;
  out.x = ax + ex * u;
  out.y = ay + ey * u;
  return u;
}

/**
 * Ray O + D·t against segment AB. Returns t ≥ 0 (in units of |D|) or Infinity.
 * Two-sided: hits from either side.
 */
export function raySegment(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (denom > -EPS && denom < EPS) return Infinity; // parallel
  const wx = ax - ox;
  const wy = ay - oy;
  const t = (wx * ey - wy * ex) / denom;
  const u = (wx * dy - wy * dx) / denom;
  if (t < 0 || u < 0 || u > 1) return Infinity;
  return t;
}

/** Ray against circle. Returns the smallest t ≥ 0, 0 if the origin is inside, or Infinity. */
export function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const mx = ox - cx;
  const my = oy - cy;
  const c = mx * mx + my * my - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a <= EPS) return Infinity;
  const b = mx * dx + my * dy;
  if (b > 0) return Infinity; // pointing away
  const disc = b * b - a * c;
  if (disc < 0) return Infinity;
  return (-b - Math.sqrt(disc)) / a;
}

/**
 * Ray against a capsule (segment AB inflated by r). This is also the swept-circle test:
 * a circle of radius r moving along D hits segment AB at the same t.
 * Returns the smallest t ≥ 0, 0 if the origin starts inside, or Infinity.
 */
export function rayCapsule(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  // inside?
  let u = len2 > EPS ? ((ox - ax) * ex + (oy - ay) * ey) / len2 : 0;
  u = clamp01(u);
  const qx = ax + ex * u - ox;
  const qy = ay + ey * u - oy;
  if (qx * qx + qy * qy <= r * r) return 0;

  let best = Infinity;
  if (len2 > EPS) {
    const len = Math.sqrt(len2);
    const ux = ex / len;
    const uy = ey / len;
    // normal (either side)
    const nx = -uy;
    const ny = ux;
    for (let side = -1; side <= 1; side += 2) {
      const sx = nx * side;
      const sy = ny * side;
      const dn = dx * sx + dy * sy;
      if (dn >= 0) continue; // not approaching this face
      const dist0 = (ox - ax) * sx + (oy - ay) * sy; // signed distance to the line
      const t = (r - dist0) / dn;
      if (t < 0) continue;
      const hx = ox + dx * t - ax;
      const hy = oy + dy * t - ay;
      const proj = hx * ux + hy * uy;
      if (proj >= 0 && proj <= len && t < best) best = t;
    }
  }
  const ta = rayCircle(ox, oy, dx, dy, ax, ay, r);
  if (ta < best) best = ta;
  const tb = rayCircle(ox, oy, dx, dy, bx, by, r);
  if (tb < best) best = tb;
  return best;
}
