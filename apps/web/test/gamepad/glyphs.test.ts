/**
 * Glyphs and the switch between devices (gamepad/glyphs.ts, device.ts, prompts.ts): PlayStation
 * shapes vs Xbox letters, prompts that follow the last device used, rumble from events.
 */
import { describe, expect, it } from 'vitest';
import { defaultBindings } from '../../src/shell/controls';
import { tipsRows } from '../../src/shell/screens/Tips';
import { capText } from '../../src/ui/icons';
import { currentDevice, currentPadFamily, nextDevice, noteKeys, notePad, noteTouch, onInputDevice, promptFamily, setGlyphSetting, type InputDevice } from '../../src/gamepad/device';
import { isPadCode, padButtonOf, padGlyphSvg, padLabel, padSpoken } from '../../src/gamepad/glyphs';
import { padAimCode, padShownBindings } from '../../src/gamepad/prompts';
import { RUMBLE, rumbleFor, scaleRumble } from '../../src/gamepad/rumble';
import { DEFAULT_PAD_SETTINGS } from '../../src/gamepad/settings';
import { B } from '../../src/gamepad/standard';

describe('glyphs', () => {
  it('PlayStation draws shapes, Xbox letters, for the same positions', () => {
    expect([0, 1, 2, 3].map((b) => padLabel(`Pad${b}`, 'playstation'))).toEqual(['✕', '○', '□', '△']);
    expect([0, 1, 2, 3].map((b) => padLabel(`Pad${b}`, 'xbox'))).toEqual(['A', 'B', 'X', 'Y']);
    // Nintendo prints its letters the other way round
    expect([0, 1, 2, 3].map((b) => padLabel(`Pad${b}`, 'nintendo'))).toEqual(['B', 'A', 'Y', 'X']);
  });

  it('shoulders, triggers, centre buttons and the D-pad', () => {
    expect(padLabel('Pad7', 'playstation')).toBe('R2');
    expect(padLabel('Pad7', 'xbox')).toBe('RT');
    expect(padLabel('Pad4', 'xbox')).toBe('LB');
    expect(padLabel('Pad11', 'playstation')).toBe('R3');
    expect(padLabel('Pad9', 'playstation')).toBe('Options');
    expect(padLabel('Pad9', 'xbox')).toBe('Menu');
    expect(padLabel('Pad8', 'playstation', { dualSense: true })).toBe('Create');
    expect(padLabel('Pad8', 'playstation')).toBe('Share');
    expect(padLabel('Pad8', 'xbox')).toBe('View');
    expect(padLabel('Pad17', 'playstation')).toBe('Touchpad');
    expect(padLabel('Pad15', 'xbox')).toBe('D-pad →');
    expect(padLabel('Pad15', 'xbox', { short: true })).toBe('D→');
    expect(padLabel('PadLSUp', 'xbox')).toBe('L stick ↑');
  });

  it('a generic pad shows Xbox letters', () => {
    expect(padLabel('Pad3', 'generic')).toBe('Y');
  });

  it('screen readers hear the shape’s name', () => {
    expect(padSpoken('Pad3', 'playstation')).toBe('Triangle button');
    expect(padSpoken('Pad0', 'xbox')).toBe('A button');
  });

  it('pad codes are told apart from keys and mouse buttons', () => {
    expect(isPadCode('Pad3')).toBe(true);
    expect(isPadCode('PadLS')).toBe(true);
    expect(isPadCode('KeyP')).toBe(false);
    expect(isPadCode('Mouse0')).toBe(false);
    expect(isPadCode('Paddle')).toBe(false);
    expect(padButtonOf('Pad12')).toBe(12);
    expect(padButtonOf('PadRS')).toBe(-1);
  });

  it('every button and stick has a drawing (original outlines: no brand colours)', () => {
    for (const fam of ['playstation', 'xbox', 'nintendo'] as const) {
      for (let b = 0; b <= 17; b++) {
        const svg = padGlyphSvg(`Pad${b}`, fam);
        expect(svg).toMatch(/^<svg /);
        expect(svg).toContain('currentColor');
        expect(svg).not.toMatch(/#[0-9a-f]{3,6}/i);
      }
      for (const s of ['PadLS', 'PadRS', 'PadLSUp', 'PadLSDown']) expect(padGlyphSvg(s, fam)).toMatch(/^<svg /);
    }
    expect(padGlyphSvg('KeyE', 'xbox')).toBe('');
  });
});

describe('switching devices', () => {
  const keys: InputDevice = { kind: 'keys', pad: null, dualSense: false };

  it('a pad press switches to the pad (its family); keys or a finger switch back; the pad is remembered', () => {
    const pad = nextDevice(keys, 'pad', { family: 'playstation', dualSense: true });
    expect(pad).toEqual({ kind: 'pad', pad: 'playstation', dualSense: true });
    const back = nextDevice(pad, 'keys');
    expect(back.kind).toBe('keys');
    expect(back.pad).toBe('playstation');
    expect(nextDevice(back, 'touch').kind).toBe('touch');
  });

  it('nothing changes when the same device keeps going (no re-renders)', () => {
    expect(nextDevice(keys, 'keys')).toBe(keys);
    const pad = nextDevice(keys, 'pad', { family: 'xbox', dualSense: false });
    expect(nextDevice(pad, 'pad', { family: 'xbox', dualSense: false })).toBe(pad);
  });

  it('the glyph setting overrides the pad’s own family', () => {
    const ps: InputDevice = { kind: 'pad', pad: 'playstation', dualSense: false };
    expect(promptFamily(ps, 'auto')).toBe('playstation');
    expect(promptFamily(ps, 'xbox')).toBe('xbox');
    expect(promptFamily({ ...ps, pad: 'generic' }, 'auto')).toBe('xbox');
    expect(promptFamily(keys, 'auto')).toBe('xbox');
  });

  it('the HUD’s keycaps follow: "Press △ to take" with a DualSense, "Y" with an Xbox pad', () => {
    const seen: string[] = [];
    const off = onInputDevice((d) => seen.push(d.kind));
    setGlyphSetting('auto');
    notePad('playstation', true);
    expect(currentDevice().kind).toBe('pad');
    expect(capText('Pad3')).toBe('△');
    expect(capText('Pad8')).toBe('Create');
    notePad('xbox');
    expect(currentPadFamily()).toBe('xbox');
    expect(capText('Pad3')).toBe('Y');
    setGlyphSetting('playstation');
    expect(capText('Pad3')).toBe('△');
    setGlyphSetting('auto');
    noteKeys();
    expect(currentDevice().kind).toBe('keys');
    expect(capText('KeyE')).toBe('E');
    noteTouch();
    expect(currentDevice().kind).toBe('touch');
    off();
    expect(seen).toEqual(['pad', 'pad', 'pad', 'pad', 'keys', 'touch']);
  });
});

describe('prompts in the pad’s buttons', () => {
  it('the controls card lists sticks and bound buttons', () => {
    const b = padShownBindings(DEFAULT_PAD_SETTINGS);
    const rows = Object.fromEntries(tipsRows(b));
    expect(rows['Move']).toEqual(['PadLS']);
    expect(rows['Jet (hold)']).toEqual(['PadLSUp', 'Pad0']);
    expect(rows['Fire']).toEqual([`Pad${B.R2}`]);
    expect(rows['Take a gun']).toEqual([`Pad${B.North}`]);
    expect(rows['Scoreboard (hold)']).toEqual([`Pad${B.Select}`]);
    expect(padAimCode(DEFAULT_PAD_SETTINGS)).toBe('PadRS');
  });

  it('swapped sticks and no stick jet show up in the prompts', () => {
    const b = padShownBindings({ ...DEFAULT_PAD_SETTINGS, swapSticks: true, stickJet: false });
    expect(b.left).toEqual(['PadRS']);
    expect(b.jet).toEqual(['Pad0']);
    expect(padAimCode({ ...DEFAULT_PAD_SETTINGS, swapSticks: true })).toBe('PadLS');
  });

  it('every keyboard action has an entry (the shape the prompts take)', () => {
    expect(Object.keys(padShownBindings(DEFAULT_PAD_SETTINGS)).sort()).toEqual(Object.keys(defaultBindings()).sort());
  });
});

describe('rumble', () => {
  it('the local player’s own shot, hit, death and dash; nobody else’s', () => {
    expect(rumbleFor([{ type: 'shot', shooter: 1, weapon: 0, ox: 0, oy: 0, ex: 1, ey: 0, hit: 0, target: -1, zone: 0 }], 1, null)?.kind).toBe('shot');
    expect(rumbleFor([{ type: 'shot', shooter: 2, weapon: 0, ox: 0, oy: 0, ex: 1, ey: 0, hit: 0, target: -1, zone: 0 }], 1, null)).toBeNull();
    const hit = rumbleFor([{ type: 'hit', attacker: 2, target: 1, damage: 50, zone: 0, source: 0 }], 1, null)!;
    expect(hit.kind).toBe('hit');
    expect(hit.strong).toBeGreaterThan(RUMBLE.shot.strong);
    expect(rumbleFor([{ type: 'death', victim: 1, killer: 2, source: 0 }], 1, null)?.kind).toBe('death');
    expect(rumbleFor([{ type: 'dash', player: 1, x: 0, y: 0, dir: 0 }], 1, null)?.kind).toBe('dash');
  });

  it('a blast is felt by how near it went off', () => {
    const near = rumbleFor([{ type: 'explosion', x: 1, y: 0, radius: 4, owner: 2 }], 1, { x: 0, y: 0 })!;
    const far = rumbleFor([{ type: 'explosion', x: 8, y: 0, radius: 4, owner: 2 }], 1, { x: 0, y: 0 })!;
    expect(near.strong).toBeGreaterThan(far.strong);
    expect(rumbleFor([{ type: 'explosion', x: 50, y: 0, radius: 4, owner: 2 }], 1, { x: 0, y: 0 })).toBeNull();
  });

  it('the strongest of a tick plays, scaled by the setting; 0 is off', () => {
    const r = rumbleFor(
      [
        { type: 'shot', shooter: 1, weapon: 0, ox: 0, oy: 0, ex: 1, ey: 0, hit: 0, target: -1, zone: 0 },
        { type: 'death', victim: 1, killer: 2, source: 0 },
      ],
      1,
      null,
    );
    expect(r?.kind).toBe('death');
    expect(scaleRumble(r, 0.5)!.strong).toBeCloseTo(RUMBLE.death.strong / 2);
    expect(scaleRumble(r, 0)).toBeNull();
  });
});
