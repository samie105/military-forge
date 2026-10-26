/**
 * Pushing the move stick up flies, wherever the thumb lands on it (the owner, 26 Oct, on an Android
 * phone after fixed sticks became the default: "I can't fly", "I'm only flying if I press JET"). A thumb
 * comes onto the dial from below and lands low on it; read from the drawn centre alone, a fixed stick
 * then needed ~90 px of climb before it jetted. This walks a thumb the way controller.ts reads it (a
 * fixed stick: from the drawn centre within FIXED_GRAB radii, plus the drag from the landing; further
 * out, and Follow thumb: from the landing, the origin following past 1.2 radii) through every layout's
 * "Push up to fly" and both stick modes.
 */
import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { createTouchState, touchButtons, updateMove } from '../../src/touch/mapping';
import { PRESET_IDS, PRESET_SETTINGS, STICK_MODES, type StickMode } from '../../src/touch/settings';
import { FIXED_GRAB, MOVE_FIXED, MOVE_STICK, followOrigin, shapeStick } from '../../src/touch/stick';

/** the phone's move dial: 22 mm at ~6 px/mm (layout.ts), drawn at the centre (0, 0) */
const R = 66;
type P = { x: number; y: number };

/** A thumb landing at `land` (px from the drawn centre, y down) and dragged along `path`: the buttons each sample, as controller.ts reads them. */
function stroke(sticks: StickMode, stickJet: boolean, land: P, path: P[]): number[] {
  const s = createTouchState();
  const centred = sticks === 'fixed' && Math.hypot(land.x, land.y) <= FIXED_GRAB * R;
  let o = centred ? { x: 0, y: 0 } : { ...land };
  let drag = { ...land };
  const out: number[] = [];
  for (const at of [land, ...path]) {
    if (!centred) o = followOrigin(o.x, o.y, at.x, at.y, R);
    shapeStick(at.x - o.x, at.y - o.y, R, centred ? MOVE_FIXED : MOVE_STICK, s.move);
    s.moveActive = true;
    drag = followOrigin(drag.x, drag.y, at.x, at.y, R);
    s.moveDragOn = centred;
    if (centred) shapeStick(at.x - drag.x, at.y - drag.y, R, MOVE_STICK, s.moveDrag);
    updateMove(s, stickJet);
    out.push(touchButtons(s, 'auto'));
  }
  return out;
}

/** a push straight up of `px`, in 5 px steps (a phone's pointer moves) */
const up = (land: P, px: number): P[] => Array.from({ length: Math.ceil(px / 5) }, (_, i) => ({ x: land.x, y: land.y - Math.min(px, (i + 1) * 5) }));

/** landings on and around the dial, every 11 px out to 1.9 radii (inside and outside the fixed grab) */
const LANDINGS: P[] = [];
for (let x = -1.9 * R; x <= 1.9 * R; x += 11) for (let y = -1.9 * R; y <= 1.9 * R; y += 11) if (Math.hypot(x, y) <= 1.9 * R) LANDINGS.push({ x, y });

describe('pushing the move stick up flies, wherever the thumb lands (the owner, 26 Oct)', () => {
  for (const sticks of STICK_MODES) {
    for (const preset of PRESET_IDS) {
      const stickJet = PRESET_SETTINGS[preset].stickJet !== false;
      it(`${sticks} sticks, ${preset}: a 31 px push up from any landing ${stickJet ? 'jets' : 'never jets (JET is a button)'}`, () => {
        const missed = LANDINGS.filter((land) => {
          const bits = stroke(sticks, stickJet, land, up(land, 31));
          return !!(bits.at(-1)! & Btn.Jet) !== stickJet;
        });
        expect(missed).toEqual([]);
      });
    }
  }

  it('a fixed stick: a thumb landing low on the dial, then pushing up 31 px, jets (before: it read "down" and crouched)', () => {
    for (const land of [{ x: 0, y: 35 }, { x: -15, y: 15 }, { x: 15, y: 20 }, { x: 0, y: 60 }, { x: 0, y: 1.5 * R }]) {
      const bits = stroke('fixed', true, land, up(land, 31));
      expect(bits.at(-1)! & Btn.Jet).toBe(Btn.Jet);
      expect(bits.at(-1)! & Btn.Down).toBe(0);
    }
  });

  it('a fixed stick still reads the landing as a push: low on the dial crouches, left runs left, high jets at once', () => {
    expect(stroke('fixed', true, { x: 0, y: 50 }, [])[0]! & Btn.Down).toBe(Btn.Down);
    expect(stroke('fixed', true, { x: -40, y: 0 }, [])[0]).toBe(Btn.Left);
    expect(stroke('fixed', true, { x: 0, y: -40 }, [])[0]! & Btn.Jet).toBe(Btn.Jet);
  });

  it("a fixed stick: a thumb that lands low and runs sideways doesn't jet; a small nudge up doesn't either", () => {
    const land = { x: 0, y: 30 };
    const side = Array.from({ length: 10 }, (_, i) => ({ x: (i + 1) * 6, y: 30 - (i + 1) * 1.5 }));
    expect(stroke('fixed', true, land, side).some((b) => b & Btn.Jet)).toBe(false);
    expect(stroke('fixed', true, land, up(land, 20)).some((b) => b & Btn.Jet)).toBe(false);
  });

  it('let go, nothing stays held', () => {
    const s = createTouchState();
    s.moveDragOn = true;
    Object.assign(s.moveDrag, { x: 0, y: 1, mag: 1 });
    expect(updateMove(s)).toBe(0);
  });
});
