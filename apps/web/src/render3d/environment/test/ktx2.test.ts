/**
 * KTX2 map art (ktx2.ts): the array texture the billboards upload, the GPU memory accounting, the
 * WebP fallback, and the shipped copies: Basis ETC1S next to the WebP wherever the copy costs at
 * most 1.2× the WebP's download, with a block-aligned mip chain.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { CompressedTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBA_S3TC_DXT1_Format, SRGBColorSpace, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from '../index';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { arrayFromLayers, ktx2Gate, ktx2Wanted, loadTexture, textureBytes } from '../ktx2';

const PUBLIC = new URL('../../../../public/', import.meta.url);

/** A compressed texture with `levels` mips of BC1 (8 bytes per 4×4 block), every byte `fill`. */
function bc1(width: number, height: number, levels: number, fill: number): CompressedTexture {
  const mipmaps = [];
  for (let l = 0, w = width, h = height; l < levels; l++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    mipmaps.push({ data: new Uint8Array(Math.ceil(w / 4) * Math.ceil(h / 4) * 8).fill(fill), width: w, height: h });
  }
  return new CompressedTexture(mipmaps as never, width, height, RGBA_S3TC_DXT1_Format);
}

interface Ktx2Header {
  vkFormat: number;
  width: number;
  height: number;
  layers: number;
  levels: number;
  supercompression: number;
}

/** The KTX 2.0 header (Khronos KTX 2.0 §3): identifier, then 9 little-endian uint32s. */
function ktx2Header(url: URL): Ktx2Header {
  const buf = readFileSync(url);
  expect([...buf.subarray(0, 12)], url.pathname).toEqual([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const u32 = (i: number) => buf.readUInt32LE(12 + 4 * i);
  return { vkFormat: u32(0), width: u32(2), height: u32(3), layers: u32(5), levels: u32(7), supercompression: u32(8) };
}

/** every level a multiple of 4 texels, or ≤ 2 (what WebGL takes for a compressed level) */
const aligned = (n: number) => n % 4 === 0 || n <= 2;

/**
 * Basis ETC1S: no Vulkan format (transcoded at load), BasisLZ supercompression, and a mip chain
 * whose every level is block-aligned (backdrops.py ktx2_levels), at least 3 levels deep.
 */
function expectEtc1s(h: Ktx2Header, what: string): void {
  expect(h.vkFormat, what).toBe(0);
  expect(h.supercompression, what).toBe(1);
  expect(h.levels, what).toBeGreaterThanOrEqual(3);
  for (let l = 0; l < h.levels; l++) {
    const w = Math.max(1, h.width >> l);
    const hh = Math.max(1, h.height >> l);
    expect(aligned(w) && aligned(hh), `${what}: level ${l} is ${w}×${hh}`).toBe(true);
  }
}

/** KTX2 copies ship only where they cost at most this much of the WebP's download (owner, 18 Oct: mobile data) */
const MAX_RATIO = 1.2;

describe('KTX2 textures', () => {
  it('stacks same-sized compressed layers into one array texture, level by level', () => {
    const layers = [bc1(16, 8, 3, 1), bc1(16, 8, 3, 2), bc1(16, 8, 3, 3)];
    const tex = arrayFromLayers(layers);
    expect(tex.image.depth).toBe(3);
    expect(tex.format).toBe(RGBA_S3TC_DXT1_Format);
    expect(tex.colorSpace).toBe(SRGBColorSpace);
    expect(tex.minFilter).toBe(LinearMipmapLinearFilter);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.mipmaps).toHaveLength(3);
    // level 0: 4 × 2 blocks × 8 bytes per layer, the layers back to back
    const level0 = tex.mipmaps[0]!.data as Uint8Array;
    expect(level0.byteLength).toBe(3 * 64);
    expect([level0[0], level0[64], level0[128]]).toEqual([1, 2, 3]);
    expect(textureBytes(tex)).toBe(layers.reduce((s, l) => s + textureBytes(l), 0));
  });

  it('refuses layers that differ in size, format or mip count', () => {
    expect(() => arrayFromLayers([])).toThrow();
    expect(() => arrayFromLayers([bc1(16, 8, 3, 0), bc1(8, 8, 3, 0)])).toThrow(/differ/);
    expect(() => arrayFromLayers([bc1(16, 8, 3, 0), bc1(16, 8, 2, 0)])).toThrow(/differ/);
  });

  it('counts GPU memory: compressed as uploaded, decoded at 4 bytes a texel (+⅓ with mips)', () => {
    expect(textureBytes(null)).toBe(0);
    expect(textureBytes(bc1(16, 16, 1, 0))).toBe(16 * 8);
    const decoded = new Texture({ width: 100, height: 50 } as never);
    expect(textureBytes(decoded)).toBe(Math.round(100 * 50 * 4 * (4 / 3)));
    decoded.generateMipmaps = false;
    expect(textureBytes(decoded)).toBe(100 * 50 * 4);
    const flat = new DataTexture(new Uint8Array(32 * 32 * 4), 32, 32);
    flat.minFilter = LinearFilter;
    expect(textureBytes(flat)).toBe(32 * 32 * 4);
  });

  it('loads the KTX2 copy when it can, the WebP when it can’t (no transcoder, no copy, or a failure)', async () => {
    const webp = { loadAsync: async () => new Texture<HTMLImageElement>() };
    const ok = { loadAsync: async () => bc1(8, 8, 1, 0) };
    const broken = { loadAsync: async () => Promise.reject(new Error('no wasm')) };
    const got = await loadTexture(ok, 'a.ktx2', 'a.webp', webp);
    expect(got.compressed).toBe(true);
    expect(got.texture.colorSpace).toBe(SRGBColorSpace);
    expect((await loadTexture(null, 'a.ktx2', 'a.webp', webp)).compressed).toBe(false);
    expect((await loadTexture(ok, undefined, 'a.webp', webp)).compressed).toBe(false);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const fallback = await loadTexture(broken, 'a.ktx2', 'a.webp', webp);
      expect(fallback.compressed).toBe(false);
      expect(fallback.texture.colorSpace).toBe(SRGBColorSpace);
    } finally {
      console.warn = warn;
    }
  });
});

