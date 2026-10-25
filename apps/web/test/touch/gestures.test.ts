/** Touch controls v3 (touch-controls-v3.md): the gestures, the hints and the drill, pure. */
import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { GESTURE, beltAfter, beltOf, beltSteps, cyclePresses, dashButtons, isQuickSwipe, nearestPick, pinchSteps, radialAngles, radialPick, radialPickOnPage, radialSpots, swipeAxis } from '../../src/touch/gestures';
import { DEFAULT_TOUCH_SETTINGS, sanitizeSettings } from '../../src/touch/settings';
import { DRILL, Drill, FIRE_HOW, HINTS, drillControl, drillHow, loadSeen, nextHint, saveSeen } from '../../src/touch/teach';

describe('swipes on a button', () => {
  it('a quick swipe: far enough, soon enough; a slow drag or a twitch is not one', () => {
    expect(isQuickSwipe(0, -30, 120)).toBe(true);
    expect(isQuickSwipe(0, -30, GESTURE.swipeMs + 50)).toBe(false);
    expect(isQuickSwipe(5, -8, 60)).toBe(false);
    expect(swipeAxis(3, -30)).toBe('up');
    expect(swipeAxis(-40, 10)).toBe('left');
  });

  it('a dash swipe goes its way, 8 ways (the page\'s y grows down; the sim\'s up is Jet)', () => {
    expect(dashButtons(40, 0)).toBe(Btn.Right);
    expect(dashButtons(-40, 0)).toBe(Btn.Left);
    expect(dashButtons(0, -40)).toBe(Btn.Jet);
    expect(dashButtons(0, 40)).toBe(Btn.Down);
    expect(dashButtons(30, -30)).toBe(Btn.Right | Btn.Jet);
    expect(dashButtons(-30, 30)).toBe(Btn.Left | Btn.Down);
    expect(dashButtons(0, 0)).toBe(0);
  });
});

describe('the grenade belt', () => {
  it('a swipe up steps to the next type, down to the previous; a longer scrub steps more', () => {
    expect(beltSteps(-10)).toBe(0);
    expect(beltSteps(-GESTURE.swipePx)).toBe(1);
    expect(beltSteps(-(GESTURE.swipePx + GESTURE.stepPx))).toBe(2);
    expect(beltSteps(GESTURE.swipePx + 1)).toBe(-1);
  });

  it('the sim only cycles forward: back one on a belt of three is two presses; one type: none', () => {
    expect(cyclePresses(1, 3)).toBe(1);
    expect(cyclePresses(-1, 3)).toBe(2);
    expect(cyclePresses(4, 3)).toBe(1);
    expect(cyclePresses(1, 1)).toBe(0);
    expect(cyclePresses(0, 3)).toBe(0);
  });

  it('the belt is the types carried in cycle order; the fan previews where a scrub lands', () => {
    const b = beltOf([3, 0, 2, 1], 2);
    expect(b).toEqual({ types: [0, 2, 3], at: 1 });
    expect(beltAfter(b.types, b.at, 1)).toBe(3);
    expect(beltAfter(b.types, b.at, -1)).toBe(0);
    expect(beltAfter(b.types, b.at, 2)).toBe(0);
    expect(beltAfter([], 0, 1)).toBe(-1);
  });
});

describe('the gun pill\'s radial', () => {
  it('opens away from the screen edge the pill is at (top right: down and in)', () => {
    const a = radialAngles(560, 30, 724, 344);
    for (const c of a) {
      expect(Math.sin(c.angle)).toBeGreaterThan(-0.05); // never up, off the screen
      expect(Math.cos(c.angle)).toBeLessThan(0.05); // never right, into the edge
    }
    const low = radialAngles(100, 300, 724, 344);
    for (const c of low) expect(Math.sin(c.angle)).toBeLessThan(0.05);
  });

  it('its choices sit clear of the pill (a wide pill: further out sideways), and a finger picks the nearest', () => {
    const c = { x: 560, y: 40 };
    const a = radialAngles(c.x, c.y, 724, 344);
    const spots = radialSpots(c, a, 90, 26);
    // straight down, down-left, left: each outside the 180 × 52 pill
    expect(spots[0]!.y).toBeGreaterThan(c.y + 26);
    expect(spots[2]!.x).toBeLessThan(c.x - 90);
    expect(nearestPick({ x: c.x + 5, y: c.y + 10 }, c, spots, 26)).toBe(-1);
    for (let i = 0; i < spots.length; i++) expect(nearestPick(spots[i]!, c, spots, 26)).toBe(i);
  });

  it('the finger picks the nearest choice; the dead centre picks nothing', () => {
    const a = radialAngles(560, 30, 724, 344);
    expect(radialPick(3, 4, a)).toBe(-1);
    for (let i = 0; i < a.length; i++) expect(radialPick(Math.cos(a[i]!.angle) * 70, Math.sin(a[i]!.angle) * 70, a)).toBe(i);
  });
});

