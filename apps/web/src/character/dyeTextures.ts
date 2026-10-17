/**
 * Procedural dye textures for an albedo painted without a dye mask (the Phase 0 Rookie). W8's
 * baked masks replace this when the split body lands; the channel layout is the same
 * (docs/04 §5.4, w8-art-assets.md):
 *   mask:   R = primary, G = secondary, B = accent, A = emissive team glow (none here)
 *   albedo: RGB neutralised so that `albedo × lerp(1, dye, mask)` with the default dyes gives back
 *           the painted texel; A = skin weight (tinted by the skin tone the same way)
 * Texels are classified by their nearest reference colour, then dyeable
 * texels become grey with the brightness they had relative to the channel's default dye.
 */
import { DataTexture, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, SRGBColorSpace, type Texture } from 'three';

/** 0 primary, 1 secondary, 2 accent, 3 skin, -1 not dyeable */
export type DyeTarget = 0 | 1 | 2 | 3 | -1;

export interface DyeReference {
  /** sRGB 0..255 */
  rgb: readonly [number, number, number];
  target: DyeTarget;
}

/** Colour clusters of the Phase 0 Rookie albedo (k-means, 8 clusters, chromaticity + lightness). */
export const ROOKIE_PHASE0_REFERENCES: readonly DyeReference[] = [
  { rgb: [155, 127, 86], target: 0 }, // sand fatigues + helmet
  { rgb: [77, 66, 33], target: 1 }, // olive webbing and pouches
  { rgb: [32, 102, 99], target: 2 }, // teal armband and goggle lenses
  { rgb: [201, 146, 106], target: 3 }, // skin
  { rgb: [73, 51, 32], target: -1 }, // brown boots and straps
  { rgb: [63, 53, 39], target: -1 },
  { rgb: [39, 22, 4], target: -1 },
  { rgb: [21, 2, 0], target: -1 },
];

/** Softmax temperature on squared feature distances: nearly hard, so JPEG noise inside a region
 *  doesn't split texels between channels (mixed texels show as pale specks once dyed). */
const SOFTNESS = 0.0003;
const LUMA = [0.2126, 0.7152, 0.0722] as const;

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const LINEAR_TO_SRGB = new Uint8Array(4096).map((_, i) => {
  const c = i / 4095;
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
});
const encode = (linear: number) => LINEAR_TO_SRGB[Math.round(Math.min(1, Math.max(0, linear)) * 4095)]!;

function feature(r: number, g: number, b: number, out: Float32Array): void {
  const sum = Math.max(r + g + b, 1e-4);
  out[0] = (3 * r) / sum;
  out[1] = (3 * g) / sum;
  out[2] = (3 * b) / sum;
  out[3] = (0.8 * (r + g + b)) / 3;
}

/** sRGB hex → linear [r, g, b]. */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [SRGB_TO_LINEAR[(n >> 16) & 255]!, SRGB_TO_LINEAR[(n >> 8) & 255]!, SRGB_TO_LINEAR[n & 255]!];
}

/** Texels darker than this (sRGB 0..255 max channel) are atlas gutters: no UV island covers them. */
const GUTTER = 6;
/** Gutter texels filled from their island's edge, so mipmaps don't bleed black into the seams. */
const DILATE_PASSES = 4;

/**
 * RGBA8 albedo pixels (`width` texels per row) → { albedo, mask } RGBA8 pixels of the same size.
 * `defaults` are the linear colours of the default primary, secondary, accent dye and skin tone.
 */
