import { BUZZ, HAMMER, K47, MACHETE, RIOT_SHIELD, defaultTuning as T } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, SHIELD_RAISE_TICKS, giveShield, heldSpeedMul, shieldInFront, shieldRaised, type Game, type PlayerState } from '../src';
import { flatMap, hold, makeGame, placeOnGround } from './helpers';

/** A player on flat ground at x = 5 holding `loadout`, carrying a fresh shield. */
function shielded(loadout: [number, number] = [HAMMER.index, BUZZ.index]): { game: Game; p: PlayerState } {
  const { game, p } = makeGame(flatMap());
  game.setLoadout(p, loadout);
  placeOnGround(game, p, 5);
  giveShield(p, RIOT_SHIELD.hp);
  return { game, p };
}

describe('riot shield: carry modes', () => {
  it('comes up in front with a one-handed weapon, blocking once it is all the way up', () => {
    const { game, p } = shielded();
    hold(game, p, 0, SHIELD_RAISE_TICKS - 1);
    expect(shieldInFront(p)).toBe(true);
    expect(shieldRaised(p)).toBe(false);
    hold(game, p, 0, 1);
    expect(shieldRaised(p)).toBe(true);
    expect(SHIELD_RAISE_TICKS).toBe(Math.round(RIOT_SHIELD.raiseTime * 60));
  });

  it('the shield key slings it on the back and raises it again', () => {
    const { game, p } = shielded();
    hold(game, p, 0, 30);
    hold(game, p, Btn.Shield, 1);
    expect(shieldInFront(p)).toBe(false);
    expect(p.shieldStowed).toBe(true);
    hold(game, p, Btn.Shield, 30); // held, not pressed again: stays slung
    expect(shieldInFront(p)).toBe(false);
    hold(game, p, 0, 1);
    hold(game, p, Btn.Shield, 1);
    expect(shieldInFront(p)).toBe(true);
    hold(game, p, 0, SHIELD_RAISE_TICKS);
    expect(shieldRaised(p)).toBe(true);
  });

  it('a two-handed weapon slings it; back to a one-handed weapon, it comes up again', () => {
    const { game, p } = shielded([HAMMER.index, K47.index]);
    hold(game, p, 0, 30);
    expect(shieldRaised(p)).toBe(true);
    hold(game, p, Btn.Swap, 1);
    hold(game, p, 0, 1);
    expect(p.active).toBe(1);
    expect(shieldInFront(p)).toBe(false);
    hold(game, p, 0, 60);
    expect(shieldInFront(p)).toBe(false);
    hold(game, p, Btn.Swap, 1);
    hold(game, p, 0, SHIELD_RAISE_TICKS + 1);
    expect(p.active).toBe(0);
    expect(shieldRaised(p)).toBe(true);
  });

  it('with a two-handed weapon in hand the key chooses whether it comes up with the next one-handed weapon', () => {
    const { game, p } = shielded([K47.index, HAMMER.index]);
    hold(game, p, 0, 30);
    expect(shieldInFront(p)).toBe(false);
    hold(game, p, Btn.Shield, 1); // keep it on the back
    hold(game, p, 0, 1);
    hold(game, p, Btn.Swap, 1);
    hold(game, p, 0, 30);
    expect(p.active).toBe(1);
    expect(shieldInFront(p)).toBe(false);
    hold(game, p, Btn.Shield, 1); // now with the Hammer: up it comes
    hold(game, p, 0, SHIELD_RAISE_TICKS);
    expect(shieldRaised(p)).toBe(true);
  });

  it('no dual with the shield up: going dual slings it; the shield key ends dual and raises it', () => {
    const { game, p } = shielded();
    hold(game, p, 0, 30);
    hold(game, p, Btn.Dual, 1);
    hold(game, p, 0, 1);
    expect(p.dual).toBe(true);
    expect(shieldInFront(p)).toBe(false);
    hold(game, p, 0, 40);
    hold(game, p, Btn.Shield, 1);
    expect(p.dual).toBe(false);
    expect(p.swapTicks).toBeGreaterThan(0);
    hold(game, p, 0, SHIELD_RAISE_TICKS);
    expect(shieldRaised(p)).toBe(true);
    // and dual again: slung, then back up when dual ends
    hold(game, p, 0, 30);
    hold(game, p, Btn.Dual, 1);
    hold(game, p, 0, 30);
    hold(game, p, Btn.Dual, 1);
    hold(game, p, 0, SHIELD_RAISE_TICKS + 1);
    expect(p.dual).toBe(false);
    expect(shieldRaised(p)).toBe(true);
  });

  it('a Machete goes with a shield (one-handed)', () => {
    const { game, p } = shielded([MACHETE.index, K47.index]);
    hold(game, p, 0, 30);
    expect(shieldRaised(p)).toBe(true);
  });

  it('weight: up it slows you to ×0.75, slung it weighs nothing', () => {
    const { game, p } = shielded();
    hold(game, p, 0, 30);
    expect(heldSpeedMul(p)).toBe(RIOT_SHIELD.moveSpeedMul);
    hold(game, p, Btn.Right, 60);
    expect(p.vx).toBeCloseTo(T.walkMax * RIOT_SHIELD.moveSpeedMul, 3);
    hold(game, p, Btn.Right | Btn.Down, 60);
    expect(p.vx).toBeCloseTo(T.crouchMax * RIOT_SHIELD.moveSpeedMul, 3);
    hold(game, p, Btn.Right | Btn.Shield, 1);
    hold(game, p, Btn.Right, 60);
    expect(heldSpeedMul(p)).toBe(1);
    expect(p.vx).toBe(T.walkMax);
  });

  it('respawning clears it', () => {
    const { game, p } = shielded();
    hold(game, p, 0, 30);
    game.respawn(p);
    expect([p.shieldHp, p.shieldStowed, p.shieldTicks]).toEqual([0, false, 0]);
  });
});

describe('riot shield and the dash (docs/02 §21: dashBlocked)', () => {
  it('no dash while it is up or coming up, and the refused press costs nothing; slung, you dash', () => {
    const { game, p } = shielded();
    hold(game, p, 0, 5);
    expect(shieldInFront(p) && !shieldRaised(p)).toBe(true); // coming up
    hold(game, p, Btn.Dash | Btn.Right, 1);
    expect([p.dashTicks, p.dashCooldown]).toEqual([0, 0]);
    hold(game, p, 0, SHIELD_RAISE_TICKS);
    expect(shieldRaised(p)).toBe(true);
    const fuel = p.fuel;
    hold(game, p, Btn.Dash | Btn.Right, 1);
    expect([p.dashTicks, p.dashCooldown, p.fuel]).toEqual([0, 0, fuel]);
    hold(game, p, 0, 1);
    hold(game, p, Btn.Shield, 1); // sling it
    hold(game, p, 0, 1);
    expect(shieldInFront(p)).toBe(false);
    hold(game, p, Btn.Dash | Btn.Right, 1);
    expect(p.dashTicks).toBeGreaterThan(0);
  });

  it('a two-handed weapon (shield slung) dashes too', () => {
    const { game, p } = shielded([K47.index, HAMMER.index]);
    hold(game, p, 0, 30);
    expect(shieldInFront(p)).toBe(false);
    hold(game, p, Btn.Dash | Btn.Left, 1);
    expect(p.dashTicks).toBeGreaterThan(0);
  });
});