describe('the camera', () => {
  it('a pinch steps a level per 1.3× of finger spread: apart = closer in, together = wider', () => {
    expect(pinchSteps(100, 110)).toBe(0);
    expect(pinchSteps(100, 135)).toBe(1);
    expect(pinchSteps(100, 180)).toBe(2);
    expect(pinchSteps(100, 70)).toBe(-1);
    expect(pinchSteps(0, 50)).toBe(0);
  });
});

describe('settings', () => {
  it('v3\'s defaults: gestures, haptics, pinch and look-ahead on; Auto fire (the spec\'s default); full shake', () => {
    expect(DEFAULT_TOUCH_SETTINGS).toMatchObject({ gestures: true, fire: 'auto', fireChosen: false, precisionRelease: true, leftFire: false, haptics: true, lookAhead: true, pinchZoom: true, shake: 1, view: 0.8, viewAuto: true });
    expect(sanitizeSettings({ view: 0.2 }).view).toBe(0.7);
    expect(sanitizeSettings({ view: 2 }).view).toBe(1);
    expect(sanitizeSettings({ gestures: false, shake: 3 })).toMatchObject({ gestures: false, shake: 1 });
    // the old names: 'hold' is Pull; 'hold' with the old auto-fire switch on is Auto
    expect(sanitizeSettings({ fire: 'hold' }).fire).toBe('pull');
    expect(sanitizeSettings({ fire: 'hold', autoFire: true }).fire).toBe('auto');
    expect(sanitizeSettings({ fire: 'release' }).fire).toBe('release');
    expect(sanitizeSettings({ fire: 'button', leftFire: true, fireChosen: true })).toMatchObject({ fire: 'button', leftFire: true, fireChosen: true });
    expect(sanitizeSettings({ fire: 'spray' }).fire).toBe('auto');
    expect(sanitizeSettings({ shake: -1, haptics: 'yes' })).toMatchObject({ shake: 0, haptics: true });
  });
});

describe('first-time hints', () => {
  const base = { alive: true, grenadeTypes: 1, guns: 1, nearCrate: false, shield: false };
  it('each shows when it becomes possible, once', () => {
    expect(nextHint(base, new Set())?.id).toBe('dash-swipe');
    const seen = new Set(['dash-swipe']);
    expect(nextHint(base, seen)).toBeNull();
    expect(nextHint({ ...base, grenadeTypes: 2 }, seen)?.id).toBe('grenade-types');
    expect(nextHint({ ...base, guns: 2 }, seen)?.id).toBe('swap-radial');
    expect(nextHint({ ...base, nearCrate: true }, seen)?.id).toBe('take');
    expect(nextHint({ ...base, shield: true }, seen)?.id).toBe('shield-hold');
    expect(nextHint({ ...base, alive: false }, new Set())).toBeNull();
    expect(HINTS.every((h) => h.text.length <= 30)).toBe(true);
  });

  it('remembered on the phone', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    saveSeen(store, new Set(['take', 'dash-swipe']));
    expect([...loadSeen(store)].sort()).toEqual(['dash-swipe', 'take']);
    expect(loadSeen(null).size).toBe(0);
  });
});

