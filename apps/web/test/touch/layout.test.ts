import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACEMENTS, MIN_TARGET_PX, PILLS, SAFE_INSETS, availableControls, loadLayout, placementFor, saveLayout, sizePx, snapPlacement, withPlacement } from '../../src/touch/layout';
import { DEFAULT_TOUCH_SETTINGS, LAYOUT_KEY, LIMITS, SETTINGS_KEY, clearLayout, loadSettings, saveSettings, type KeyValueStore } from '../../src/touch/settings';

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

describe('touch HUD layout', () => {
  it('defaults, mirrored for the left-handed layout', () => {
    const layout = loadLayout(memoryStore());
    expect(placementFor(layout, 'aim', 'right')).toEqual(DEFAULT_PLACEMENTS.aim);
    expect(placementFor(layout, 'aim', 'left').x).toBeCloseTo(1 - DEFAULT_PLACEMENTS.aim.x, 12);
    expect(placementFor(layout, 'aim', 'left').y).toBe(DEFAULT_PLACEMENTS.aim.y);
  });

  it("defaults follow the round-two kit's phone HUD (m-hud): the thumb dials and the buttons where it draws them", () => {
    // the kit's 812×375 frame and its safe box (44 px each side, 10 top, 21 bottom): 724×344
    const box = { left: SAFE_INSETS.left, top: SAFE_INSETS.top, w: 812 - SAFE_INSETS.left - SAFE_INSETS.right, h: 375 - SAFE_INSETS.top - SAFE_INSETS.bottom };
    expect(box).toEqual({ left: 44, top: 10, w: 724, h: 344 });
    const unit = Math.min(box.w, box.h);
    const at = (id: keyof typeof DEFAULT_PLACEMENTS) => ({ x: box.left + DEFAULT_PLACEMENTS[id].x * box.w, y: box.top + DEFAULT_PLACEMENTS[id].y * box.h, d: sizePx(DEFAULT_PLACEMENTS[id], unit) });
    // the kit's centres and diameters (its left/top + half the size): dials' bases 136 px
    const kit: [keyof typeof DEFAULT_PLACEMENTS, number, number, number][] = [
      ['move', 128, 266, 136],
      ['aim', 684, 266, 136],
      ['shield', 679, 132, 52],
      ['reload', 619, 149, 52],
      ['dash', 573, 191, 52],
      ['grenade', 551, 250, 58],
      ['melee', 558, 312, 52],
      ['pause', 744, 34, 48],
    ];
    // shield, reload and dash are spread a few px from where the kit draws them (their rings touched)
    const nudged = new Set(['shield', 'reload', 'dash']);
    for (const [id, x, y, d] of kit) {
      const p = at(id);
      const tol = nudged.has(id) ? 10 : 2;
      expect(Math.abs(p.x - x), `${id} x`).toBeLessThanOrEqual(tol);
      expect(Math.abs(p.y - y), `${id} y`).toBeLessThanOrEqual(tol);
      expect(Math.abs(p.d - d), `${id} size`).toBeLessThanOrEqual(2);
    }
    // the dial buttons' rings (the dash cooldown, a reload's progress: 5 px past the button) keep 4 px apart
    const ring: Record<string, number> = { shield: 0, reload: 5, dash: 5, grenade: 0, melee: 0 };
    for (const a of Object.keys(ring)) for (const b of Object.keys(ring)) if (a < b) expect(Math.hypot(at(a as 'dash').x - at(b as 'dash').x, at(a as 'dash').y - at(b as 'dash').y) - (at(a as 'dash').d + at(b as 'dash').d) / 2 - ring[a]! - ring[b]!, `${a}/${b} gap`).toBeGreaterThanOrEqual(4);
    // round controls never overlap (pills are checked by their height: their width follows the gun's name)
    const round = (Object.keys(DEFAULT_PLACEMENTS) as (keyof typeof DEFAULT_PLACEMENTS)[]).filter((id) => !PILLS.has(id));
    // (FIRE sits at the aim dial's rest on purpose: in Fire button mode the dial only shows under a thumb)
    const together = (a: string, b: string) => !(a === 'aim' && b === 'fire');
    for (const a of round) for (const b of round) if (a < b && together(a, b)) expect(Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y), `${a}/${b}`).toBeGreaterThan((at(a).d + at(b).d) / 2);
    // every target is at least 48 px, and inside the safe box
    for (const id of Object.keys(DEFAULT_PLACEMENTS) as (keyof typeof DEFAULT_PLACEMENTS)[]) {
      expect(at(id).d, id).toBeGreaterThanOrEqual(MIN_TARGET_PX);
      expect(DEFAULT_PLACEMENTS[id].x, id).toBeGreaterThanOrEqual(LIMITS.min);
      expect(DEFAULT_PLACEMENTS[id].x, id).toBeLessThanOrEqual(LIMITS.max);
    }
  });

  it('no target is ever drawn under 48 px, however small the layout says', () => {
    expect(sizePx({ size: LIMITS.sizeMin }, 344)).toBe(MIN_TARGET_PX);
    expect(sizePx({ size: 0.395 }, 344)).toBe(136);
    expect(sizePx({ size: 0.151 }, 1000)).toBe(151);
  });

  it('the editor snaps a dragged control to the centre lines and to the other controls, within a few px', () => {
    const others = [{ x: 0.2, y: 0.7 }];
    expect(snapPlacement({ x: 0.505, y: 0.3 }, others, 700, 340)).toEqual({ x: 0.5, y: 0.3, guides: [{ axis: 'x', at: 0.5 }] });
    expect(snapPlacement({ x: 0.3, y: 0.71 }, others, 700, 340)).toEqual({ x: 0.3, y: 0.7, guides: [{ axis: 'y', at: 0.7 }] });
    expect(snapPlacement({ x: 0.3, y: 0.3 }, others, 700, 340)).toEqual({ x: 0.3, y: 0.3, guides: [] });
    const both = snapPlacement({ x: 0.201, y: 0.499 }, others, 700, 340);
    expect([both.x, both.y]).toEqual([0.2, 0.5]);
    expect(both.guides).toHaveLength(2);
  });

  it("a player's saved places outlast new defaults", () => {
    const store = memoryStore({ [LAYOUT_KEY]: JSON.stringify({ placements: { pause: { x: 0.035, y: 0.08, size: 0.1, opacity: 1 } } }) });
    const layout = loadLayout(store);
    expect(placementFor(layout, 'pause', 'right')).toEqual({ x: 0.035, y: 0.08, size: 0.1, opacity: 1 });
    expect(placementFor(layout, 'reload', 'right')).toEqual(DEFAULT_PLACEMENTS.reload);
  });

  it('edits persist, in either handedness, and come back the same', () => {
    const store = memoryStore();
    let layout = loadLayout(store);
    layout = withPlacement(layout, 'reload', { x: 0.5, y: 0.2, size: 0.2, opacity: 0.6 }, 'right');
    layout = withPlacement(layout, 'dash', { x: 0.8, y: 0.9, size: 0.18, opacity: 0.9 }, 'left'); // dragged in the mirrored layout
    saveLayout(store, layout);
    const again = loadLayout(store);
    expect(placementFor(again, 'reload', 'right')).toEqual({ x: 0.5, y: 0.2, size: 0.2, opacity: 0.6 });
    expect(placementFor(again, 'dash', 'left').x).toBeCloseTo(0.8, 12); // where it was put, on screen
    expect(placementFor(again, 'dash', 'right').x).toBeCloseTo(0.2, 12);
    clearLayout(store); // Reset
    expect(loadLayout(store).placements).toEqual({});
  });

  it('placements stay on screen and readable', () => {
    const layout = withPlacement({ placements: {} }, 'swap', { x: 1.4, y: -1, size: 5, opacity: 0 }, 'right');
    expect(placementFor(layout, 'swap', 'right')).toEqual({ x: LIMITS.max, y: LIMITS.min, size: LIMITS.sizeMax, opacity: LIMITS.opacityMin });
  });

  it('a corrupt or hostile save falls back to defaults, keeping what is valid', () => {
    expect(loadLayout(memoryStore({ [LAYOUT_KEY]: '{not json' })).placements).toEqual({});
    const store = memoryStore({
      [LAYOUT_KEY]: JSON.stringify({
        placements: { reload: { x: 0.4, y: 0.4, size: 0.2 }, __proto__: { x: 1 }, bogus: { x: 0.1, y: 0.1, size: 0.1 }, swap: { x: 'left', y: 0.1, size: 0.1 }, melee: { x: 0.5, y: 0.5, size: 0.2, opacity: Infinity } },
      }),
    });
    const layout = loadLayout(store);
    expect(Object.keys(layout.placements).sort()).toEqual(['melee', 'reload']);
    expect(layout.placements.reload!.opacity).toBe(1);
    expect(layout.placements.melee!.opacity).toBe(1);
  });

  it('no storage at all (private mode): defaults, and saving never throws', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(loadLayout(broken).placements).toEqual({});
    expect(() => saveLayout(broken, { placements: {} })).not.toThrow();
    expect(loadSettings(broken)).toEqual(DEFAULT_TOUCH_SETTINGS);
    expect(loadLayout(null).placements).toEqual({});
  });

  it('settings round-trip and are sanitised', () => {
    const store = memoryStore();
    saveSettings(store, { ...DEFAULT_TOUCH_SETTINGS, fire: 'release', handed: 'left', aimAssist: false, opacity: 0.8 });
    expect(loadSettings(store)).toEqual({ ...DEFAULT_TOUCH_SETTINGS, fire: 'release', handed: 'left', aimAssist: false, opacity: 0.8 });
    store.setItem(SETTINGS_KEY, JSON.stringify({ mode: 'always', fire: 'spray', opacity: 9, vibrate: 'yes' }));
    expect(loadSettings(store)).toEqual({ ...DEFAULT_TOUCH_SETTINGS, opacity: LIMITS.opacityMax });
  });

  it('a save from round one keeps its choices, but its default opacity becomes the default (now Button fade\'s)', () => {
    const old = memoryStore({ [SETTINGS_KEY]: JSON.stringify({ mode: 'on', fire: 'release', opacity: 0.55 }) });
    expect(loadSettings(old)).toMatchObject({ mode: 'on', fire: 'release', opacity: DEFAULT_TOUCH_SETTINGS.opacity });
    const chosen = memoryStore({ [SETTINGS_KEY]: JSON.stringify({ opacity: 0.4 }) });
    expect(loadSettings(chosen).opacity).toBe(0.4);
    // saved again (rev 2), 0.55 is a choice like any other
    const store = memoryStore();
    saveSettings(store, { ...DEFAULT_TOUCH_SETTINGS, opacity: 0.55 });
    expect(loadSettings(store).opacity).toBe(0.55);
  });

  it('aim assist defaults on (touch only); the shield button is there once the sim has its bit', () => {
    expect(DEFAULT_TOUCH_SETTINGS.aimAssist).toBe(true);
    const shield = availableControls().find((c) => c.id === 'shield');
    expect(shield?.bit ?? 0).toBe((Btn as Record<string, number>).Shield ?? 0);
    expect(Boolean(shield)).toBe('Shield' in Btn);
  });
});
