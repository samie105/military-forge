/**
 * Procedural textures for the map environment, generated at load from a hash (0 bytes to download,
 * identical on every load, no Math.random). All are linear greyscale multipliers or alpha masks
 * that tile, built for a box-projected world UV of a few metres per tile.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType, type Texture } from 'three';

/** Deterministic hash of an integer lattice point → [0, 1). */
export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (i: number, n: number) => ((i % n) + n) % n;

/** Value noise that tiles over [0, 1)²: `cellsX` × `cellsY` lattice cells across the tile. */
export function tileNoise(u: number, v: number, cellsX: number, cellsY: number, seed: number): number {
  const x = u * cellsX;
  const y = v * cellsY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const xa = wrap(x0, cellsX);
  const xb = wrap(x0 + 1, cellsX);
  const ya = wrap(y0, cellsY);
  const yb = wrap(y0 + 1, cellsY);
  const a = hash2(xa, ya, seed);
  const b = hash2(xb, ya, seed);
  const c = hash2(xa, yb, seed);
  const d = hash2(xb, yb, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Tiling fractal noise in [0, 1). */
export function tileFbm(u: number, v: number, cells: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(u, v, cells << o, cells << o, seed + o * 17);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

function dataTexture(size: number, value: (u: number, v: number, x: number, y: number) => number, repeat = true): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const g = Math.round(Math.min(1, Math.max(0, value((x + 0.5) / size, (y + 0.5) / size, x, y))) * 255);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = g;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  if (repeat) tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Weathering for painted concrete and plaster: broad blotches, rain streaks running down (v is up
 * on walls) and a fine speckle. Mean ≈ 0.92, never below ≈ 0.72, so it reads as grime on the
 * vertex colours without changing their hue.
 */
export function grimeTexture(size = 256, seed = 7): DataTexture {
  return dataTexture(size, (u, v, x, y) => {
    const blotch = tileFbm(u, v, 4, 4, seed);
    let g = 1 - 0.17 * smoothstep(0.42, 0.78, blotch);
    // streaks: thin columns, longer than wide, fading out toward their top
    const column = tileNoise(u, 0, 40, 1, seed + 101);
    const run = tileNoise(u, v, 40, 3, seed + 202);
    g -= 0.11 * smoothstep(0.62, 0.92, column) * smoothstep(0.25, 0.85, run) * (0.6 + 0.4 * (1 - v));
    g -= 0.05 * tileFbm(u, v, 16, 2, seed + 303);
    g += 0.035 * (hash2(x, y, seed + 404) - 0.5);
    return g;
  });
}

/** Asphalt: worn patches and an aggregate speckle (mean ≈ 0.9). */
export function asphaltTexture(size = 256, seed = 11): DataTexture {
  return dataTexture(size, (u, v, x, y) => {
    let g = 0.94 - 0.14 * tileFbm(u, v, 3, 4, seed);
    g += 0.09 * smoothstep(0.62, 0.9, tileFbm(u, v, 6, 3, seed + 50)); // sun-bleached patches
    const s = hash2(x, y, seed + 60);
    g += s > 0.93 ? 0.12 : s < 0.06 ? -0.1 : 0;
    return g;
  });
}

/**
 * A soft rectangle (alpha in every channel) for contact shadows: opaque in the middle, fading to 0
 * at the edges, so a quad a bit larger than an object's footprint darkens the ground under it.
 */
export function softBoxTexture(size = 64): DataTexture {
  return dataTexture(
    size,
    (u, v) => {
      const fx = 1 - smoothstep(0.35, 1, Math.abs(u * 2 - 1));
      const fz = 1 - smoothstep(0.2, 1, Math.abs(v * 2 - 1));
      return Math.pow(fx * fz, 1.2);
    },
    false,
  );
}

/** A radial glow (alpha falls off from the centre), for the sun. */
export function glowTexture(size = 128): DataTexture {
  return dataTexture(
    size,
    (u, v) => {
      const r = Math.min(1, Math.hypot(u * 2 - 1, v * 2 - 1));
      return Math.pow(1 - r, 2.2);
    },
    false,
  );
}

export function disposeTextures(textures: readonly Texture[]): void {
  for (const t of textures) t.dispose();
}