describe('the drill', () => {
  it('a goal ticks off when the player does it, then the next; the wrong action does nothing', () => {
    const d = new Drill();
    expect(d.step?.id).toBe('move');
    expect(d.act('fire')).toBe(false);
    expect(d.act('move')).toBe(true);
    expect(d.step?.id).toBe('jet');
    expect(d.justTicked).toBe('move');
  });

  it('every step can be skipped; the shield and zoom steps skip themselves when they cannot be done; it finishes', () => {
    const d = new Drill();
    let guard = 0;
    while (!d.finished && guard++ < 50) {
      if (d.step?.id === 'radial') d.act('radial', { shield: false, zoom: false });
      else d.skip({ shield: false, zoom: false });
    }
    expect(d.finished).toBe(true);
    expect(d.ticked.has('radial')).toBe(true);
    expect(d.skipped.has('shield')).toBe(true);
    expect(d.skipped.has('zoom')).toBe(true);
    expect(DRILL.map((s) => s.id)).toEqual(['move', 'jet', 'fire', 'dash', 'chain', 'cycle', 'throw', 'swap', 'radial', 'reload', 'melee', 'shield', 'zoom', 'take', 'scores', 'camera']);
  });

  it('teaches every control: move and jet fuel, aim and fire, dash and chains, grenades, swap, reload, melee, shield, zoom, take, the scoreboard, the camera', () => {
    const controls = new Set(DRILL.map((s) => s.control));
    for (const c of ['move', 'aim', 'dash', 'grenade', 'swap', 'reload', 'melee', 'shield', 'zoom', 'take', 'scores'] as const) expect(controls.has(c)).toBe(true);
    expect(DRILL.find((s) => s.id === 'jet')!.how).toMatch(/fuel/);
  });

  it('the drill follows the layout: JET when the stick doesn\'t jet, FIRE in Fire button mode, automatic fire in One-thumb', () => {
    const step = (id: string) => DRILL.find((s) => s.id === id)!;
    const classic = { fire: 'pull', stickJet: true, preset: 'classic' } as const;
    const claw = { fire: 'button', stickJet: false, preset: 'claw' } as const;
    const one = { fire: 'auto', stickJet: true, preset: 'oneThumb' } as const;
    expect(drillControl(step('jet'), classic)).toBe('jet'); // Classic has a JET button now
    expect(drillControl(step('jet'), one)).toBe('move');
    expect(drillControl(step('jet'), claw)).toBe('jet');
    expect(drillHow(step('jet'), claw)).toMatch(/Hold Jet/);
    expect(drillControl(step('fire'), claw)).toBe('fire');
    expect(drillHow(step('fire'), claw)).toBe(FIRE_HOW.button);
    expect(drillHow(step('fire'), one)).toMatch(/automatic/);
    expect(drillControl(step('fire'), one)).toBe('aim');
    expect(drillHow(step('dash'), claw)).toBe(step('dash').how);
  });
});

describe('the gun pill radial lands where it is drawn (owner, 25 Oct)', () => {
  // the radial is drawn in the safe box; fingers come in the page's coordinates
  const phones = [
    { name: '780×360', w: 780, h: 360, safe: { x: 44, y: 10 } },
    { name: '844×300', w: 844, h: 300, safe: { x: 59, y: 10 } },
    { name: '812×375 with a notch', w: 812, h: 375, safe: { x: 47, y: 10 } },
  ];
  for (const p of phones) {
    it(`a finger on each drawn choice picks it (${p.name})`, () => {
      const box = { w: p.w - 2 * p.safe.x, h: p.h - p.safe.y - 21 };
      // the pill top right (the default) and bottom left (moved)
      for (const centre of [{ x: box.w * 0.79, y: 26 }, { x: box.w * 0.2, y: box.h - 40 }]) {
        const choices = radialAngles(centre.x, centre.y, box.w, box.h);
        const spots = radialSpots(centre, choices, 70, 24);
        spots.forEach((s, i) => {
          expect(radialPickOnPage({ x: s.x + p.safe.x, y: s.y + p.safe.y }, p.safe, centre, spots, 24)).toBe(i);
        });
        expect(radialPickOnPage({ x: centre.x + p.safe.x, y: centre.y + p.safe.y }, p.safe, centre, spots, 24)).toBe(-1);
      }
    });
  }
});
