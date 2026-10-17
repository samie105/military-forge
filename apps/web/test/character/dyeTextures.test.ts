import { describe, expect, it } from 'vitest';
import { bakeDyeMaps, hexToLinear } from '../../src/character/dyeTextures';

const DEFAULTS = ['#b19164', '#736234', '#328b88', '#da9f75'].map(hexToLinear);
const toLinear = (c: number) => ((c / 255) <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);

/** Re-applies the default dyes the way the shader does and returns sRGB 0..255. */
function redye(albedo: Uint8Array, mask: Uint8Array, i: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    let v = toLinear(albedo[i * 4 + c]!);
    for (let ch = 0; ch < 3; ch++) v *= 1 + (DEFAULTS[ch]![c]! - 1) * (mask[i * 4 + ch]! / 255);
    v *= 1 + (DEFAULTS[3]![c]! - 1) * (albedo[i * 4 + 3]! / 255);
    out.push(Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)));
  }
  return out;
}

describe('bakeDyeMaps', () => {
  // sand, olive, teal, skin, brown boot, atlas gutter (black) between them
  const texels = [[150, 123, 83], [80, 68, 35], [40, 112, 108], [200, 145, 105], [73, 51, 32], [0, 0, 0]];
  const rgba = Uint8Array.from(texels.flatMap((t) => [...t, 255]));
  const { albedo, mask } = bakeDyeMaps(rgba, texels.length, DEFAULTS);

  it('puts each painted colour on its channel: R primary, G secondary, B accent, albedo A skin', () => {
    const channels = (i: number) => [mask[i * 4], mask[i * 4 + 1], mask[i * 4 + 2], albedo[i * 4 + 3]].map((v) => Math.round(v! / 255));
    expect(channels(0)).toEqual([1, 0, 0, 0]);
    expect(channels(1)).toEqual([0, 1, 0, 0]);
    expect(channels(2)).toEqual([0, 0, 1, 0]);
    expect(channels(3)).toEqual([0, 0, 0, 1]);
    expect(channels(4)).toEqual([0, 0, 0, 0]);
    for (let i = 0; i < texels.length; i++) expect(mask[i * 4 + 3]).toBe(0); // no emissive in procedural masks
  });

  it('neutralises dyed texels to grey, and the default dyes give the painted look back', () => {
    for (const i of [0, 1, 2, 3]) {
      expect(albedo[i * 4]).toBe(albedo[i * 4 + 1]);
      expect(albedo[i * 4 + 1]).toBe(albedo[i * 4 + 2]);
    }
    for (let i = 0; i < 5; i++) {
      const got = redye(albedo, mask, i);
      // grey neutralisation keeps brightness exactly and hue to the default dye's hue
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - texels[i]![c]!), `texel ${i} channel ${c}`).toBeLessThanOrEqual(12);
    }
    expect([...albedo.subarray(16, 19)]).toEqual([73, 51, 32]); // undyed texels are untouched
  });

  it('grows islands into the atlas gutter so mipmaps do not bleed black into seams', () => {
    expect([...albedo.subarray(20, 24)]).toEqual([...albedo.subarray(16, 20)]);
    expect([...mask.subarray(20, 24)]).toEqual([...mask.subarray(16, 20)]);
  });
});
