/**
 * The procedural VFX atlas: 4 × 4 cells of 64 px, generated once (no download). Cell row 0 is the
 * top of the texture, the layout the Forge's flipbook atlases use too (particles.ts reads cells
 * the same way for both). Shapes only: colour comes from the particle's ramp.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat } from 'three';

export const Cell = {
  Glow: 0,
  /** smoke puff, lit from above: light top, darker underside (reads on bright sky and dark walls) */
  Puff: 1,
  Ring: 2,
  Streak: 3,
  Scorch: 4,
  Fire: 5,
  Dot: 6,
  /** tapered streak, bright head at +U */
  Tracer: 7,
  Chunk: 8,
  Dust: 9,
  /** soot on a front face: dark along the top edge, ragged fade downward */
  Soot: 10,
  Star: 11,
} as const;

export const ATLAS_GRID = 4;
const CELL = 64;
const SIZE = CELL * ATLAS_GRID;

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** smooth value noise, 0…1 */
function noise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed) + (hash(xi + 1, yi, seed) - hash(xi, yi, seed)) * sx;
  const b = hash(xi, yi + 1, seed) + (hash(xi + 1, yi + 1, seed) - hash(xi, yi + 1, seed)) * sx;
  return a + (b - a) * sy;
}

function fbm(x: number, y: number, seed: number): number {
  return 0.6 * noise(x, y, seed) + 0.3 * noise(x * 2.1, y * 2.1, seed + 7) + 0.1 * noise(x * 4.3, y * 4.3, seed + 13);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, v: number) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** texel → [luminance, alpha] for each cell; u, v in −1…1 (v up) */
type Shape = (u: number, v: number) => readonly [number, number];

const SHAPES: Record<number, Shape> = {
  [Cell.Glow]: (u, v) => [1, Math.exp(-4.2 * (u * u + v * v)) * smooth(1, 0.85, Math.hypot(u, v))],
  [Cell.Puff]: (u, v) => {
    const d = Math.hypot(u, v) + (fbm(u * 2.6 + 3, v * 2.6, 1) - 0.5) * 0.45;
    return [0.62 + 0.38 * smooth(-0.7, 0.8, v + 0.25 * u), smooth(0.92, 0.55, d)];
  },
  [Cell.Ring]: (u, v) => {
    const d = Math.hypot(u, v);
    return [1, Math.exp(-((d - 0.8) ** 2) / 0.006) + 0.12 * smooth(0.85, 0.3, d)];
  },
  [Cell.Streak]: (u, v) => [1, Math.exp(-(v * v) / 0.05) * smooth(1, 0.6, Math.abs(u))],
  [Cell.Scorch]: (u, v) => {
    const d = Math.hypot(u, v) + (fbm(u * 3 + 11, v * 3, 2) - 0.5) * 0.5;
    return [1, smooth(0.95, 0.35, d) * (0.75 + 0.25 * fbm(u * 6, v * 6, 3))];
  },
  [Cell.Fire]: (u, v) => {
    const d = Math.hypot(u, v) + (fbm(u * 2.2 + 5, v * 2.2, 4) - 0.5) * 0.55;
    return [0.7 + 0.3 * smooth(0.8, 0, d), smooth(0.95, 0.45, d)];
  },
  [Cell.Dot]: (u, v) => [1, smooth(0.95, 0.55, Math.hypot(u, v))],
  [Cell.Tracer]: (u, v) => {
    const head = smooth(-1, 0.85, u) * smooth(1, 0.9, u);
    return [1, head * Math.exp(-(v * v) / (0.02 + 0.06 * head))];
  },
  [Cell.Chunk]: (u, v) => {
    const a = Math.atan2(v, u);
    const r = 0.55 + 0.3 * fbm(Math.cos(a) * 1.5 + 2, Math.sin(a) * 1.5, 5);
    return [0.55 + 0.45 * smooth(-0.6, 0.6, v - u * 0.3), smooth(r + 0.04, r - 0.04, Math.hypot(u, v))];
  },
  [Cell.Dust]: (u, v) => {
    const d = Math.hypot(u, v) + (fbm(u * 2.4 + 9, v * 2.4, 6) - 0.5) * 0.5;
    return [1, smooth(0.95, 0.3, d)];
  },
  [Cell.Soot]: (u, v) => {
    const n = fbm(u * 4 + 1, v * 2, 8) - 0.5;
    return [1, smooth(-0.85 + n * 0.6, 0.85, v) * smooth(1, 0.9, v) * smooth(1, 0.55, Math.abs(u) + n * 0.2)];
  },
  [Cell.Star]: (u, v) => {
    const d = Math.hypot(u, v);
    const rays = Math.exp(-Math.abs(u * v) * 40) * smooth(1, 0, d);
    return [1, clamp01(rays + Math.exp(-14 * d * d))];
  },
};

let atlas: DataTexture | null = null;

/** The shared atlas (created on first use). */
export function vfxAtlas(): DataTexture {
  if (atlas) return atlas;
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (const [key, shape] of Object.entries(SHAPES)) {
    const cell = Number(key);
    const col = cell % ATLAS_GRID;
    const row = Math.floor(cell / ATLAS_GRID);
    // texture rows run bottom-up (flipY false): cell row 0 is the top band
    const y0 = (ATLAS_GRID - 1 - row) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const [lum, a] = shape(((x + 0.5) / CELL) * 2 - 1, ((y + 0.5) / CELL) * 2 - 1);
        const o = ((y0 + y) * SIZE + col * CELL + x) * 4;
        const l = Math.round(clamp01(lum) * 255);
        data[o] = data[o + 1] = data[o + 2] = l;
        data[o + 3] = Math.round(clamp01(a) * 255);
      }
    }
  }
  atlas = new DataTexture(data, SIZE, SIZE, RGBAFormat);
  atlas.generateMipmaps = true;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.needsUpdate = true;
  return atlas;
}
