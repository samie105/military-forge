/**
 * The minimap (maps-vertical): what it may know of the enemy (no wallhacks), how it fits a level,
 * where it sits on a phone, and that the level is drawn once and the dots each frame.
 */
import { getMap, maps, pickups, POWER_WEAPONS, weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, drawDots, drawSilhouette, fitMap, itemKind, paletteFor, toBoxX, toBoxY, toWorldX, toWorldY } from '../../src/minimap/draw';
import { EnemyIntel, HEARD_CELL, HEARD_MS, LAST_SEEN_MS, type ViewBox } from '../../src/minimap/intel';
import { BIG_PHONE, bigPhonePlace, phonePlace, widthFor } from '../../src/minimap/place';

const VIEW: ViewBox = { minX: 0, minY: 0, maxX: 36, maxY: 20 };
const at = (id: number, x: number, y: number, alive = true) => ({ id, x, y, alive });

describe('EnemyIntel: only what the player saw or heard', () => {
  it('an enemy on screen is seen where it is; off screen it never appears', () => {
    const intel = new EnemyIntel();
    intel.update([at(0, 10, 0), at(1, 20, 5), at(2, 150, 40)], 0, VIEW, 0);
    const marks = intel.marks(0);
    expect(marks).toEqual([{ kind: 'seen', x: 20, y: 5, alpha: 1, id: 1 }]);
    // however long it stays there, the far one is never shown
    for (let t = 0; t < 10_000; t += 500) intel.update([at(0, 10, 0), at(2, 150 + t / 100, 40)], 0, VIEW, t);
    expect(intel.marks(10_000).some((m) => m.id === 2)).toBe(false);
  });

  it('one that leaves the screen leaves a last-seen mark where it was, fading out', () => {
    const intel = new EnemyIntel();
    intel.update([at(0, 10, 0), at(1, 30, 5)], 0, VIEW, 0);
    intel.update([at(0, 10, 0), at(1, 60, 5)], 0, VIEW, 1000); // ran off screen: still in the snapshot (AOI)
    // it fades from the moment it was last seen
    const m = intel.marks(LAST_SEEN_MS / 2);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'last', x: 30, y: 5, id: 1 });
    expect(m[0]!.alpha).toBeCloseTo(0.5, 6);
    // the mark doesn't follow it as it moves on
    intel.update([at(0, 10, 0), at(1, 90, 5)], 0, VIEW, 2000);
    expect(intel.marks(2000)[0]).toMatchObject({ x: 30, y: 5 });
    intel.update([at(0, 10, 0), at(1, 90, 5)], 0, VIEW, LAST_SEEN_MS + 1);
    expect(intel.marks(LAST_SEEN_MS + 1)).toEqual([]);
  });

  it('dropped from the snapshot (out of the AOI, into smoke) or dead: last seen, not tracked', () => {
    const intel = new EnemyIntel();
    intel.update([at(0, 10, 0), at(1, 30, 5)], 0, VIEW, 0);
    intel.update([at(0, 10, 0)], 0, VIEW, 100);
    expect(intel.marks(100)[0]).toMatchObject({ kind: 'last', x: 30 });
    const dead = new EnemyIntel();
    dead.update([at(0, 10, 0), at(1, 30, 5)], 0, VIEW, 0);
    dead.update([at(0, 10, 0), at(1, 30, 5, false)], 0, VIEW, 100);
    expect(dead.marks(100)[0]).toMatchObject({ kind: 'last' });
  });

  it('gunfire off screen is heard at a coarse 4 m spot, never exactly; on screen it adds nothing', () => {
    const intel = new EnemyIntel();
    intel.update([at(0, 10, 0)], 0, VIEW, 0);
    intel.shot(3, 0, 101.3, 41.7, 0);
    intel.shot(4, 0, 20, 5, 0); // on screen: the frame shows the shooter, no ring
    intel.shot(0, 0, 200, 0, 0); // our own
    const m = intel.marks(0);
    expect(m).toEqual([{ kind: 'heard', x: 100, y: 40, alpha: 1, id: -1 }]);
    expect(m[0]!.x % HEARD_CELL).toBe(0);
    expect(intel.marks(HEARD_MS + 1)).toEqual([]);
  });

  it('allies are never enemy marks', () => {
    const intel = new EnemyIntel();
    intel.allies = new Set([1]);
    intel.update([at(0, 10, 0), at(1, 20, 5)], 0, VIEW, 0);
    intel.shot(1, 0, 150, 0, 0);
    expect(intel.marks(0)).toEqual([]);
  });
});

