import { describe, expect, it } from 'vitest';
import { cellUv, flipFrame } from '../../src/armory/specials';

describe('specials atlas helpers', () => {
  it('maps a cell (row-major from the top left) to flipY UVs', () => {
    // specials_atlas.webp: 512², cells of 128²; cell 5 is row 1, column 1
    expect(cellUv([512, 512], [128, 128], 5)).toEqual({ offset: [0.25, 0.5], repeat: [0.25, 0.25] });
    // the top-left cell sits at the top of the texture (v runs up from the bottom)
    expect(cellUv([1024, 1024], [256, 256], 0).offset).toEqual([0, 0.75]);
  });

  it('plays a flipbook over a life and holds the last frame', () => {
    expect(flipFrame(16, 0, { lifeS: 0.8 })).toBe(0);
    expect(flipFrame(16, 0.4, { lifeS: 0.8 })).toBe(8);
    expect(flipFrame(16, 2, { lifeS: 0.8 })).toBe(15);
  });

  it('loops at fps', () => {
    expect(flipFrame(4, 0.25, { fps: 16, loop: true })).toBe(0);
    expect(flipFrame(4, 0.3, { fps: 16, loop: true })).toBe(0);
    expect(flipFrame(4, 0.32, { fps: 16, loop: true })).toBe(1);
  });
});