describe('where map art loads as KTX2 (owner, 18 Oct: where GPU memory matters)', () => {
  it('touch devices and phones, and the Low preset, get KTX2; desktops on Medium or High keep the WebPs', () => {
    expect(ktx2Wanted('high', false, null)).toBe(false);
    expect(ktx2Wanted('medium', false, null)).toBe(false);
    expect(ktx2Wanted('low', false, null)).toBe(true);
    expect(ktx2Wanted('high', true, null)).toBe(true);
    expect(ktx2Wanted('medium', true, null)).toBe(true);
    // dev builds can force either way (?ktx2=0|1)
    expect(ktx2Wanted('high', false, true)).toBe(true);
    expect(ktx2Wanted('low', true, false)).toBe(false);
  });

  it('a desktop on High never makes a KTX2 loader, so it never requests the transcoder; touch or Low makes one, once', () => {
    let made = 0;
    const loader = { loadAsync: async () => bc1(4, 4, 1, 0) } as unknown as KTX2Loader;
    const gate = ktx2Gate(() => (made++, loader));
    expect(gate('high', false, null)).toBeNull();
    expect(gate('medium', false, null)).toBeNull();
    expect(made).toBe(0);
    expect(gate('low', false, null)).toBe(loader);
    expect(gate('high', true, null)).toBe(loader);
    expect(made).toBe(1);
  });
});

describe('shipped KTX2 copies', () => {
  it('every painted backdrop has its display size in index.json; a KTX2 copy only where it costs ≤ 1.2× the WebP', () => {
    let copies = 0;
    for (const def of Object.values(ENVIRONMENTS)) {
      const b = def.backdrop;
      if (!b) continue;
      const index = JSON.parse(readFileSync(new URL(b.base + 'index.json', PUBLIC)).toString()) as { files: Record<string, { size: [number, number]; ktx2?: string }> };
      const used = new Set([...Object.values(b.skies), ...b.layers.flatMap((l) => l.panels.map((p) => p.file))]);
      for (const file of used) {
        const entry = index.files[file];
        const what = `${def.mapId}: ${file}`;
        expect(entry, what).toBeDefined();
        const webp = new URL(b.base + file, PUBLIC);
        expect(existsSync(webp), what).toBe(true);
        expect(entry!.size[0] > 0 && entry!.size[1] > 0).toBe(true);
        if (!entry!.ktx2) continue;
        copies++;
        const url = new URL(b.base + entry!.ktx2, PUBLIC);
        expectEtc1s(ktx2Header(url), what);
        expect(statSync(url).size, what).toBeLessThanOrEqual(statSync(webp).size * MAX_RATIO);
        // the WebP's size, rounded to block-aligned (the mesh keeps the display aspect)
        const h = ktx2Header(url);
        expect(Math.abs(h.width - entry!.size[0]), what).toBeLessThanOrEqual(16);
        expect(Math.abs(h.height - entry!.size[1]), what).toBeLessThanOrEqual(16);
      }
    }
    // the mid layers carry the GPU memory: they have copies
    expect(copies).toBeGreaterThanOrEqual(5);
  });

  type Entry = { id: string; file: string; ktx2?: string; keys?: { file: string; ktx2?: string }[] };
  it('every house billboard has an ETC1S layer at its format’s size; each format’s layers cost ≤ 1.2× its WebPs', () => {
    for (const def of Object.values(ENVIRONMENTS)) {
      if (!def.ads) continue;
      const pool = JSON.parse(readFileSync(new URL(def.ads.pool, PUBLIC)).toString()) as {
        ktx2Size: Record<string, [number, number]>;
        screens: Entry[];
        hoardings: Entry[];
        sponsored?: { screens: Entry[]; hoardings: Entry[] };
      };
      // local house art and the sponsors' creatives (render3d/ads), Motion keyframes included
      const layers = (list: Entry[]) => list.flatMap((e) => [e, ...(e.keys ?? []).map((k, i) => ({ id: `${e.id}#${i + 1}`, ...k }))]);
      for (const [format, list] of [
        ['4:3', layers([...pool.screens, ...(pool.sponsored?.screens ?? [])])],
        ['6:1', layers([...pool.hoardings, ...(pool.sponsored?.hoardings ?? [])])],
      ] as const) {
        expect(list.length).toBeGreaterThan(0);
        let webp = 0;
        let ktx2 = 0;
        for (const e of list) {
          // a format's layers are one array texture: every creative needs its copy
          expect(e.ktx2, e.id).toBeDefined();
          const url = new URL(def.ads.base + e.ktx2!, PUBLIC);
          const h = ktx2Header(url);
          expectEtc1s(h, e.id);
          expect([h.width, h.height], e.id).toEqual(pool.ktx2Size[format]);
          webp += statSync(new URL(def.ads.base + e.file, PUBLIC)).size;
          ktx2 += statSync(url).size;
        }
        expect(ktx2, format).toBeLessThanOrEqual(webp * MAX_RATIO);
      }
    }
  });

  it('serves the transcoder the loader asks for', () => {
    for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) expect(existsSync(new URL(`assets/vendor/basis/${f}`, PUBLIC)), f).toBe(true);
  });
});
