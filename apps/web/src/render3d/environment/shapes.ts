/**
 * Small helpers for procedural dressing: vertex-coloured boxes, cylinders and strips merged into
 * one geometry per prop (one draw call, one material).
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const tmp = new Color();

/** Gives a geometry a constant vertex colour (sRGB hex), with an optional per-vertex shade by height. */
export function paint(g: BufferGeometry, hex: number, shadeBottom = 1): BufferGeometry {
  tmp.setHex(hex);
  const pos = g.attributes.position!;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const span = max.y - min.y || 1;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = shadeBottom + (1 - shadeBottom) * ((pos.getY(i) - min.y) / span);
    col[i * 3] = tmp.r * k;
    col[i * 3 + 1] = tmp.g * k;
    col[i * 3 + 2] = tmp.b * k;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

/** An axis-aligned box from (x0, y0, z0) to (x1, y1, z1), painted. */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, hex: number, shadeBottom = 1): BufferGeometry {
  const g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed();
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.deleteAttribute('uv');
  return paint(g, hex, shadeBottom);
}

/** An upright cylinder standing on (x, y0, z). */
export function post(x: number, y0: number, z: number, height: number, radius: number, hex: number, segments = 6, shadeBottom = 1): BufferGeometry {
  const g = new CylinderGeometry(radius, radius, height, segments, 1, true).toNonIndexed();
  g.translate(x, y0 + height / 2, z);
  g.deleteAttribute('uv');
  return paint(g, hex, shadeBottom);
}

/** Merges painted parts (position, normal, color only). */
export function merge(parts: BufferGeometry[]): BufferGeometry {
  for (const p of parts) {
    for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') p.deleteAttribute(name);
  }
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
  for (const p of parts) p.dispose();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Builds an indexed, vertex-coloured mesh from quads (four corners each, counter-clockwise seen from the front). */
export class QuadBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uv: number[] = [];
  private readonly idx: number[] = [];

  constructor(private readonly uvTile = 0) {}

  /**
   * Corners as [x, y, z] in order; uv from (x, z) for floors or (x, y) for walls. `hex` is one
   * colour for the quad, or one per corner; `shades` multiply it per corner.
   */
  quad(a: number[], b: number[], c: number[], d: number[], hex: number | Color | readonly Color[], shades: [number, number, number, number] = [1, 1, 1, 1], uvPlane: 'xz' | 'xy' = 'xz'): void {
    const one = typeof hex === 'number' ? tmp.setHex(hex) : Array.isArray(hex) ? null : (hex as Color);
    const corner = (i: number) => one ?? (hex as readonly Color[])[i]!;
    const ux = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const uy = [d[0]! - a[0]!, d[1]! - a[1]!, d[2]! - a[2]!];
    let nx = ux[1]! * uy[2]! - ux[2]! * uy[1]!;
    let ny = ux[2]! * uy[0]! - ux[0]! * uy[2]!;
    let nz = ux[0]! * uy[1]! - ux[1]! * uy[0]!;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const base = this.pos.length / 3;
    [a, b, c, d].forEach((p, i) => {
      this.pos.push(p[0]!, p[1]!, p[2]!);
      this.nor.push(nx, ny, nz);
      const s = shades[i]!;
      const color = corner(i);
      this.col.push(color.r * s, color.g * s, color.b * s);
      if (this.uvTile) this.uv.push(p[0]! / this.uvTile, (uvPlane === 'xz' ? -p[2]! : p[1]!) / this.uvTile);
    });
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A triangle, counter-clockwise seen from the front. */
  tri(a: number[], b: number[], c: number[], hex: number | Color, shade = 1): void {
    const color = typeof hex === 'number' ? tmp.setHex(hex) : hex;
    const ux = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const uy = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    let nx = ux[1]! * uy[2]! - ux[2]! * uy[1]!;
    let ny = ux[2]! * uy[0]! - ux[0]! * uy[2]!;
    let nz = ux[0]! * uy[1]! - ux[1]! * uy[0]!;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const base = this.pos.length / 3;
    for (const p of [a, b, c]) {
      this.pos.push(p[0]!, p[1]!, p[2]!);
      this.nor.push(nx, ny, nz);
      this.col.push(color.r * shade, color.g * shade, color.b * shade);
      if (this.uvTile) this.uv.push(p[0]! / this.uvTile, p[1]! / this.uvTile);
    }
    this.idx.push(base, base + 1, base + 2);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    if (this.uvTile) g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    const count = this.pos.length / 3;
    g.setIndex(new BufferAttribute(count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