export function bakeDyeMaps(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  defaults: readonly (readonly [number, number, number])[],
  references: readonly DyeReference[] = ROOKIE_PHASE0_REFERENCES,
): { albedo: Uint8Array; mask: Uint8Array } {
  const refs = references.map((r) => {
    const f = new Float32Array(4);
    feature(r.rgb[0] / 255, r.rgb[1] / 255, r.rgb[2] / 255, f);
    return { f, target: r.target };
  });
  const albedo = new Uint8Array(rgba.length);
  const mask = new Uint8Array(rgba.length);
  const f = new Float32Array(4);
  const dist = new Float32Array(refs.length);
  const w = [0, 0, 0, 0];
  for (let i = 0; i < rgba.length; i += 4) {
    const r8 = rgba[i]!, g8 = rgba[i + 1]!, b8 = rgba[i + 2]!;
    feature(r8 / 255, g8 / 255, b8 / 255, f);
    let min = Infinity;
    for (let k = 0; k < refs.length; k++) {
      const rf = refs[k]!.f;
      const d = (f[0]! - rf[0]!) ** 2 + (f[1]! - rf[1]!) ** 2 + (f[2]! - rf[2]!) ** 2 + (f[3]! - rf[3]!) ** 2;
      dist[k] = d;
      if (d < min) min = d;
    }
    w[0] = w[1] = w[2] = w[3] = 0;
    let total = 0;
    for (let k = 0; k < refs.length; k++) {
      const e = Math.exp(-(dist[k]! - min) / SOFTNESS);
      total += e;
      const t = refs[k]!.target;
      if (t >= 0) w[t]! += e;
    }
    // Near-black texels (creases, atlas gutters) have unstable chromaticity: never dye them.
    const x = Math.min(1, Math.max(0, (Math.max(r8, g8, b8) / 255 - 0.08) / 0.08));
    const gate = (x * x * (3 - 2 * x)) / total;
    let weight = 0;
    const m = [1, 1, 1];
    for (let t = 0; t < 4; t++) {
      w[t]! *= gate;
      weight += w[t]!;
      for (let c = 0; c < 3; c++) m[c]! *= 1 + (defaults[t]![c]! - 1) * w[t]!;
    }
    const lin = [SRGB_TO_LINEAR[r8]!, SRGB_TO_LINEAR[g8]!, SRGB_TO_LINEAR[b8]!];
    const grey = Math.min(1, (LUMA[0] * lin[0]! + LUMA[1] * lin[1]! + LUMA[2] * lin[2]!) / Math.max(1e-5, LUMA[0] * m[0]! + LUMA[1] * m[1]! + LUMA[2] * m[2]!));
    weight = Math.min(1, weight);
    for (let c = 0; c < 3; c++) albedo[i + c] = encode((1 - weight) * Math.min(1, lin[c]! / m[c]!) + weight * grey);
    albedo[i + 3] = Math.round(w[3]! * 255);
    mask[i] = Math.round(w[0]! * 255);
    mask[i + 1] = Math.round(w[1]! * 255);
    mask[i + 2] = Math.round(w[2]! * 255);
    mask[i + 3] = 0;
  }
  dilate(rgba, width, [albedo, mask]);
  return { albedo, mask };
}

/** Grows UV islands into the gutter by DILATE_PASSES texels (copies of the nearest filled neighbour). */
function dilate(source: Uint8Array | Uint8ClampedArray, width: number, layers: Uint8Array[]): void {
  const count = source.length / 4;
  const height = count / width;
  let filled = new Uint8Array(count);
  for (let p = 0; p < count; p++) filled[p] = Math.max(source[p * 4]!, source[p * 4 + 1]!, source[p * 4 + 2]!) >= GUTTER ? 1 : 0;
  for (let pass = 0; pass < DILATE_PASSES; pass++) {
    const next = filled.slice();
    for (let p = 0; p < count; p++) {
      if (filled[p]) continue;
      const x = p % width, y = (p - x) / width;
      const from = x > 0 && filled[p - 1] ? p - 1 : x < width - 1 && filled[p + 1] ? p + 1 : y > 0 && filled[p - width] ? p - width : y < height - 1 && filled[p + width] ? p + width : -1;
      if (from < 0) continue;
      for (const layer of layers) layer.copyWithin(p * 4, from * 4, from * 4 + 4);
      next[p] = 1;
    }
    filled = next;
  }
}

/** Reads an image's pixels (browser only). */
function imagePixels(image: CanvasImageSource & { width: number; height: number }): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

function dataTexture(pixels: Uint8Array, width: number, height: number, srgb: boolean): Texture {
  const tex = new DataTexture(pixels, width, height, RGBAFormat);
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.flipY = false; // glTF UV convention, same as the source texture
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Albedo texture from a GLB → dye-ready albedo + mask textures (DataTextures: no premultiplied alpha),
 *  plus a lookup of the skin weight at a UV (for telling face from helmet). */
export function createDyeTextures(
  source: Texture,
  defaults: readonly (readonly [number, number, number])[],
): { albedo: Texture; mask: Texture; skinAt: (u: number, v: number) => number } {
  // DataTexture sources already hold their pixels; decoded images (GLTFLoader: ImageBitmap) go through a canvas.
  const image = source.image as (CanvasImageSource | { data: Uint8Array }) & { width: number; height: number };
  const { data, width, height } = 'data' in image ? image : imagePixels(image);
  const baked = bakeDyeMaps(data, width, defaults);
  const skinAt = (u: number, v: number) => {
    const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
    return baked.albedo[(y * width + x) * 4 + 3]! / 255;
  };
  return { albedo: dataTexture(baked.albedo, width, height, true), mask: dataTexture(baked.mask, width, height, false), skinAt };
}
