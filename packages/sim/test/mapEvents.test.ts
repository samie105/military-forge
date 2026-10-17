/**
 * Map events (docs/02 §20.7): the seeded schedule, what each event does while it runs, event
 * zones, and the property prediction relies on: the event state at a tick is a pure function of
 * the map, the seed and that tick.
 */
import { getMap, type MapDef, type MapEventDef, type MapEvents, type MapZone } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, EventClock, Game, MapEventPhase, MapMechanics, createBodyEnv, createOccurrence, type SimEvent } from '../src';
import { flatMap, hold, makeGame, placeOnGround } from './helpers';

function withEvents(events: MapEvents, zones: MapZone[] = []): MapDef {
  return { ...flatMap(), events, zones };
}

function timeline(defs: MapEventDef[], entries: { at: number; event: string }[], loop?: number, start = 0): MapEvents {
  return { defs, schedule: { kind: 'timeline', start, entries, ...(loop !== undefined ? { loop } : {}) } };
}

type MapEventSim = Extract<SimEvent, { type: 'mapEvent' }>;

/** Steps an empty game `n` ticks and returns its map events with the tick they happened on. */
function collect(game: Game, n: number): (MapEventSim & { tick: number })[] {
  const out: (MapEventSim & { tick: number })[] = [];
  for (let i = 0; i < n; i++) {
    const tick = game.tick;
    game.step([]);
    for (const e of game.events) if (e.type === 'mapEvent') out.push({ ...e, tick });
  }
  return out;
}

describe('map event schedule', () => {
  it('timeline: warning, start and end on the scheduled ticks, every kind once, then it loops', () => {
    const game = new Game({ mapId: 'mechanics-test', seed: 5 });
    const events = collect(game, 60 * 105);
    const ids = game.mech!.events.map((e) => e.id);
    const first = events.slice(0, 3).map((e) => [e.tick, ids[e.event], e.phase, e.ticks]);
    // start 2 s, the surge at 1 s with a 1 s warning and 5 s duration
    expect(first).toEqual([
      [120, 'surge', MapEventPhase.Warning, 60],
      [180, 'surge', MapEventPhase.Start, 300],
      [480, 'surge', MapEventPhase.End, 0],
    ]);
    const lap = events.filter((e) => e.phase === MapEventPhase.Start).slice(0, 7).map((e) => ids[e.event]);
    expect(lap).toEqual(['surge', 'floaty', 'emp', 'fog', 'gusts', 'pocket', 'molasses']);
    // the 49 s loop: the surge again, 2940 ticks later, as the next occurrence
    const again = events.filter((e) => ids[e.event] === 'surge' && e.phase === MapEventPhase.Warning);
    expect(again.map((e) => e.tick)).toEqual([120, 3060, 6000]);
    expect(again.map((e) => e.occurrence)).toEqual([0, 7, 14]);
  });

  it('random: seeded, at most one event per cycle and inside it, weights and chance respected', () => {
    const map = withEvents({
      defs: [
        { id: 'a', kind: 'emp', duration: 4, warning: 1 },
        { id: 'b', kind: 'fog', duration: 6, warning: 2 },
        { id: 'never', kind: 'gravitySurge' },
      ],
      schedule: { kind: 'random', start: 10, cycle: 20, chance: 0.75, weights: { b: 3, never: 0 } },
    });
    const occurrences = (seed: number) => {
      const clock = new EventClock(map);
      const o = createOccurrence();
      const seen: string[] = [];
      for (let k = 0; k < 400; k++) {
        const cycleStart = 600 + k * 1200;
        // scan the cycle for its occurrence
        let found = '';
        for (let t = cycleStart; t < cycleStart + 1200; t += 6) {
          if (!clock.occurrenceAt(seed, t, o)) continue;
          expect(o.occurrence).toBe(k);
          expect(o.warnTick).toBeGreaterThanOrEqual(cycleStart);
          expect(o.endTick).toBeLessThanOrEqual(cycleStart + 1200);
          found = clock.events[o.event]!.id;
          break;
        }
        seen.push(found);
      }
      return seen;
    };
    const s1 = occurrences(1);
    expect(occurrences(1)).toEqual(s1);
    expect(occurrences(2)).not.toEqual(s1);
    const count = (id: string) => s1.filter((x) => x === id).length;
    expect(count('never')).toBe(0);
    expect(count('') / s1.length).toBeCloseTo(0.25, 1);
    expect(count('b') / count('a')).toBeGreaterThan(2.2);
    expect(count('b') / count('a')).toBeLessThan(4);
  });

  it('is a pure function of seed and tick: a game that jumps to a tick agrees with one that ran to it', () => {
    const map = getMap('mechanics-test');
    const ran = new Game({ map, seed: 99 });
    const jumped = new Game({ map, seed: 99 });
    const env = createBodyEnv();
    const env2 = createBodyEnv();
    for (let i = 0; i < 60 * 50; i++) {
      ran.step([]);
      if (i % 97 !== 0) continue;
      jumped.tick = i; // like a predictor re-simulating, or a client joining late
      jumped.step([]);
      expect(jumped.mech!.activeEvent).toEqual(ran.mech!.activeEvent);
      expect(Array.from(jumped.mech!.zoneOn)).toEqual(Array.from(ran.mech!.zoneOn));
      for (const [x, y] of [[30, 5], [182, 4], [222, 4]] as const) {
        ran.mech!.envAt(x, y, env);
        jumped.mech!.envAt(x, y, env2);
        expect(env2).toEqual(env);
      }
    }
  });
});

