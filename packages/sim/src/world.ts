/**
 * Collision world: map polygons compiled into segments + a uniform grid broadphase
 * (docs/02 §4–5). Static for the lifetime of a match.
 */
import type { MapDef } from '@military-forge/content';
import { GRID_CELL } from './constants';
import { raySegment } from './geometry';

export const SegFlag = {
  Solid: 1,
  OneWay: 2,
  /** bullets pass (fences, railings, one-way platforms) */
  BulletPass: 4,
} as const;

export interface RayHit {
  t: number;
  x: number;
  y: number;
  seg: number;
}

export function createRayHit(): RayHit {
  return { t: Infinity, x: 0, y: 0, seg: -1 };
}

const MIN_EDGE = 0.05;

interface CompiledSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  flags: number;
  material: number;
}

/** Twice the signed area; > 0 means counter-clockwise. */
function signedArea2(points: readonly number[]): number {
  let area = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i * 2]! * points[j * 2 + 1]! - points[j * 2]! * points[i * 2 + 1]!;
  }
  return area;
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Map compiler (docs/02 §4): normalises winding to CCW, drops degenerate vertices, merges
 * collinear edges and rejects self-intersecting polygons.
 */
export function compileMapSegments(map: MapDef): { segments: CompiledSegment[]; warnings: string[] } {
  const segments: CompiledSegment[] = [];
  const warnings: string[] = [];

  map.solids.forEach((poly, pi) => {
    let pts = poly.points.slice();
    if (pts.length < 6 || pts.length % 2 !== 0) throw new Error(`solid #${pi}: needs ≥ 3 points`);
    if (signedArea2(pts) < 0) {
      const rev: number[] = [];
      for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i]!, pts[i + 1]!);
      pts = rev;
    }
    // drop duplicate / too-close consecutive vertices and collinear middle vertices
    let changed = true;
    while (changed && pts.length >= 6) {
      changed = false;
      const n = pts.length / 2;
      for (let i = 0; i < n; i++) {
        const prev = (i + n - 1) % n;
        const next = (i + 1) % n;
        const px = pts[prev * 2]!;
        const py = pts[prev * 2 + 1]!;
        const cx = pts[i * 2]!;
        const cy = pts[i * 2 + 1]!;
        const nx = pts[next * 2]!;
        const ny = pts[next * 2 + 1]!;
        const short = (cx - px) * (cx - px) + (cy - py) * (cy - py) < 1e-12;
        const cross = (cx - px) * (ny - cy) - (cy - py) * (nx - cx);
        const dot = (cx - px) * (nx - cx) + (cy - py) * (ny - cy);
        if (short || (Math.abs(cross) < 1e-9 && dot > 0)) {
          pts.splice(i * 2, 2);
          changed = true;
          break;
        }
      }
    }
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2]!;
      const ay = pts[i * 2 + 1]!;
      const bx = pts[j * 2]!;
      const by = pts[j * 2 + 1]!;
      const len = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
      if (len < MIN_EDGE) warnings.push(`solid #${pi}: edge ${i} is only ${len.toFixed(3)} m long`);
      segments.push({ ax, ay, bx, by, flags: SegFlag.Solid, material: poly.material ?? 0 });
    }
    // self-intersection check (non-adjacent edges)
    for (let i = 0; i < n; i++) {
      for (let k = i + 2; k < n; k++) {
        if (i === 0 && k === n - 1) continue;
        const i2 = (i + 1) % n;
        const k2 = (k + 1) % n;
        if (
          segmentsIntersect(
            pts[i * 2]!, pts[i * 2 + 1]!, pts[i2 * 2]!, pts[i2 * 2 + 1]!,
            pts[k * 2]!, pts[k * 2 + 1]!, pts[k2 * 2]!, pts[k2 * 2 + 1]!,
          )
        ) {
          throw new Error(`solid #${pi}: self-intersection between edges ${i} and ${k}`);
        }
      }
    }
  });

  for (const ow of map.oneWays) {
    // one-way platforms are authored left → right; their normal points up
    const [ax, ay, bx, by] = ow.ax <= ow.bx ? [ow.ax, ow.ay, ow.bx, ow.by] : [ow.bx, ow.by, ow.ax, ow.ay];
    segments.push({ ax, ay, bx, by, flags: SegFlag.OneWay | SegFlag.BulletPass, material: 2 });
  }
  return { segments, warnings };
}

