/**
 * Settings → Graphics → Auto (gfxAuto.ts): the preset follows the device; and the page flag that
 * offers a room's host the tuning panel (hostTuning.ts, pnpm playtest --tune).
 */
import { describe, expect, it } from 'vitest';
import { autoPreset } from '../src/gfxAuto';
import { tuningOffered } from '../src/hostTuning';

describe('Auto graphics', () => {
  it('a desktop with a real GPU gets High (the owner found Low blurry on a Retina Mac)', () => {
    for (const gpu of [
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
      'Apple GPU',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ])
      expect(autoPreset({ touch: false, gpu }), gpu).toBe('high');
  });

  it('integrated graphics, or a GPU the browser hides, get Medium', () => {
    for (const gpu of [
      'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'WebKit WebGL',
      null,
    ])
      expect(autoPreset({ touch: false, gpu }), String(gpu)).toBe('medium');
  });

  it('phones and tablets, and software WebGL, get Low', () => {
    expect(autoPreset({ touch: true, gpu: 'Apple GPU' })).toBe('low');
    expect(autoPreset({ touch: true, gpu: 'Adreno (TM) 740' })).toBe('low');
    expect(autoPreset({ touch: false, gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' })).toBe('low');
    expect(autoPreset({ touch: false, gpu: 'llvmpipe (LLVM 15.0.7, 256 bits)' })).toBe('low');
  });
});

describe("the host's tuning panel", () => {
  const page = (meta: string | null) => ({ querySelector: (q: string) => (meta && q.includes(`content="${meta}"`) ? {} : null) }) as unknown as Document;

  it('is offered where pnpm playtest --tune flagged the page, and in dev builds; never on a normal production page', () => {
    expect(tuningOffered(page('host'), false)).toBe(true);
    expect(tuningOffered(page(null), false)).toBe(false);
    expect(tuningOffered(page(null), true)).toBe(true);
  });
});