describe('what events do', () => {
  it('an EMP storm grounds jetpacks only while it runs, not during its warning', () => {
    const { game, p } = makeGame(withEvents(timeline([{ id: 'emp', kind: 'emp', duration: 2, warning: 1 }], [{ at: 2, event: 'emp' }])));
    placeOnGround(game, p, 20);
    hold(game, p, 0, 60 - game.tick); // tick 60: the warning starts
    hold(game, p, Btn.Jet, 30);
    expect(p.y).toBeGreaterThan(1); // still flying in the warning
    hold(game, p, 0, 120 - game.tick);
    hold(game, p, Btn.Jet, 1); // tick 120: it starts
    expect(p.jetting).toBe(false);
    hold(game, p, Btn.Jet, 100);
    expect(p.y).toBeLessThan(0.01);
    hold(game, p, Btn.Jet, 30); // over at 240
    expect(p.y).toBeGreaterThan(0.5);
  });

  it('a gravity surge makes falls faster; low gravity slower', () => {
    const fall = (kind: MapEventDef['kind']) => {
      const { game, p } = makeGame(withEvents(timeline([{ id: 'e', kind, duration: 3, warning: 0 }], [{ at: 0, event: 'e' }])));
      p.y = 20;
      hold(game, p, 0, 20);
      return 20 - p.y;
    };
    const plain = (() => {
      const { game, p } = makeGame(flatMap());
      p.y = 20;
      hold(game, p, 0, 20);
      return 20 - p.y;
    })();
    expect(fall('gravitySurge') / plain).toBeCloseTo(1.8, 1);
    expect(fall('lowGravity') / plain).toBeCloseTo(0.35, 1);
  });

  it('fog cuts every bullet\'s range while it runs', () => {
    const mech = MapMechanics.compile(withEvents(timeline([{ id: 'fog', kind: 'fog', duration: 3, warning: 1 }], [{ at: 1, event: 'fog' }])))!;
    const reach = (tick: number) => {
      mech.beginTick(1, tick, []);
      mech.castBullet(0, 0, 1, 0);
      return mech.bulletReach(26);
    };
    expect(reach(30)).toBe(26); // warning
    expect(reach(60)).toBeCloseTo(26 * 0.4, 12);
    expect(reach(240)).toBe(26); // over
  });

  it('gusts swell from nothing to full and back; windFlip turns some occurrences around', () => {
    const mech = MapMechanics.compile(withEvents(timeline([{ id: 'g', kind: 'gust', duration: 4, warning: 0, gustPeriod: 2 }], [{ at: 0, event: 'g' }], 5)))!;
    const signs = new Set<number>();
    for (let lap = 0; lap < 12; lap++) {
      const t0 = lap * 300;
      mech.beginTick(7, t0, []);
      expect(mech.global.windX).toBeCloseTo(0, 9);
      mech.beginTick(7, t0 + 60, []); // half a period: full strength
      expect(Math.abs(mech.global.windX)).toBeCloseTo(16, 9);
      signs.add(Math.sign(mech.global.windX));
      mech.beginTick(7, t0 + 120, []);
      expect(mech.global.windX).toBeCloseTo(0, 9);
    }
    expect([...signs].sort()).toEqual([-1, 1]);
  });

  it('a gravity pocket switches on one of its zones per occurrence, and only while it runs', () => {
    const zones: MapZone[] = [
      { id: 'a', kind: 'reverseG', rect: [10, 0, 20, 8], event: 'pocket' },
      { id: 'b', kind: 'reverseG', rect: [30, 0, 40, 8], event: 'pocket' },
      { id: 'always', kind: 'lowG', rect: [50, 0, 60, 8] },
    ];
    const mech = MapMechanics.compile(withEvents(timeline([{ id: 'pocket', kind: 'flip', duration: 2, warning: 1 }], [{ at: 1, event: 'pocket' }], 4), zones))!;
    const picked = new Set<number>();
    for (let lap = 0; lap < 20; lap++) {
      const t0 = lap * 240;
      mech.beginTick(3, t0 + 30, []); // warning: neither on
      expect(Array.from(mech.zoneOn)).toEqual([0, 0, 1]);
      mech.beginTick(3, t0 + 90, []);
      const on = Array.from(mech.zoneOn);
      expect(on[0]! + on[1]!).toBe(1);
      picked.add(on[0] ? 0 : 1);
      const env = mech.envAt(on[0] ? 15 : 35, 4, createBodyEnv());
      expect(env.gravityMul).toBe(-0.6);
      expect(mech.envAt(on[0] ? 35 : 15, 4, env).gravityMul).toBe(1);
    }
    expect(picked.size).toBe(2);
  });

  it('the start announcement carries the picked zone and how long it lasts', () => {
    const zones: MapZone[] = [{ id: 'a', kind: 'reverseG', rect: [10, 0, 20, 8], event: 'p' }];
    const game = new Game({ map: withEvents(timeline([{ id: 'p', kind: 'flip', duration: 2, warning: 1 }], [{ at: 1, event: 'p' }]), zones) });
    const events = collect(game, 200);
    expect(events.map((e) => [e.tick, e.phase, e.zone, e.ticks])).toEqual([
      [0, MapEventPhase.Warning, 0, 60],
      [60, MapEventPhase.Start, 0, 120],
      [180, MapEventPhase.End, 0, 0],
    ]);
  });
});

