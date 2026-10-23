/**
 * Animation LOD (animLod.ts; docs/design/character-feel-research.md §3.8): off screen nothing but the position, small
 * or LOD1 soldiers posed at half rate without planted feet, the local player always in full.
 */
import { describe, expect, it, vi } from 'vitest';
import { ANIM_LOD, FULL_DETAIL, HALF_DETAIL, NO_DETAIL, animDetail, type LodView } from '../animLod';
import { DT, FLAT_X, feelAvatar, world } from './feel';
import { playerView } from './helpers';

/** a phone in landscape: 812×375 px showing 24 m × ~11 m */
const view: LodView = { x: 100, y: 5, halfExtents: { halfW: 12, halfH: 5.5 }, band: { top: 0, bottom: 375 } };

describe('animation LOD: which detail', () => {
  it('poses the local player in full, wherever it is', () => {
    expect(animDetail(500, 500, true, 1, view)).toBe(FULL_DETAIL);
  });

  it('poses nobody off screen, beyond the 2 m margin', () => {
    expect(animDetail(100 + 12 + ANIM_LOD.margin + 0.1, 5, false, 0, view)).toBe(NO_DETAIL);
    expect(animDetail(100 + 12 + ANIM_LOD.margin - 0.1, 5, false, 0, view)).toBe(FULL_DETAIL);
    expect(animDetail(100, 5 - 5.5 - ANIM_LOD.margin - 1, false, 0, view)).toBe(NO_DETAIL);
  });

  it('poses small or LOD1 soldiers at half rate without planted feet', () => {
    expect(animDetail(100, 5, false, 1, view)).toBe(HALF_DETAIL);
    // zoomed far out: 1.25 m under 40 px
    const far: LodView = { ...view, halfExtents: { halfW: 40, halfH: 18.5 } };
    expect(animDetail(100, 5, false, 0, far)).toBe(HALF_DETAIL);
    expect(HALF_DETAIL.planted).toBe(false);
  });
});

describe('animation LOD: the avatar', () => {
  const run = async (detail: typeof FULL_DETAIL, frames = 60) => {
    const av = await feelAvatar();
    const mixer = (av as unknown as { mixer: { update: (dt: number) => void } }).mixer;
    // a first full frame, then count
    av.update(playerView({ x: FLAT_X, aim: 0.15 }), DT, world, false);
    const updates = vi.spyOn(mixer, 'update');
    const rays = vi.spyOn(world, 'raycast');
    for (let i = 0; i < frames; i++) av.update(playerView({ x: FLAT_X + i * 0.02, vx: 1.2, aim: 0.15 }), DT, world, false, detail);
    const out = { mixer: updates.mock.calls.length, rays: rays.mock.calls.length, x: av.pivot.position.x, time: updates.mock.calls.reduce((a, c) => a + (c[0] as number), 0) };
    updates.mockRestore();
    rays.mockRestore();
    return out;
  };

  it('off screen: no mixer updates and no raycasts, but the body follows its position', async () => {
    const r = await run(NO_DETAIL);
    expect(r.mixer).toBe(0);
    expect(r.rays).toBe(0);
    expect(r.x).toBeCloseTo(FLAT_X + 59 * 0.02, 6);
  });

  it('small or LOD1: half the mixer updates, the same animation time, and no foot raycasts', async () => {
    const r = await run(HALF_DETAIL);
    expect(r.mixer).toBe(30);
    expect(r.time).toBeCloseTo(60 * DT, 6); // the time owed is paid
    expect(r.rays).toBe(0);
    const full = await run(FULL_DETAIL);
    expect(full.mixer).toBe(60);
    expect(full.rays).toBeGreaterThan(0);
  });
});
