import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACEMENTS, availableControls, loadLayout, placementFor, saveLayout, withPlacement } from '../../src/touch/layout';
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

  it("defaults follow the design kit's phone HUD: menu top right, actions in an arc round the aim stick, nothing overlapping", () => {
    const [w, h] = [812, 375]; // the kit's phone frame
    const px = (id: keyof typeof DEFAULT_PLACEMENTS) => ({ x: DEFAULT_PLACEMENTS[id].x * w, y: DEFAULT_PLACEMENTS[id].y * h, r: (DEFAULT_PLACEMENTS[id].size * h) / 2 });
    expect(px('pause').x).toBeGreaterThan(w * 0.85);
    expect(px('pause').y).toBeLessThan(h * 0.15);
    const aim = px('aim');
    const out = (id: keyof typeof DEFAULT_PLACEMENTS) => Math.hypot(px(id).x - aim.x, px(id).y - aim.y);
    for (const id of ['grenade', 'dash', 'reload', 'swap'] as const) expect(out(id)).toBeCloseTo(106, -1);
    for (const id of ['cycleGrenade', 'melee', 'shield'] as const) expect(out(id)).toBeCloseTo(172, -1);
    const buttons = Object.keys(DEFAULT_PLACEMENTS).filter((id) => id !== 'move' && id !== 'aim') as (keyof typeof DEFAULT_PLACEMENTS)[];
    for (const a of buttons) for (const b of buttons) if (a < b) expect(Math.hypot(px(a).x - px(b).x, px(a).y - px(b).y), `${a}/${b}`).toBeGreaterThan(px(a).r + px(b).r);
    for (const id of buttons) expect(Math.hypot(px(id).x - aim.x, px(id).y - aim.y), id).toBeGreaterThan(aim.r + px(id).r);
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

  it('aim assist defaults on (touch only); the shield button is there once the sim has its bit', () => {
    expect(DEFAULT_TOUCH_SETTINGS.aimAssist).toBe(true);
    const shield = availableControls().find((c) => c.id === 'shield');
    expect(shield?.bit ?? 0).toBe((Btn as Record<string, number>).Shield ?? 0);
    expect(Boolean(shield)).toBe('Shield' in Btn);
  });
});