describe('fitting a level into a box', () => {
  it('the whole level fits, centred, with the padding; the transform round-trips', () => {
    const map = getMap('vertical-test');
    const f = fitMap(map, 300, 140, 4);
    const b = map.bounds;
    expect(toBoxX(f, b.minX)).toBeGreaterThanOrEqual(4 - 1e-9);
    expect(toBoxX(f, b.maxX)).toBeLessThanOrEqual(296 + 1e-9);
    expect(toBoxY(f, b.maxY)).toBeGreaterThanOrEqual(4 - 1e-9);
    expect(toBoxY(f, b.minY)).toBeLessThanOrEqual(136 + 1e-9);
    expect(toWorldX(f, toBoxX(f, 37))).toBeCloseTo(37, 9);
    expect(toWorldY(f, toBoxY(f, 61))).toBeCloseTo(61, 9);
  });

  it('zoomed, the box shows the point asked for, clamped so the level fills it', () => {
    const map = getMap('vertical-test');
    const f = fitMap(map, 300, 140, 4, 3, 100, 40);
    expect(toBoxX(f, 100)).toBeCloseTo(150, 6);
    expect(toBoxY(f, 40)).toBeCloseTo(70, 6);
    const corner = fitMap(map, 300, 140, 4, 3, -500, -500);
    expect(toBoxX(corner, map.bounds.minX)).toBeCloseTo(0, 6);
    expect(toBoxY(corner, map.bounds.minY)).toBeCloseTo(140, 6);
  });
});

describe('a phone’s minimap stays clear of the touch controls', () => {
  const aspect = 204 / 108;
  it('the top-left of the safe box when nothing is there, as wide as the level’s shape needs', () => {
    const p = phonePlace([], aspect);
    expect(p).toMatchObject({ x: 52, y: 16, h: 72 });
    expect(p.w).toBe(widthFor(72, 16, aspect, 96, 176));
    expect(p.w).toBeLessThan(176); // a tall level: a narrower box, no empty sides
    expect(phonePlace([], 6).w).toBe(176); // a long flat level fills the widest
  });

  it('the big map keeps clear of a control below it or beside it, and never shrinks past its minimum', () => {
    expect(bigPhonePlace([])).toEqual({ ...BIG_PHONE });
    const reload = { left: 468, top: 220, right: 516, bottom: 268 };
    const below = bigPhonePlace([reload]);
    expect(below.y + below.h).toBeLessThanOrEqual(reload.top - 6);
    const beside = { left: 500, top: 70, right: 548, bottom: 118 };
    const right = bigPhonePlace([beside]);
    expect(right.x + right.w).toBeLessThanOrEqual(beside.left - 6);
    expect(right.w).toBeGreaterThanOrEqual(220);
  });

  it('the left FIRE (Fire button mode) or a moved control there: smaller, or lower', () => {
    const fireLeft = { left: 128, top: 58, right: 200, bottom: 130 };
    const p = phonePlace([fireLeft], aspect);
    const box = { left: p.x, top: p.y, right: p.x + p.w, bottom: p.y + p.h };
    expect(box.right <= fireLeft.left || box.bottom <= fireLeft.top || box.top >= fireLeft.bottom).toBe(true);
    const everywhere = [{ left: 0, top: 0, right: 812, bottom: 375 }];
    expect(phonePlace(everywhere, aspect)).toBeTruthy(); // no free slot: the least-covered one, never none
  });
});

/** A 2D context that records what was drawn. */
function recorder() {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) => (typeof k === 'string' && ['canvas'].includes(k) ? null : (...a: unknown[]) => calls.push(`${String(k)}(${a.map((v) => (typeof v === 'number' ? Math.round(v) : String(v))).join(',')})`)),
      set: (_t, k, v) => {
        calls.push(`${String(k)}=${String(v)}`);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('drawing', () => {
  it('the silhouette: every solid filled and every slab stroked, on every map', () => {
    for (const map of Object.values(maps)) {
      const { ctx, calls } = recorder();
      drawSilhouette(ctx, map, fitMap(map, 300, 140), 300, 140);
      expect(calls.filter((c) => c.startsWith('fill(')).length, map.id).toBeGreaterThanOrEqual(map.solids.length);
      expect(calls.filter((c) => c.startsWith('moveTo(')).length, map.id).toBeGreaterThanOrEqual(map.oneWays.length);
    }
  });

  it('the dots: one enemy mark per intel mark and none for anyone else', () => {
    const map = getMap('vertical-test');
    const f = fitMap(map, 300, 140);
    const { ctx, calls } = recorder();
    drawDots(ctx, f, { me: { x: 10, y: 0, aim: 0, alive: true }, view: null, allies: [], items: [], marks: [], pulse: 0 });
    const enemyStyle = `fillStyle=${DEFAULT_PALETTE.enemy}`;
    expect(calls.includes(enemyStyle)).toBe(false);
    const two = recorder();
    drawDots(two.ctx, f, { me: null, view: null, allies: [], items: [], marks: [{ kind: 'seen', x: 50, y: 20, alpha: 1, id: 3 }], pulse: 0 });
    expect(two.calls.filter((c) => c === 'fill()').length).toBe(1);
  });

  it('power weapons get their own mark; the colour-blind modes change enemies, not you', () => {
    const power = pickups.find((p) => p.kind === 'weapon' && POWER_WEAPONS.has(weapons[p.weapon!]!.id))!;
    const gun = pickups.find((p) => p.kind === 'weapon' && !POWER_WEAPONS.has(weapons[p.weapon!]!.id))!;
    expect(itemKind(power.index)).toBe('power');
    expect(itemKind(gun.index)).toBe('weapon');
    expect(itemKind(0)).toBe('item');
    expect(paletteFor('deutan').enemy).not.toBe(DEFAULT_PALETTE.enemy);
    expect(paletteFor('deutan').you).toBe(DEFAULT_PALETTE.you);
  });
});
