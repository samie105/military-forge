import { describe, expect, it } from 'vitest';
import { BASE_HANDS, BayHistory, baseDrawing, cardAt, overlaps, trayAt, type BaySnapshot } from '../../src/touch/editor/model';

const snap = (x: number, preset: BaySnapshot['preset'] = 'classic'): BaySnapshot => ({
  layout: { placements: x < 0 ? {} : { grenade: { x, y: 0.8, size: 0.2, opacity: 1 } } },
  preset,
  handed: 'right',
  settings: { fire: 'auto', fireChosen: false, stickJet: true, tapFire: false, leftFire: true },
});

describe('the layout bay: undo and redo', () => {
  it('one step per finished change; a tap that moved nothing is no step', () => {
    const h = new BayHistory();
    h.record(snap(-1), snap(-1));
    expect(h.canUndo).toBe(false);
    h.record(snap(-1), snap(0.5));
    h.record(snap(0.5), snap(0.6));
    expect(h.undo(snap(0.6))).toEqual(snap(0.5));
    expect(h.undo(snap(0.5))).toEqual(snap(-1));
    expect(h.undo(snap(-1))).toBeNull();
    expect(h.redo(snap(-1))).toEqual(snap(0.5));
    expect(h.canRedo).toBe(true);
  });
  it('a new change after an undo drops the redo', () => {
    const h = new BayHistory();
    h.record(snap(-1), snap(0.5));
    h.undo(snap(0.5));
    h.record(snap(-1), snap(0.4));
    expect(h.canRedo).toBe(false);
  });
  it('a base swap is a step too', () => {
    const h = new BayHistory();
    h.record(snap(-1), snap(-1, 'claw'));
    expect(h.undo(snap(-1, 'claw'))?.preset).toBe('classic');
  });
});

describe('the layout bay: too close', () => {
  it('two controls that overlap both turn red; touching rings (a sliver) are fine', () => {
    const bad = overlaps([
      { id: 'grenade', x: 100, y: 100, r: 30 },
      { id: 'jet', x: 140, y: 100, r: 30 },
      { id: 'swap', x: 300, y: 100, r: 30 },
      { id: 'reload', x: 358, y: 100, r: 30 },
    ]);
    expect([...bad].sort()).toEqual(['grenade', 'jet']);
  });
});

describe("the layout bay: the picked control's card", () => {
  const box = { w: 700, h: 340 };
  const card = { w: 220, h: 140 };
  it('beside the control, on the side with room, never over it', () => {
    const right = cardAt({ x: 600, y: 250, r: 40 }, card, box, 56);
    expect(right.x + card.w).toBeLessThanOrEqual(600 - 40);
    const left = cardAt({ x: 100, y: 250, r: 40 }, card, box, 56);
    expect(left.x).toBeGreaterThanOrEqual(100 + 40);
  });
  it('kept under the top bar and inside the box', () => {
    const top = cardAt({ x: 600, y: 20, r: 24 }, card, box, 56);
    expect(top.y).toBeGreaterThanOrEqual(56);
    const bottom = cardAt({ x: 600, y: 330, r: 24 }, card, box, 56);
    expect(bottom.y + card.h).toBeLessThanOrEqual(box.h);
  });
  it('no room either side: above it, else below', () => {
    const narrow = { w: 300, h: 340 };
    const at = cardAt({ x: 150, y: 300, r: 40 }, card, narrow, 56);
    expect(at.y + card.h).toBeLessThanOrEqual(300 - 40);
  });
});

describe('the layout bay: the tray', () => {
  it('goes in the widest free stretch of the bottom, between the sticks', () => {
    const discs = [
      { id: 'move' as const, x: 96, y: 250, r: 66 },
      { id: 'aim' as const, x: 600, y: 250, r: 66 },
      { id: 'grenade' as const, x: 460, y: 290, r: 36 },
    ];
    const spot = trayAt(discs, { w: 700, h: 340 }, 200);
    expect(spot).not.toBeNull();
    expect(spot!.x).toBeGreaterThanOrEqual(96 + 66);
    expect(spot!.x + 200).toBeLessThanOrEqual(460 - 36);
  });
  it('no stretch wide enough: none', () => {
    expect(trayAt([{ id: 'move', x: 350, y: 300, r: 340 }], { w: 700, h: 340 }, 200)).toBeNull();
  });
});

describe('the layout bay: the base cards', () => {
  it('draw the real layouts, mirrored for the left hand', () => {
    const classic = baseDrawing('classic', 'right');
    const move = classic.find((d) => d.id === 'move')!;
    const aim = classic.find((d) => d.id === 'aim')!;
    expect(move.x).toBeLessThan(0.5);
    expect(aim.x).toBeGreaterThan(0.5);
    expect(baseDrawing('classic', 'left').find((d) => d.id === 'move')!.x).toBeCloseTo(1 - move.x);
    // One-thumb has no aim stick; Claw has FIRE and dash on top
    expect(baseDrawing('oneThumb', 'right').some((d) => d.id === 'aim')).toBe(false);
    expect(baseDrawing('claw', 'right').filter((d) => d.y < 0.5).map((d) => d.id)).toEqual(expect.arrayContaining(['jet', 'dash', 'fire', 'grenade']));
    expect(BASE_HANDS).toEqual({ classic: 2, claw: 4, oneThumb: 1 });
  });
});
