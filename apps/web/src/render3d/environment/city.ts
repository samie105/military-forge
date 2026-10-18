/**
 * Mid-depth city (docs/11 §2, z −10…−20): rows of plain two- to seven-storey blocks behind the
 * kit's mid pieces, so the street reads as part of a city instead of a stage set. Window grids,
 * parapets and rooftop water tanks; painted plaster in a muted palette, then pulled toward the
 * haze with depth (low saturation, low contrast behind the play plane, docs/11 §4). Laid out from
 * a hash, so it is the same on every load. One merged mesh: one draw call.
 */
import { Color } from 'three';
import { QuadBuilder } from './shapes';
import { hash2 } from './textures';

export interface CityOptions {
  x0: number;
  x1: number;
  /** nearest and farthest front faces (negative z) */
  zNear: number;
  zFar: number;
  /** linear-space haze the colours fade toward, and how much per metre behind the plane */
  haze: Color;
  hazePerM: number;
  hazeBase: number;
  /** plaster colours (sRGB hex) */
  walls: number[];
  window: number;
  trim: number;
  tank: number;
  seed?: number;
}

/** Adds an axis-aligned box's visible faces (front, top, both sides) to the builder. */
export function boxFaces(q: QuadBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, front: Color, side: Color, top: Color, bottomShade = 0.8): void {
  // front (+z)
  q.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], front, [bottomShade, bottomShade, 1, 1], 'xy');
  // top (+y)
  q.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top);
  // left (−x) and right (+x)
  q.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side, [bottomShade, bottomShade, 1, 1], 'xy');
  q.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side, [bottomShade, bottomShade, 1, 1], 'xy');
}

/** An upright, 6-sided tank (approximated by a box with chamfered corners as two boxes). */
function tank(q: QuadBuilder, x: number, y: number, z: number, r: number, h: number, c: Color, side: Color): void {
  boxFaces(q, x - r, y, z - r * 0.7, x + r, y + h, z + r * 0.7, c, side, c.clone().multiplyScalar(1.15));
  boxFaces(q, x - r * 0.7, y, z - r, x + r * 0.7, y + h, z + r, c, side, c.clone().multiplyScalar(1.15));
}

export function buildCity(o: CityOptions, q = new QuadBuilder(4.5)): QuadBuilder {
  const seed = o.seed ?? 3;
  const walls = o.walls.map((h) => new Color(h));
  const win = new Color(o.window);
  const trim = new Color(o.trim);
  const tankC = new Color(o.tank);
  const fade = (c: Color, z: number) => c.clone().lerp(o.haze, Math.min(0.8, o.hazeBase + o.hazePerM * -z));
  // two staggered rows: the nearer lower, the farther taller
  for (let row = 0; row < 2; row++) {
    let x = o.x0 + row * 5;
    for (let i = 0; x < o.x1; i++) {
      const h1 = hash2(i, row, seed);
      const h2 = hash2(i, row + 10, seed);
      const h3 = hash2(i, row + 20, seed);
      const w = 7 + 9 * h1;
      const floors = row === 0 ? 2 + Math.floor(3 * h2) : 3 + Math.floor(6 * h2);
      const height = floors * 3.1 + 0.6;
      const zFront = row === 0 ? o.zNear - 2 * h3 : o.zFar + 3 * h3;
      const depth = 7;
      const base = walls[Math.floor(hash2(i, row + 30, seed) * walls.length)]!.clone().multiplyScalar(0.92 + 0.14 * hash2(i, row + 40, seed));
      const front = fade(base, zFront);
      const side = fade(base.clone().multiplyScalar(0.72), zFront);
      const top = fade(base.clone().multiplyScalar(1.08), zFront);
      const x0 = x;
      const x1 = x + w;
      boxFaces(q, x0, 0, zFront - depth, x1, height, zFront, front, side, top, 0.78);
      // parapet trim along the roof line
      const t = fade(trim, zFront);
      q.quad([x0, height - 0.35, zFront + 0.06], [x1, height - 0.35, zFront + 0.06], [x1, height, zFront + 0.06], [x0, height, zFront + 0.06], t, [0.9, 0.9, 1, 1], 'xy');
      // window grid: floors × bays, a few left out (stairwells, shutters), recessed dark glass
      const bays = Math.max(1, Math.floor((w - 1.2) / 2.6));
      const pitch = (w - 1.2) / bays;
      // glass a step darker than the wall, not black: low contrast behind the play plane
      const wc = fade(win.clone().lerp(base, 0.35), zFront);
      for (let f = 0; f < floors; f++) {
        const y0 = 1.0 + f * 3.1;
        for (let b = 0; b < bays; b++) {
          if (hash2(i * 31 + b, f + row * 17, seed + 5) < 0.12) continue;
          const cx = x0 + 0.6 + pitch * (b + 0.5);
          const ww = Math.min(1.5, pitch * 0.55);
          const shade = 0.85 + 0.25 * hash2(i * 31 + b, f, seed + 6);
          q.quad([cx - ww / 2, y0, zFront + 0.03], [cx + ww / 2, y0, zFront + 0.03], [cx + ww / 2, y0 + 1.45, zFront + 0.03], [cx - ww / 2, y0 + 1.45, zFront + 0.03], wc, [shade, shade, shade * 1.1, shade * 1.1], 'xy');
        }
      }
      // rooftop water tanks and a stair hut on some roofs
      const tc = fade(tankC, zFront);
      const ts = fade(tankC.clone().multiplyScalar(0.7), zFront);
      const tanks = Math.floor(3 * hash2(i, row + 50, seed));
      for (let k = 0; k < tanks; k++) {
        const tx = x0 + 1.2 + (w - 2.4) * hash2(i * 7 + k, row + 60, seed);
        tank(q, tx, height, zFront - 2 - 3 * hash2(i * 7 + k, row + 70, seed), 0.55, 1.3, tc, ts);
      }
      if (hash2(i, row + 80, seed) < 0.35) {
        const hx = x0 + 0.8 + (w - 3.6) * hash2(i, row + 90, seed);
        boxFaces(q, hx, height, zFront - 5, hx + 2.6, height + 2.4, zFront - 2.6, top, side, top);
      }
      x = x1 + 0.4 + 2.5 * hash2(i, row + 100, seed);
    }
  }
  return q;
}
