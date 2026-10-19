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

  it('software WebGL gets Low, phone or not', () => {
    expect(autoPreset({ touch: false, gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' })).toBe('low');
    expect(autoPreset({ touch: false, gpu: 'llvmpipe (LLVM 15.0.7, 256 bits)' })).toBe('low');
    expect(autoPreset({ touch: true, gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' })).toBe('low');
  });

  it('phones and tablets start as high as their GPU should hold (the owner, 19 Oct: phones "not that clear")', () => {
    const phone = (gpu: string | null, memory?: number, cores?: number) => autoPreset({ touch: true, gpu, memory, cores });
    // iPhones and iPads; Snapdragon 855 and up, 8 Gen 1 and up; Mali G77/G78/G710+, Immortalis; Xclipse
    for (const gpu of ['Apple GPU', 'Adreno (TM) 640', 'Adreno (TM) 660', 'Adreno (TM) 740', 'Adreno (TM) 830', 'Mali-G78 MP20', 'Mali-G715-Immortalis MC11', 'Mali-G710 MC10', 'Samsung Xclipse 920'])
      expect(phone(gpu), gpu).toBe('high');
    // upper-mid: Snapdragon 7-series, Mali G57/G68/G76/G610
    for (const gpu of ['Adreno (TM) 618', 'Adreno (TM) 710', 'Mali-G57 MC2', 'Mali-G68 MC4', 'Mali-G610 MC6', 'WebKit WebGL', null])
      expect(phone(gpu), String(gpu)).toBe('medium');
    // older and budget GPUs
    for (const gpu of ['Adreno (TM) 506', 'Adreno (TM) 610', 'Mali-G52 MC2', 'Mali-T880', 'PowerVR Rogue GE8320'])
      expect(phone(gpu), gpu).toBe('low');
    // little memory or few cores cap it
    expect(phone('Adreno (TM) 740', 4)).toBe('medium');
    expect(phone('Adreno (TM) 740', 2)).toBe('low');
    expect(phone('Adreno (TM) 740', 8, 4)).toBe('medium');
    expect(phone('Adreno (TM) 740', 8, 8)).toBe('high');
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
