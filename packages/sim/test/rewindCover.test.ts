/**
 * The cover rule (rewind.ts REWIND_COVER_TICKS; QA, 23 Oct 2026): a long rewind doesn't count against
 * a target that is behind solid cover now, so nobody is shot through a wall they reached on their
 * own screen. A short rewind, or a target still partly in the open, is rewound as usual.
 */
import { WIDOW, defaultTuning as T } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import { Btn, Game, REWIND_COVER_TICKS, createInput, type HitPose, type Input, type PlayerState, type SimEvent } from '../src';
import { flatMap, placeOnGround, rect } from './helpers';

/** A at x = 5 shoots right; B is at x = 14 now, past a pillar at x = 10–11 of this height. */
function setup(pillarHeight: number) {
  const game = new Game({ map: flatMap([rect(10, 0, 11, pillarHeight)]), seed: 3 });
  const a = game.addPlayer('a');
  const b = game.addPlayer('b');
  game.setLoadout(a, [WIDOW.index, WIDOW.index]);
  placeOnGround(game, a, 5);
  placeOnGround(game, b, 14);
  return { game, a, b };
}

/** A TargetRewind that shows B where A saw it: at x = 8, in the open, `ticksBack` ago. */
function sawBAt8(b: PlayerState, ticksBack: number) {
  const covered: number[] = [];
  return {
    covered,
    rewind: {
      pose(target: PlayerState, _shooter: PlayerState, out: HitPose): boolean {
        if (target !== b) return false;
        Object.assign(out, { x: 8, y: 0, crouched: false, alive: true, facing: -1, shield: false, shieldBack: false, ticksBack });
        return true;
      },
      covered(target: PlayerState) {
        covered.push(target.id);
      },
    },
  };
}

/** One shot by A at (8, torso), as its screen drew B: the shot event's hit kind (1 world, 2 player). */
function shootAt8(game: Game, a: PlayerState): number {
  const sx = a.x + T.shoulderForward;
  const sy = a.y + T.shoulderStand;
  const inputs: Input[] = [];
  inputs[a.id] = { ...createInput(), buttons: Btn.Fire, aim: angleToU16(Math.atan2(1.1 - sy, 8 - sx)) };
  game.step(inputs);
  const shot = game.events.find((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot');
  return shot!.hit;
}

describe('the cover rule', () => {
  it('a long rewind against a target behind cover now: tested where it is, so the wall takes the shot', () => {
    const { game, a, b } = setup(3);
    const r = sawBAt8(b, REWIND_COVER_TICKS + 3);
    game.rewind = r.rewind;
    expect(shootAt8(game, a)).toBe(1);
    expect(b.hp).toBe(T.healthMax);
    expect(r.covered).toEqual([b.id]);
  });

  it('a short rewind still lands where the shooter saw the target', () => {
    const { game, a, b } = setup(3);
    const r = sawBAt8(b, REWIND_COVER_TICKS);
    game.rewind = r.rewind;
    expect(shootAt8(game, a)).toBe(2);
    expect(b.hp).toBeLessThan(T.healthMax);
    expect(r.covered).toEqual([]);
  });

  it('a target still partly in the open (its head over a low wall) is rewound as usual', () => {
    const { game, a, b } = setup(1);
    const r = sawBAt8(b, REWIND_COVER_TICKS + 20);
    game.rewind = r.rewind;
    expect(shootAt8(game, a)).toBe(2);
    expect(b.hp).toBeLessThan(T.healthMax);
    expect(r.covered).toEqual([]);
  });
});
