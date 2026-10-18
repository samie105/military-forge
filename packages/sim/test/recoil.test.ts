import { BREACHER, BUZZ, HAMMER, K47, WIDOW, defaultTuning as T, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, RECOIL_CROUCH_BRACE, RECOIL_MAX_RISE, RECOIL_MAX_VX_SHARE, type Game, type PlayerState } from '../src';
import { flatMap, hold, makeGame, placeOnGround } from './helpers';

/** A player standing at x = 30 on a long flat floor holding `weapon` (slot 0). */
function armed(weapon: number): { game: Game; p: PlayerState } {
  const { game, p } = makeGame(flatMap([], [], 120));
  game.setLoadout(p, [weapon, HAMMER.index]);
  placeOnGround(game, p, 30);
  hold(game, p, 0, 30); // equipped
  return { game, p };
}

/** A short hop, held until its top (vertical speed ≤ 0). */
function hopToTop(game: Game, p: PlayerState): void {
  hold(game, p, Btn.Jet, 12);
  while (p.vy > 0) hold(game, p, 0, 1);
}

const DOWN = -Math.PI / 2;

describe('recoil push (docs/02 §12)', () => {
  it('a Breacher fired straight down at the top of a hop is a ~2.5 m shotgun jump', () => {
    const { game, p } = armed(BREACHER.index);
    hopToTop(game, p);
    const y0 = p.y;
    const vy0 = p.vy;
    hold(game, p, Btn.Fire, 1, DOWN);
    // the kick, minus a tick of gravity
    expect(p.vy).toBeCloseTo(vy0 + BREACHER.recoilPushAir - T.gravity / 60, 1);
    let peak = y0;
    while (!p.grounded) {
      hold(game, p, 0, 1, DOWN);
      peak = Math.max(peak, p.y);
    }
    expect(peak - y0).toBeGreaterThan(2);
    expect(peak - y0).toBeLessThan(3);
  });

  it('shots fired down never push the rise past RECOIL_MAX_RISE: chained shots hover, they don’t rocket', () => {
    const { game, p } = armed(BREACHER.index);
    hold(game, p, Btn.Jet, 30); // rising at full jet speed
    expect(p.vy).toBeGreaterThan(5);
    hold(game, p, Btn.Jet | Btn.Fire, 1, DOWN);
    expect(p.vy).toBeLessThanOrEqual(RECOIL_MAX_RISE);
    // already faster than the cap (a blast launch): recoil leaves it alone
    p.vy = 14;
    hold(game, p, 0, 50, DOWN);
    p.vy = 14;
    hold(game, p, Btn.Fire, 1, DOWN);
    expect(p.vy).toBeCloseTo(14 - T.gravity / 60, 2);
  });

  it('in the air the push is along −aim: fired level, it knocks you back', () => {
    const { game, p } = armed(WIDOW.index);
    hopToTop(game, p);
    const vx0 = p.vx;
    hold(game, p, Btn.Fire, 1, 0);
    expect(p.vx).toBeCloseTo(vx0 - WIDOW.recoilPushAir, 2);
  });

  it('on the ground heavy guns slide you back (crouching braces); light guns don’t push at all', () => {
    const slide = (weapon: number, crouch: boolean) => {
      const { game, p } = armed(weapon);
      if (crouch) hold(game, p, Btn.Down, 10);
      const x0 = p.x;
      hold(game, p, Btn.Fire | (crouch ? Btn.Down : 0), 1, 0);
      const kick = p.vx;
      hold(game, p, crouch ? Btn.Down : 0, 90);
      return { kick, distance: x0 - p.x };
    };
    expect(slide(BREACHER.index, false).kick).toBe(-BREACHER.recoilPushGround);
    const widow = slide(WIDOW.index, false);
    expect(widow.kick).toBe(-WIDOW.recoilPushGround);
    expect(widow.distance).toBeGreaterThan(0.5); // the owner's "about 0.5–1 m"
    expect(widow.distance).toBeLessThan(1);
    const braced = slide(WIDOW.index, true);
    expect(braced.kick).toBe(-WIDOW.recoilPushGround * RECOIL_CROUCH_BRACE);
    expect(braced.distance).toBeLessThan(widow.distance / 2);
    for (const light of [HAMMER, BUZZ, K47]) expect(slide(light.index, false).kick, light.id).toBe(0);
  });

  it('light guns never push in the air; a K-47 spray drifts you back gently', () => {
    for (const light of [HAMMER, BUZZ]) {
      const { game, p } = armed(light.index);
      hopToTop(game, p);
      const vx0 = p.vx;
      hold(game, p, Btn.Fire, 1, 0);
      expect(p.vx, light.id).toBe(vx0);
    }
    const { game, p } = armed(K47.index);
    hold(game, p, Btn.Jet, 20);
    const x0 = p.x;
    hold(game, p, Btn.Jet | Btn.Fire, 60, 0);
    expect(x0 - p.x).toBeGreaterThan(0.5);
    expect(x0 - p.x).toBeLessThan(2.5);
  });

  it('recoil alone never reaches launchSpeedX (launches keep their speed, recoil does not add to it)', () => {
    const cap = T.launchSpeedX * RECOIL_MAX_VX_SHARE;
    const { game, p } = armed(BREACHER.index);
    hold(game, p, Btn.Jet | Btn.Left, 40, Math.PI); // flying left flat out
    let top = 0;
    for (let i = 0; i < 4; i++) {
      hold(game, p, Btn.Jet | Btn.Left | Btn.Fire, 1, 0); // fired right: kicked further left
      top = Math.max(top, Math.abs(p.vx));
      hold(game, p, Btn.Jet | Btn.Left, 45, 0);
    }
    expect(top).toBeCloseTo(cap, 1);
    expect(top).toBeLessThan(T.launchSpeedX);
    // a blast launch at 20 m/s keeps its speed through a shot that would add to it
    p.vx = -20;
    hold(game, p, Btn.Fire, 1, 0);
    expect(p.vx).toBeLessThan(-T.launchSpeedX);
    expect(p.vx).toBeGreaterThanOrEqual(-20);
  });

  it('a kick ends a dash, like any push (docs/02 §21: the push wins)', () => {
    const { game, p } = armed(WIDOW.index);
    hold(game, p, Btn.Dash | Btn.Right, 1, 0);
    expect(p.dashTicks).toBeGreaterThan(0);
    hold(game, p, Btn.Fire | Btn.Right, 1, 0);
    expect(p.dashTicks).toBe(0);
    expect(p.vx).toBeLessThan(T.walkMax); // the burst is capped on the way out, then the kick
  });

  it('every weapon has a sane push (none for melee, light guns none on the ground)', () => {
    for (const w of weapons) {
      expect(w.recoilPushAir, w.id).toBeGreaterThanOrEqual(0);
      expect(w.recoilPushGround, w.id).toBeGreaterThanOrEqual(0);
      expect(w.recoilPushAir, w.id).toBeLessThanOrEqual(T.knockbackCap);
      if (w.fireMode === 'melee' || w.class === 'sidearm' || w.class === 'smg') expect([w.recoilPushAir, w.recoilPushGround], w.id).toEqual([0, 0]);
    }
  });
});
