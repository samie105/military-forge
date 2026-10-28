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
  /** an even line, soft across: tracer paths, smoke trails */
  Line: 12,
  /** a splat: a ragged blob with a few drops thrown off it (blood.ts) */
  Splat: 13,
  /** a crystal cube seen corner-on: a light top face, a mid left and a dark right one, a faint halo (kill effects) */
  Shard: 14,
  /** a hollow glow around a line, empty down its middle, soft at both ends: a skin's tracer glow around the core */
  Sheath: 15,
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

/** the drops a splat throws off: centre (u, v) and radius */
const SPLAT_DROPS: readonly (readonly [number, number, number])[] = [
  [0.66, 0.28, 0.1],
  [-0.58, -0.44, 0.08],
  [0.22, -0.74, 0.07],
  [-0.32, 0.7, 0.06],
  [0.8, -0.38, 0.05],
];

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
  [Cell.Line]: (u, v) => [1, Math.exp(-(v * v) / 0.06) * smooth(1, 0.94, Math.abs(u))],
  [Cell.Splat]: (u, v) => {
    const d = Math.hypot(u * 1.15, v) + (fbm(u * 3.5 + 17, v * 3.5, 9) - 0.5) * 0.55;
    let a = smooth(0.62, 0.48, d);
    for (const [cx, cy, r] of SPLAT_DROPS) a = Math.max(a, smooth(r, r * 0.6, Math.hypot(u - cx, v - cy)));
    return [1, a];
  },
  [Cell.Star]: (u, v) => {
    const d = Math.hypot(u, v);
    const rays = Math.exp(-Math.abs(u * v) * 40) * smooth(1, 0, d);
    return [1, clamp01(rays + Math.exp(-14 * d * d))];
  },
  [Cell.Shard]: (u, v) => {
    // a pointy-top hexagon of radius 0.8: 1 on its outline
    const d = Math.max(Math.abs(u) / (0.8 * 0.866), (Math.abs(v) + Math.abs(u) * 0.577) / 0.8);
    // the cube's faces meet on a Y from the centre: up to the two upper corners, and straight down
    const top = v > Math.abs(u) * 0.577;
    const shade = top ? 1 : u < 0 ? 0.72 : 0.48;
    const edge = Math.min(Math.abs(v - Math.abs(u) * 0.577), v < 0 ? Math.abs(u) : 1);
    const lum = d > 0.86 ? 1 : Math.max(shade, smooth(0.07, 0, edge));
    return [lum, d <= 1 ? smooth(1, 0.94, d) : 0.28 * smooth(1.22, 1, d)];
  },
  [Cell.Sheath]: (u, v) => [1, smooth(1, 0.55, Math.abs(u)) * Math.exp(-(v * v) / 0.2) * (1 - Math.exp(-(v * v) / 0.016))],
};

/** A cell's [luminance, alpha] at (u, v) in −1…1 (tests). */
export function cellShape(cell: number, u: number, v: number): readonly [number, number] {
  return SHAPES[cell]?.(u, v) ?? [0, 0];
}

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
