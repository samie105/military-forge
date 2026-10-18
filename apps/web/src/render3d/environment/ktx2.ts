/**
 * KTX2 textures (docs/11 §1 and §4: Basis ETC1S, transcoded in a worker to whatever the GPU takes:
 * BC1/BC3 on desktop, ETC2 or ASTC on mobile), with the WebP (or canvas) original as the fallback
 * wherever the runtime can't transcode (no WebAssembly, the transcoder or the file fails to load).
 *
 * Map art stays compressed on the GPU: 4 bits per pixel for opaque ETC1S, 8 with alpha, instead
 * of 32 for a decoded WebP. A copy ships only where it costs at most 1.2× the WebP's download
 * (apps/web/scripts/backdrops.py, house-ads.py: players on mobile data); its size is the WebP's
 * rounded to block-aligned, with the block-aligned part of the mip chain, so the display size
 * comes from the art's index (backdrops) or the board's quad (billboards).
 *
 * The transcoder (three 0.186.1's basis_transcoder.js + .wasm, ≈ 217 KB brotli, cached after the
 * first map) is served from assets/vendor/basis/ and loads only when a map first asks for a KTX2
 * file, which happens only where `ktx2Wanted`: touch devices and phones, and the Low preset.
 */
import {
  CompressedArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
  TextureLoader,
  type CompressedTexture,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { PresetName } from '../presets';

/** what the environment needs from a KTX2Loader (null: no transcoding, WebP only) */
export type Ktx2Source = Pick<KTX2Loader, 'loadAsync'> | null;

/** `?ktx2=0|1` in dev builds (WebP vs KTX2 comparisons on any device); null otherwise. */
function devOverride(): boolean | null {
  if (!import.meta.env.DEV) return null;
  try {
    const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('ktx2');
    return v === '0' ? false : v === '1' ? true : null;
  } catch {
    return null;
  }
}

/**
 * Whether a map's art loads as KTX2 (owner, 18 Oct): only where GPU memory matters, on touch
 * devices and phones and on the Low preset. Desktops on Medium or High keep the WebPs and never
 * fetch the transcoder (≈ 217 KB). Dev builds can force either way with `?ktx2=0|1`.
 */
export function ktx2Wanted(preset: PresetName, touch: boolean, override: boolean | null = devOverride()): boolean {
  return override ?? (touch || preset === 'low');
}

/**
 * The renderer's KTX2 source for a map: made on first need, and only where `ktx2Wanted`. No loader
 * means no transcoder request. Decided per map load, so a preset change applies from the next map.
 */
export function ktx2Gate(make: () => KTX2Loader | null): (preset: PresetName, touch: boolean, override?: boolean | null) => Ktx2Source {
  let loader: KTX2Loader | null | undefined;
  return (preset, touch, override) => {
    if (!ktx2Wanted(preset, touch, override === undefined ? devOverride() : override)) return null;
    if (loader === undefined) loader = make();
    return loader;
  };
}

/** One loader per renderer: it picks the transcode target from the renderer's extensions. */
export function createKtx2(renderer: WebGLRenderer, baseUrl: string): KTX2Loader | null {
  if (typeof WebAssembly === 'undefined') return null;
  try {
    return new KTX2Loader().setTranscoderPath(`${baseUrl}assets/vendor/basis/`).detectSupport(renderer);
  } catch (err) {
    console.warn('render3d: no KTX2 transcoding, map art loads as WebP', err);
    return null;
  }
}

export interface LoadedTexture {
  texture: Texture;
  /** came from the KTX2 copy */
  compressed: boolean;
}

/**
 * The KTX2 copy when there's a loader and a copy, else (or if it fails) the WebP. Rejects only
 * when the WebP fails too.
 */
export async function loadTexture(ktx2: Ktx2Source, ktx2Url: string | null | undefined, webpUrl: string, webp: Pick<TextureLoader, 'loadAsync'> = new TextureLoader()): Promise<LoadedTexture> {
  if (ktx2 && ktx2Url) {
    try {
      const texture = await ktx2.loadAsync(ktx2Url);
      texture.colorSpace = SRGBColorSpace;
      return { texture, compressed: true };
    } catch (err) {
      console.warn(`render3d: ${ktx2Url} not transcoded, loading the WebP`, err);
    }
  }
  const texture = await webp.loadAsync(webpUrl);
  texture.colorSpace = SRGBColorSpace;
  return { texture, compressed: false };
}

/**
 * One CompressedArrayTexture from same-sized, same-format KTX2 textures: each mip level's data is
 * the layers' data for that level, back to back (what compressedTexImage3D takes). Throws if the
 * layers don't match.
 */
export function arrayFromLayers(layers: readonly CompressedTexture[]): CompressedArrayTexture {
  const first = layers[0];
  if (!first) throw new Error('no layers');
  const levels = first.mipmaps.length;
  for (const t of layers) {
    if (t.format !== first.format || t.mipmaps.length !== levels || t.image.width !== first.image.width || t.image.height !== first.image.height) {
      throw new Error('KTX2 layers differ in size, format or mip count');
    }
  }
  const mipmaps = first.mipmaps.map((m, level) => {
    const size = m.data.byteLength;
    const data = new Uint8Array(size * layers.length);
    layers.forEach((t, i) => {
      const d = t.mipmaps[level]!.data;
      if (d.byteLength !== size) throw new Error('KTX2 layers differ in size');
      data.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), i * size);
    });
    return { data, width: m.width, height: m.height };
  });
  const tex = new CompressedArrayTexture(mipmaps as never, first.image.width, first.image.height, layers.length, first.format, first.type);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = levels > 1 ? LinearMipmapLinearFilter : LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * GPU memory a texture takes, bytes: a compressed one's mip data as uploaded; a decoded image or
 * data texture at 4 bytes a texel (× 4/3 with a mip chain), times its layers.
 */
export function textureBytes(t: Texture | null | undefined): number {
  if (!t) return 0;
  const mips = (t as CompressedTexture).mipmaps as { data?: ArrayBufferView }[] | undefined;
  if ((t as CompressedTexture).isCompressedTexture && mips?.length) return mips.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0);
  const img = t.image as { width?: number; height?: number; depth?: number } | null;
  if (!img?.width || !img.height) return 0;
  const mipped = t.generateMipmaps && t.minFilter !== LinearFilter;
  return Math.round(img.width * img.height * (img.depth ?? 1) * 4 * (mipped ? 4 / 3 : 1));
}
