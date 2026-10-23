/**
 * Tap-to-save's gesture safety: a shot never registers as a save, and a save gesture never uses a
 * gun button (the owner: "so we don't just interrupt their gaming").
 */
import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { FIRE_BITS, FIRE_SETTLE_MS, FireLog, MULTI_MS, PAD_TAP_MS, PadTap, SAVE_GAP_MS, TAP_MAX_MS, TAP_SLOP_PX, TapTracker, decide, keySaves, middleClickSaves } from '../../src/ads/gesture';
import { DEFAULT_KEY_BINDINGS, type KeyBindings } from '../../src/input';
import { DEFAULT_PAD_SETTINGS } from '../../src/gamepad/settings';

describe('mouse and keyboard', () => {
  it('only the interact key and an unbound middle button save; no gun button ever does', () => {
    expect(keySaves('KeyE', DEFAULT_KEY_BINDINGS)).toBe(true);
    for (const [code, bits] of Object.entries(DEFAULT_KEY_BINDINGS.keys)) if (bits !== Btn.Interact) expect(keySaves(code, DEFAULT_KEY_BINDINGS), code).toBe(false);
    expect(middleClickSaves(1, DEFAULT_KEY_BINDINGS)).toBe(true);
    for (const b of [0, 2, 3, 4]) expect(middleClickSaves(b, DEFAULT_KEY_BINDINGS), `mouse ${b}`).toBe(false);
    // the left and right buttons are the gun's
    expect(DEFAULT_KEY_BINDINGS.mouse[0]! & FIRE_BITS).not.toBe(0);
    expect(DEFAULT_KEY_BINDINGS.mouse[2]! & FIRE_BITS).not.toBe(0);
  });

  it('follows rebinding: a key bound to fire never saves; middle-click steps aside once it is bound', () => {
    const rebound: KeyBindings = { ...DEFAULT_KEY_BINDINGS, keys: { ...DEFAULT_KEY_BINDINGS.keys, KeyE: Btn.Fire, KeyV: Btn.Interact }, mouse: { ...DEFAULT_KEY_BINDINGS.mouse, 1: Btn.Melee } };
    expect(keySaves('KeyE', rebound)).toBe(false);
    expect(keySaves('KeyV', rebound)).toBe(true);
    expect(middleClickSaves(1, rebound)).toBe(false);
    // a key that also fires (two actions on one key) is not "the interact key and nothing else"
    expect(keySaves('KeyE', { ...DEFAULT_KEY_BINDINGS, keys: { KeyE: Btn.Interact | Btn.Fire } })).toBe(false);
  });
});

describe('the fire guard (every device)', () => {
  it('a gesture during which a shot went out is dropped; one with no shot saves once it settles', () => {
    const fire = new FireLog();
    fire.note(0, 100);
    const p = { x: 1, y: 1, since: 100, at: 100 + FIRE_SETTLE_MS };
    expect(decide(p, 120, fire, -Infinity)).toBe('wait');
    expect(decide(p, 100 + FIRE_SETTLE_MS, fire, -Infinity)).toBe('save');
    // release-to-fire: the shot goes out in the sample after the lift
    fire.note(Btn.Fire, 150);
    expect(decide(p, 100 + FIRE_SETTLE_MS, fire, -Infinity)).toBe('drop');
    expect(fire.held).toBe(true);
    fire.note(Btn.Fire2, 160);
    expect(fire.held).toBe(true);
    fire.note(Btn.Jet | Btn.Interact, 170);
    expect(fire.held).toBe(false);
  });

  it('a shot before the gesture does not cancel it; saves are at least SAVE_GAP_MS apart', () => {
    const fire = new FireLog();
    fire.note(Btn.Fire, 50);
    fire.note(0, 60);
    const p = { x: 0, y: 0, since: 100, at: 100 };
    expect(decide(p, 100, fire, -Infinity)).toBe('save');
    expect(decide(p, 100, fire, 100 - SAVE_GAP_MS / 2)).toBe('drop');
  });
});

describe('touch', () => {
  it('a quick, still, one-finger tap off the controls counts', () => {
    const t = new TapTracker();
    t.down(1, 300, 200, 1000, true);
    t.move(1, 302, 201);
    expect(t.up(1, 302, 201, 1000 + TAP_MAX_MS - 10)).toEqual({ x: 300, y: 200, downAt: 1000, upAt: 1000 + TAP_MAX_MS - 10 });
  });

  it('not a hold, a drag (an aim), a tap on a control, or two fingers (the camera)', () => {
    const t = new TapTracker();
    t.down(1, 300, 200, 0, true);
    expect(t.up(1, 300, 200, TAP_MAX_MS + 1)).toBeNull(); // held
    t.down(2, 300, 200, 1000, true);
    t.move(2, 300 + TAP_SLOP_PX + 1, 200); // aimed
    t.move(2, 300, 200);
    expect(t.up(2, 300, 200, 1100)).toBeNull();
    t.down(3, 300, 200, 2000, false); // on a control
    expect(t.up(3, 300, 200, 2050)).toBeNull();
    // a two-finger tap (recentre) or pinch: neither finger saves
    t.down(4, 300, 200, 3000, true);
    t.down(5, 420, 200, 3000 + MULTI_MS - 50, true);
    expect(t.up(4, 300, 200, 3100)).toBeNull();
    expect(t.up(5, 420, 200, 3200)).toBeNull();
  });

  it('a thumb already resting on a stick does not stop the other thumb’s tap', () => {
    const t = new TapTracker();
    t.down(1, 100, 300, 0, true); // the move thumb, down for a while
    t.down(2, 700, 120, 2000, true);
    expect(t.up(2, 700, 120, 2100)).not.toBeNull();
  });
});

describe('controller', () => {
  it('a tap of the scoreboard button (View / Share): pressed and let go quickly', () => {
    expect(DEFAULT_PAD_SETTINGS.bindings.scoreboard).toEqual([8]);
    const pad = new PadTap();
    expect(pad.poll(true, 0)).toBeNull();
    expect(pad.poll(true, 100)).toBeNull();
    expect(pad.poll(false, 150)).toBe(0);
    expect(pad.poll(true, 1000)).toBeNull();
    expect(pad.poll(false, 1000 + PAD_TAP_MS + 1)).toBeNull(); // a hold: the scoreboard, not a save
    expect(pad.poll(false, 2000)).toBeNull();
  });

  it('the scoreboard button is no gun button in any default pad layout', () => {
    for (const [action, buttons] of Object.entries(DEFAULT_PAD_SETTINGS.bindings)) {
      if (action === 'scoreboard') continue;
      expect(buttons, action).not.toContain(8);
    }
  });
});
