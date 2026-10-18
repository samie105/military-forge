import { describe, expect, it } from 'vitest';
import { SKIN_HEADROOM, bakeSkin, hexToLinear, skinLikeness, skinWeights } from '../../src/character/skinMask';

describe('skin weights for the body dye albedo', () => {
  it('finds lit skin and leaves grey dye texels, teal accents and dark-brown hair alone', () => {
    expect(skinLikeness(218, 159, 117)).toBeGreaterThan(0.95); // skin_04, the default tone
    expect(skinLikeness(201, 146, 106)).toBeGreaterThan(0.95); // painted skin
    expect(skinLikeness(200, 200, 200)).toBe(0); // neutral grey (a dyed texel)
    expect(skinLikeness(32, 102, 99)).toBe(0); // teal armband
    expect(skinLikeness(73, 51, 32)).toBe(0); // dark-brown hair and straps
    expect(skinLikeness(0, 0, 0)).toBe(0);
  });

  it('puts the weight in alpha and divides skin by 2 × the default tone, so the default tone gives the painted look back', () => {
    const skin = hexToLinear('#da9f75');
    // a 4×4 patch of skin, so it survives the rim opening, and a grey texel
    const px = new Uint8Array(5 * 4 * 4);
    for (let i = 0; i < 20; i++) px.set(i === 19 ? [200, 200, 200, 255] : [218, 159, 117, 255], i * 4);
    const out = bakeSkin(px, 5, 4, skin);
    expect(out[3]).toBe(255);
    const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    for (let c = 0; c < 3; c++) expect(lin(out[c]!) * SKIN_HEADROOM * skin[c]!).toBeCloseTo(lin([218, 159, 117][c]!), 2);
    expect(Array.from(out.subarray(19 * 4))).toEqual([200, 200, 200, 0]);
  });

  it('skips thin skin-coloured rims (the khaki edges of dyed islands) but fills highlights inside skin', () => {
    const w = 9;
    const h = 9;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([200, 200, 200, 255], i * 4);
    const set = (x: number, y: number, rgb: number[]) => px.set([...rgb, 255], (y * w + x) * 4);
    for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) set(x, y, [218, 159, 117]); // a skin island
    set(3, 3, [250, 240, 230]); // a baked highlight inside it
    for (let y = 0; y < h; y++) set(8, y, [214, 160, 120]); // a 1-texel skin-coloured rim elsewhere
    const weights = skinWeights(px, w, h);
    expect(weights[3 * w + 3]).toBeGreaterThan(0.9);
    expect(weights[1 * w + 1]).toBeGreaterThan(0.9);
    for (let y = 0; y < h; y++) expect(weights[y * w + 8]).toBe(0);
  });
});
