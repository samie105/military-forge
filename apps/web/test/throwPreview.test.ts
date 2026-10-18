import { EMP, FLASHBANG, FRAG, GAS, MINE, SMOKE, movementTestMap, type GrenadeDef } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { Btn, Game, MineState, createInput, ticks, type Input } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { ARC_POINTS, ThrowPreview, arcDots, predictThrow, throwArcView } from '../src/throwPreview';

/** A player on open floor (between the overhang and the one-way platforms) holding `buttons`, aiming `deg`, `settle` ticks in. */
function thrower(deg: number, buttons = 0, settle = 30, x = 118) {
  const game = new Game({ map: movementTestMap });
  const me = game.addPlayer('P');
  me.x = x;
  me.y = 0;
  const input: Input = { ...createInput(), buttons, aim: angleToU16((deg * Math.PI) / 180) };
  for (let i = 0; i < settle; i++) game.step([input]);
  return { game, me, input };
}

/** Holds `def`'s type selected, with a pair of them. */
function holding(me: ReturnType<typeof thrower>['me'], def: GrenadeDef): void {
  me.grenadeType = def.index;
  me.grenadeCounts[def.index] = 2;
}

/**
 * Throws on the next tick (the same buttons, plus the grenade key) and checks the grenade against
 * the preview tick for tick, as long as both last. Sim positions are multiples of 1/1024: exact in
 * the preview's float32s.
 */
function throwsAsPreviewed(t: ReturnType<typeof thrower>, def: GrenadeDef, strength: number) {
  const view = throwArcView();
  predictThrow(t.game, t.me, def, strength, view);
  t.game.step([{ ...t.input, buttons: t.input.buttons | Btn.Grenade, throwStrength: strength }]);
  const g = t.game.grenades.find((n) => n.alive)!;
  expect(g.type).toBe(def.index);
  let k = 1;
  for (; k < view.count && g.alive; k++) {
    expect([g.x, g.y]).toEqual([view.points[k * 2], view.points[k * 2 + 1]]);
    t.game.step([t.input]);
  }
  return { view, g, compared: k - 1 };
}

describe('predictThrow: the path the sim then throws', () => {
  it('standing, at any aim and strength', () => {
    for (const [deg, strength] of [
      [40, 3],
      [70, 7],
      [-20, 0],
      [150, 5],
    ] as const) {
      const t = thrower(deg);
      const { view, compared } = throwsAsPreviewed(t, FRAG, strength);
      expect(view.count).toBe(ARC_POINTS);
      expect(compared).toBe(ARC_POINTS - 1);
    }
  });

  it('running, jetting and falling (the thrower moves a tick before it throws)', () => {
    const cases = [
      thrower(35, Btn.Right, 30, 117), // running right
      thrower(60, Btn.Left, 30, 122), // running left, throwing back over its shoulder
      thrower(30, Btn.Jet | Btn.Right, 25, 117), // jetting up and right
      (() => {
        const t = thrower(20, Btn.Jet, 30, 119); // up high, then falling
        for (let i = 0; i < 12; i++) t.game.step([{ ...t.input, buttons: 0 }]);
        t.input.buttons = 0;
        return t;
      })(),
    ];
    for (const t of cases) {
      expect(Math.abs(t.me.vx) + Math.abs(t.me.vy)).toBeGreaterThan(1); // really moving
      const { compared } = throwsAsPreviewed(t, FRAG, 6);
      expect(compared).toBeGreaterThan(60);
    }
  });

  it('every grenade type: the path ends where its fuse runs out, a mine where it sticks', () => {
    for (const def of [SMOKE, GAS, FLASHBANG, EMP]) {
      const t = thrower(45);
      holding(t.me, def);
      const { view, compared } = throwsAsPreviewed(t, def, 4);
      expect(view.type).toBe(def.index);
      expect(view.detonates).toBe(ticks(def.fuse) <= ARC_POINTS - 1); // goes off within the preview
      expect(compared).toBe(view.count - 1);
    }
    const t = thrower(-15); // at the floor a few metres on
    holding(t.me, MINE);
    const { view, g } = throwsAsPreviewed(t, MINE, 7);
    expect(view.land).toBe(view.count - 1); // the last point is where it sticks
    expect(g.state).not.toBe(MineState.Flying);
    expect([g.x, g.y]).toEqual([view.points[view.land * 2], view.points[view.land * 2 + 1]]);
  });

  it('leaves the live game untouched, and a previewed mine runs into no one', () => {
    const t = thrower(0, 0, 30, 150);
    const target = t.game.addPlayer('Q'); // right in a mine's path
    target.x = 152;
    target.y = 0;
    holding(t.me, MINE);
    const before = { tick: t.game.tick, events: t.game.events.length, x: t.me.x, vx: t.me.vx, hp: target.hp };
    predictThrow(t.game, t.me, MINE, 7, throwArcView());
    expect(t.game.grenades.some((g) => g.alive)).toBe(false);
    expect({ tick: t.game.tick, events: t.game.events.length, x: t.me.x, vx: t.me.vx, hp: target.hp }).toEqual(before);
  });

  it('marks where a frag first comes down', () => {
    const t = thrower(10);
    const view = throwArcView();
    predictThrow(t.game, t.me, FRAG, 0, view);
    expect(view.land).toBeGreaterThan(5);
    const y = view.points[view.land * 2 + 1]!;
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(FRAG.radius + 0.25);
  });
});

describe('ThrowPreview', () => {
  it('the selected type while a throw is aimed; nothing when not aiming, dead or out of that type', () => {
    const p = new ThrowPreview();
    const t = thrower(40);
    holding(t.me, SMOKE);
    expect(p.update(t.game, t.me, -1)).toBeNull();
    expect(p.update(t.game, t.me, 3)?.type).toBe(SMOKE.index);
    t.me.grenadeCounts[SMOKE.index] = 0;
    expect(p.update(t.game, t.me, 3)).toBeNull();
    holding(t.me, SMOKE);
    t.me.alive = false;
    expect(p.update(t.game, t.me, 3)).toBeNull();
    expect(p.update(null, null, 3)).toBeNull();
  });
});

describe('arcDots', () => {
  it('a dot every 0.42 m from the march phase, fainter past the landing', () => {
    const view = throwArcView();
    // a straight 4.4 m path in 10 steps, landing halfway
    for (let i = 0; i <= 10; i++) {
      view.points[i * 2] = i * 0.44;
      view.points[i * 2 + 1] = 0;
    }
    view.count = 11;
    view.land = 5;
    const dots: [number, boolean][] = [];
    arcDots(view, 0, (x, _y, after) => dots.push([Math.round(x * 100) / 100, after]));
    expect(dots.map((d) => d[0])).toEqual([0.42, 0.84, 1.26, 1.68, 2.1, 2.52, 2.94, 3.36, 3.78, 4.2]);
    expect(dots.filter((d) => d[1]).length).toBe(5); // past 2.2 m
    const moved: number[] = [];
    arcDots(view, 0.2, (x) => moved.push(x));
    expect(moved[0]).toBeCloseTo(0.22);
  });
});
