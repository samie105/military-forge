import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { CONTEXT_PRIORITY, DEFAULT_PLACEMENTS, MIN_TARGET_PX, OFF_HUD, PILLS, PINNABLE, PX_PER_MM, SAFE_INSETS, availableControls, loadLayout, placementFor, saveLayout, sizePx, snapPlacement, withPinned, withPlacement, type ControlId, type TouchLayout } from '../../src/touch/layout';
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

  // the spec's Classic layout (controls-research.md §4.2): mm anchors, the same reach on every phone
  const PHONES: [number, number][] = [
    [667, 375],
    [812, 375],
    [844, 390],
    [915, 412],
    [932, 430],
  ];
  const lay = (W: number, H: number, layout: TouchLayout = { placements: {} }) => {
    const box = { left: SAFE_INSETS.left, top: SAFE_INSETS.top, w: W - SAFE_INSETS.left - SAFE_INSETS.right, h: H - SAFE_INSETS.top - SAFE_INSETS.bottom };
    const unit = Math.min(box.w, box.h);
    return (id: ControlId) => {
      const p = placementFor(layout, id, 'right', box);
      return { x: box.left + p.x * box.w, y: box.top + p.y * box.h, d: sizePx(p, unit), box };
    };
  };
  // what the HUD shows by default (the context slot drawn by Take, where it will be)
  const ON_HUD: ControlId[] = ['move', 'aim', 'grenade', 'dash', 'swap', 'take', 'scores', 'pause'];

  it('at 812×375 the controls sit where the spec puts them (±1 px)', () => {
    const at = lay(812, 375);
    const want: [ControlId, number, number][] = [
      ['move', 140, 264],
      ['aim', 672, 264],
      ['grenade', 521, 302],
      ['dash', 557, 217],
      ['swap', 620, 150],
      ['take', 703, 110],
      ['scores', 68, 34],
      ['pause', 744, 34],
    ];
    for (const [id, x, y] of want) {
      expect(Math.abs(at(id).x - x), `${id} x`).toBeLessThanOrEqual(1);
      expect(Math.abs(at(id).y - y), `${id} y`).toBeLessThanOrEqual(1);
    }
  });

  it('on five phones (667–932 px): hits ≥ 10 mm (primaries 12, the top bar 8), ≥ 2 mm apart, the arc 42 ± 1 mm from the corner, only the top bar in the top band', () => {
    for (const [W, H] of PHONES) {
      const at = lay(W, H);
      for (const id of ON_HUD) {
        const min = id === 'scores' || id === 'pause' ? 48 : id === 'dash' || id === 'grenade' ? 72 : 60;
        expect(at(id).d, `${W}: ${id} size`).toBeGreaterThanOrEqual(min);
      }
      for (const a of ON_HUD)
        for (const b of ON_HUD) {
          if (a >= b) continue;
          const gap = Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y) - (at(a).d + at(b).d) / 2;
          expect(gap, `${W}: ${a}/${b} gap`).toBeGreaterThanOrEqual(12);
        }
      const corner = { x: W - SAFE_INSETS.right, y: H - SAFE_INSETS.bottom };
      for (const id of ['grenade', 'dash', 'swap', 'take'] as ControlId[]) {
        const mm = Math.hypot(at(id).x - corner.x, at(id).y - corner.y) / PX_PER_MM;
        expect(Math.abs(mm - 42), `${W}: ${id} at ${mm.toFixed(1)} mm`).toBeLessThanOrEqual(1);
      }
      for (const id of ON_HUD) if (id !== 'scores' && id !== 'pause') expect(at(id).y, `${W}: ${id} below the top band`).toBeGreaterThanOrEqual(90);
    }
  });

  it('pinned controls (the editor) get their own places, clear of the HUD and of each other', () => {
    const layout: TouchLayout = { placements: {}, pinned: [...PINNABLE] };
    for (const [W, H] of PHONES) {
      const at = lay(W, H, layout);
      const all = [...ON_HUD, ...PINNABLE];
      for (const a of all)
        for (const b of all) {
          if (a >= b) continue;
          const gap = Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y) - (at(a).d + at(b).d) / 2;
          expect(gap, `${W}: ${a}/${b}`).toBeGreaterThanOrEqual(PILLS.has(a) || PILLS.has(b) ? 4 : 12);
        }
    }
    // pins survive a save and a load; unknown ones are dropped
    const store = memoryStore();
    saveLayout(store, withPinned({ placements: {} }, 'reload', true));
    expect(loadLayout(store).pinned).toEqual(['reload']);
    store.data[LAYOUT_KEY] = JSON.stringify({ placements: {}, pinned: ['reload', 'jetpack'] });
    expect(loadLayout(store).pinned).toEqual(['reload']);
    expect(withPinned({ placements: {}, pinned: ['reload'] }, 'reload', false).pinned).toEqual([]);
  });

  it('the HUD carries the arc; next grenade, melee, reload, zoom and the shield come by the context slot (or a pin)', () => {
    expect([...OFF_HUD].sort()).toEqual(['cycleGrenade', 'melee', 'reload', 'shield', 'take', 'zoom']);
    expect(CONTEXT_PRIORITY).toEqual(['take', 'melee', 'shield', 'reload', 'zoom']);
    expect(LAYOUT_KEY).toBe('mf.touch.layout.v2');
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
