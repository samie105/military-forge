/**
 * Skin weights for the body's dye albedo (docs/04 §5.4). W8's `rookie_body*_dye_albedo.webp` has the dyeable
 * texels (uniform, webbing, armband) neutralised to grey but no skin channel yet (w2-asset-requirements.md asks
 * for one in the albedo's alpha). Until it ships, the skin is found by colour at load time: skin is the one
 * warm, mid-saturated, well-lit region, and grey dye texels, teal accents and the dark-brown hair and straps
 * all fall outside it. The result follows the DyeMaterial contract:
 *   albedo.a   = skin weight
 *   albedo.rgb = painted / lerp(1, 2 × defaultSkin, weight), so the default skin tone gives back the painted look
 *                (2×: headroom for the baked highlights, which are brighter than the tone).
 * A texture that already carries alpha (W8's fix) is used as it is.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, type Texture } from 'three';

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const LINEAR_TO_SRGB = new Uint8Array(4096).map((_, i) => {
  const c = i / 4095;
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
});
const encode = (linear: number) => LINEAR_TO_SRGB[Math.round(Math.min(1, Math.max(0, linear)) * 4095)]!;

/** sRGB hex → linear [r, g, b]. */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [SRGB_TO_LINEAR[(n >> 16) & 255]!, SRGB_TO_LINEAR[(n >> 8) & 255]!, SRGB_TO_LINEAR[n & 255]!];
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** sRGB 0..255 → [hue°, saturation, value] */
function hsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return [0, 0, max / 255];
  const d = max - min;
  const h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  return [(((h * 60) % 360) + 360) % 360, d / max, max / 255];
}

/** How much an sRGB texel (0..255) looks like painted skin, 0..1: hue −10–30°, saturation 0.3–0.85, value ≥ 0.55. */
export function skinLikeness(r: number, g: number, b: number): number {
  const [h, s, v] = hsv(r, g, b);
  const hue = (h > 180 ? smoothstep(345, 355, h) : 1) * (1 - smoothstep(30, 38, h));
  const sat = smoothstep(0.22, 0.32, s) * (1 - smoothstep(0.82, 0.92, s));
  return hue * sat * smoothstep(0.38, 0.55, v);
}

/** Separable square min/max filter of radius `r` (morphology on a weight map). */
function morph(src: Float32Array, width: number, height: number, r: number, op: (a: number, b: number) => number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = src[y * width + x]!;
      for (let k = Math.max(0, x - r); k <= Math.min(width - 1, x + r); k++) m = op(m, src[y * width + k]!);
      tmp[y * width + x] = m;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = tmp[y * width + x]!;
      for (let k = Math.max(0, y - r); k <= Math.min(height - 1, y + r); k++) m = op(m, tmp[k * width + x]!);
      out[y * width + x] = m;
    }
  }
  return out;
}

/**
 * Skin weight per texel. Colour alone also catches the khaki soft edges of the dyed uniform islands, so:
 * 1. skin cores: texels clearly skin-coloured, with thin rims opened away (radius 1);
 * 2. grown back through anything fairly skin-coloured connected to a core (whole faces and hands, no rims);
 * 3. small holes inside skin closed (radius 2): bright, faintly warm baked highlights and the darker soft
 *    outlines of eyes, brows and mouth, so a dark skin tone darkens them too instead of leaving pale specks and
 *    rings. Neutral grey (dye texels) and cool colours are never filled.
 */
export function skinWeights(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Float32Array {
  const n = width * height;
  const likeness = new Float32Array(n);
  const core = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    likeness[i] = skinLikeness(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
    core[i] = likeness[i]! > 0.5 ? 1 : 0;
  }
  const opened = morph(morph(core, width, height, 1, Math.min), width, height, 1, Math.max);
  const skin = new Float32Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (opened[i]! <= 0.5 || likeness[i]! <= 0.3) continue;
    skin[i] = likeness[i]!;
    queue.push(i);
  }
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
      if (j < 0 || j >= n || skin[j]! > 0 || likeness[j]! <= 0.3) continue;
      skin[j] = likeness[j]!;
      queue.push(j);
    }
  }
  const closed = morph(morph(skin, width, height, 2, Math.max), width, height, 2, Math.min);
  for (let i = 0; i < n; i++) {
    // only texels that don't look like skin themselves: a skin-coloured texel left out is a rim, not a hole
    if (closed[i]! <= skin[i]! || likeness[i]! > 0.3) continue;
    // a highlight is bright and faintly warm (neutral grey is a dye texel); the soft outline of an eye, brow or
    // mouth is darker skin: both follow the tone. Cool colours (teal lenses, blue-grey) never do.
    const [h, s, v] = hsv(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
    const warmHue = Math.max(1 - smoothstep(45, 60, h), smoothstep(330, 345, h));
    const highlight = smoothstep(0.6, 0.75, v) * smoothstep(0.02, 0.06, s) * warmHue;
    const outline = (1 - smoothstep(0.45, 0.6, v)) * (1 - smoothstep(0.15, 0.25, s) * (1 - warmHue));
    skin[i] = Math.max(skin[i]!, closed[i]! * Math.max(highlight, outline));
  }
  return skin;
}

/** The skin channel has 2× headroom (the shader multiplies by 2 × skin tone), so highlights brighter than the default tone survive. */
export const SKIN_HEADROOM = 2;

/**
 * RGBA8 pixels of a skin-less dye albedo → RGBA8 with the skin weight in A and the skin texels divided by
 * lerp(1, SKIN_HEADROOM × default skin tone, weight) in linear space.
 */
export function bakeSkin(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, defaultSkin: readonly [number, number, number]): Uint8Array {
  const weights = skinWeights(rgba, width, height);
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const w = weights[i / 4]!;
    for (let c = 0; c < 3; c++) out[i + c] = w === 0 ? rgba[i + c]! : encode(SRGB_TO_LINEAR[rgba[i + c]!]! / (1 + (SKIN_HEADROOM * defaultSkin[c]! - 1) * w));
    out[i + 3] = Math.round(w * 255);
  }
  return out;
}

interface Pixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** An image's RGBA pixels: DataTextures hold them already; decoded images go through a 2D canvas (browser only). */
function pixelsOf(texture: Texture): Pixels {
  const image = texture.image as (CanvasImageSource | Pixels) & { width: number; height: number };
  if ('data' in image && image.data) return image as Pixels;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image as CanvasImageSource, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

/** The body's dye albedo with skin weights (see above), as a mipmapped sRGB DataTexture (no premultiplied alpha). Disposes `source`. */
export function bodyAlbedoWithSkin(source: Texture, defaultSkinHex: string): Texture {
  const { data, width, height } = pixelsOf(source);
  const tex = new DataTexture(bakeSkin(data, width, height, hexToLinear(defaultSkinHex)), width, height, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.flipY = false; // glTF UV convention, like the source
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  source.dispose();
  (source.image as ImageBitmap | undefined)?.close?.();
  return tex;
}