export class CollisionWorld {
  readonly segCount: number;
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly bx: Float64Array;
  readonly by: Float64Array;
  /** unit normal: outward for solids, up for one-way platforms */
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  readonly flags: Uint8Array;
  readonly material: Uint8Array;
  readonly warnings: string[];

  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;

  /** results of the last queryAabb */
  readonly queryResult: Int32Array;
  private readonly stamp: Uint32Array;
  private stampValue = 0;

  constructor(readonly map: MapDef) {
    const { segments, warnings } = compileMapSegments(map);
    this.warnings = warnings;
    const n = segments.length;
    this.segCount = n;
    this.ax = new Float64Array(n);
    this.ay = new Float64Array(n);
    this.bx = new Float64Array(n);
    this.by = new Float64Array(n);
    this.nx = new Float64Array(n);
    this.ny = new Float64Array(n);
    this.flags = new Uint8Array(n);
    this.material = new Uint8Array(n);
    segments.forEach((s, i) => {
      this.ax[i] = s.ax;
      this.ay[i] = s.ay;
      this.bx[i] = s.bx;
      this.by[i] = s.by;
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      if (s.flags & SegFlag.OneWay) {
        this.nx[i] = -dy / len; // left perpendicular of a left→right segment points up
        this.ny[i] = dx / len;
      } else {
        this.nx[i] = dy / len; // right perpendicular of a CCW edge points outward
        this.ny[i] = -dx / len;
      }
      this.flags[i] = s.flags;
      this.material[i] = s.material;
    });

    // uniform grid
    const b = map.bounds;
    this.minX = b.minX;
    this.minY = b.minY;
    this.cols = Math.max(1, Math.ceil((b.maxX - b.minX) / GRID_CELL));
    this.rows = Math.max(1, Math.ceil((b.maxY - b.minY) / GRID_CELL));
    const buckets: number[][] = Array.from({ length: this.cols * this.rows }, () => []);
    for (let i = 0; i < n; i++) {
      const c0 = this.col(Math.min(this.ax[i]!, this.bx[i]!));
      const c1 = this.col(Math.max(this.ax[i]!, this.bx[i]!));
      const r0 = this.row(Math.min(this.ay[i]!, this.by[i]!));
      const r1 = this.row(Math.max(this.ay[i]!, this.by[i]!));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) buckets[r * this.cols + c]!.push(i);
    }
    this.cellStart = new Int32Array(buckets.length + 1);
    let total = 0;
    buckets.forEach((bucket, i) => {
      this.cellStart[i] = total;
      total += bucket.length;
    });
    this.cellStart[buckets.length] = total;
    this.cellItems = new Int32Array(total);
    buckets.forEach((bucket, i) => this.cellItems.set(bucket, this.cellStart[i]!));
    this.queryResult = new Int32Array(n);
    this.stamp = new Uint32Array(n);
  }

  col(x: number): number {
    const c = Math.floor((x - this.minX) / GRID_CELL);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  row(y: number): number {
    const r = Math.floor((y - this.minY) / GRID_CELL);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  private nextStamp(): number {
    this.stampValue = (this.stampValue + 1) >>> 0;
    if (this.stampValue === 0) {
      this.stamp.fill(0);
      this.stampValue = 1;
    }
    return this.stampValue;
  }

  /**
   * Segments whose grid cells overlap the box. Results are written to `queryResult` in
   * ascending segment index (deterministic iteration order); returns the count.
   */
  queryAabb(minX: number, minY: number, maxX: number, maxY: number): number {
    const stamp = this.nextStamp();
    const c0 = this.col(minX);
    const c1 = this.col(maxX);
    const r0 = this.row(minY);
    const r1 = this.row(maxY);
    let count = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.cols + c;
        for (let k = this.cellStart[cell]!; k < this.cellStart[cell + 1]!; k++) {
          const seg = this.cellItems[k]!;
          if (this.stamp[seg] !== stamp) {
            this.stamp[seg] = stamp;
            this.queryResult[count++] = seg;
          }
        }
      }
    }
    // insertion sort: counts are small and this keeps contact resolution order stable
    const q = this.queryResult;
    for (let i = 1; i < count; i++) {
      const v = q[i]!;
      let j = i - 1;
      while (j >= 0 && q[j]! > v) {
        q[j + 1] = q[j]!;
        j--;
      }
      q[j + 1] = v;
    }
    return count;
  }

  /**
   * Grid DDA raycast (Amanatides–Woo, docs/02 §5). `dx, dy` should be a unit vector so `t` is
   * in metres. Segments whose flags intersect `ignoreFlags` are skipped.
   */
  raycast(ox: number, oy: number, dx: number, dy: number, maxT: number, ignoreFlags: number, out: RayHit): boolean {
    out.t = Infinity;
    out.seg = -1;
    const stamp = this.nextStamp();
    let cx = this.col(ox);
    let cy = this.row(oy);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    let tMaxX = dx !== 0 ? (this.minX + (cx + (dx > 0 ? 1 : 0)) * GRID_CELL - ox) / dx : Infinity;
    let tMaxY = dy !== 0 ? (this.minY + (cy + (dy > 0 ? 1 : 0)) * GRID_CELL - oy) / dy : Infinity;
    const tDeltaX = dx !== 0 ? GRID_CELL / Math.abs(dx) : Infinity;
    const tDeltaY = dy !== 0 ? GRID_CELL / Math.abs(dy) : Infinity;
    let best = maxT;
    let bestSeg = -1;
    for (;;) {
      const cell = cy * this.cols + cx;
      for (let k = this.cellStart[cell]!; k < this.cellStart[cell + 1]!; k++) {
        const seg = this.cellItems[k]!;
        if (this.stamp[seg] === stamp) continue;
        this.stamp[seg] = stamp;
        if (this.flags[seg]! & ignoreFlags) continue;
        const t = raySegment(ox, oy, dx, dy, this.ax[seg]!, this.ay[seg]!, this.bx[seg]!, this.by[seg]!);
        if (t < best || (t === best && bestSeg >= 0 && seg < bestSeg)) {
          best = t;
          bestSeg = seg;
        }
      }
      const exit = Math.min(tMaxX, tMaxY);
      if (bestSeg >= 0 && best <= exit) break;
      if (exit > maxT) break;
      if (tMaxX < tMaxY) {
        cx += stepX;
        tMaxX += tDeltaX;
        if (cx < 0 || cx >= this.cols) break;
      } else {
        cy += stepY;
        tMaxY += tDeltaY;
        if (cy < 0 || cy >= this.rows) break;
      }
    }
    if (bestSeg < 0) return false;
    out.t = best;
    out.seg = bestSeg;
    out.x = ox + dx * best;
    out.y = oy + dy * best;
    return true;
  }

  /** Height of segment `seg` at x (clamped to the segment's span). */
  segmentYAt(seg: number, x: number): number {
    const ax = this.ax[seg]!;
    const bx = this.bx[seg]!;
    const ay = this.ay[seg]!;
    const by = this.by[seg]!;
    if (bx === ax) return Math.max(ay, by);
    let u = (x - ax) / (bx - ax);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    return ay + (by - ay) * u;
  }
}