describe('validating events', () => {
  const bad: [MapEvents, MapZone[], RegExp][] = [
    [timeline([{ id: 'a', kind: 'emp' }], [{ at: 5, event: 'nope' }]), [], /unknown event "nope"/],
    [timeline([{ id: 'a', kind: 'emp', duration: 4, warning: 1 }, { id: 'b', kind: 'fog', warning: 2 }], [{ at: 5, event: 'a' }, { at: 10, event: 'b' }]), [], /overlaps/],
    [timeline([{ id: 'a', kind: 'emp', duration: 4 }], [{ at: 5, event: 'a' }], 6), [], /loop/],
    [{ defs: [{ id: 'a', kind: 'emp', duration: 30 }], schedule: { kind: 'random', start: 0, cycle: 20 } }, [], /doesn't fit/],
    [{ defs: [{ id: 'a', kind: 'emp' }], schedule: { kind: 'random', start: 0, cycle: 60, weights: { a: 0 } } }, [], /no event has a weight/],
    [timeline([{ id: 'p', kind: 'flip' }], [{ at: 5, event: 'p' }]), [], /pickOneZone needs/],
    [timeline([{ id: 'a', kind: 'emp' }], [{ at: 5, event: 'a' }]), [{ id: 'z', kind: 'lowG', rect: [0, 0, 1, 1], event: 'b' }], /zone "z": unknown event "b"/],
    [timeline([{ id: 'a', kind: 'emp', gravityMul: 9 }], [{ at: 5, event: 'a' }]), [], /event "a": gravityMul/],
    [timeline([{ id: 'a', kind: 'emp', duration: 0 }], [{ at: 5, event: 'a' }]), [], /duration/],
    [timeline([{ id: 'a', kind: 'constructor' as MapEventDef['kind'] }], [{ at: 5, event: 'a' }]), [], /unknown kind "constructor"/],
    [{ defs: [{ id: 'a', kind: 'emp' }], schedule: { kind: 'later' } as unknown as MapEvents['schedule'] }, [], /unknown kind "later"/],
    [timeline(Array.from({ length: 33 }, (_, i) => ({ id: `e${i}`, kind: 'emp' as const })), []), [], /at most 32/],
  ];
  for (const [events, zones, msg] of bad) {
    it(`refuses: ${msg.source}`, () => {
      expect(() => new Game({ map: withEvents(events, zones) })).toThrow(msg);
    });
  }
});
