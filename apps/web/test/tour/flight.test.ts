import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@military-forge/sim';
import { defaultBindings } from '../../src/shell/controls';
import { nextDevice } from '../../src/tour/briefing';
import { FLIGHT_COPY, TOUR_COPY } from '../../src/tour/copy';
import { FactStore, type FactEvent } from '../../src/tour/facts';
import { FirstFlight, flightWasOpen, type FlightWorld } from '../../src/tour/firstFlight';
import { CONFIRM_MS, FIRST_FLIGHT, FLIGHT_GOALS, FlightTracker, HELP_AFTER_MS, goalView, markerPoint, nearest, type FlightGoalId } from '../../src/tour/flight';
import type { TourMemory } from '../../src/tour/index';
import { EventLog, type Device, type Logged } from '../../src/tour/log';
import { TOUR_KEY, Tour, loadTour, loadTours, saveTour, type TourStepDef } from '../../src/tour/tour';
import type { SpotStep, Spotlight } from '../../src/ui/spotlight';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('the tour model', () => {
  type Ctx = { grenades: number };
  const steps: TourStepDef<Ctx>[] = [
    { id: 'a', done: ['move'] },
    { id: 'b', done: ['hit-dummy'], count: 3 },
    { id: 'c', done: ['throw'], needs: (c) => c.grenades > 0 },
  ];
  const ctx = { grenades: 2 };

  it('ticks a step only on its own events, and counts', () => {
    const t = new Tour<Ctx>('t', steps);
    expect(t.act('dash', ctx)).toBe(false);
    expect(t.step?.id).toBe('a');
    expect(t.act('move', ctx)).toBe(true);
    expect(t.act('hit-dummy', ctx)).toBe(false);
    expect(t.act('hit-dummy', ctx)).toBe(false);
    expect(t.tally).toBe(2);
    expect(t.act('hit-dummy', ctx)).toBe(true);
    expect(t.position).toEqual([2, 3]);
    expect(t.act('throw', ctx)).toBe(true);
    expect(t.finished).toBe(true);
  });

  it('skips a step that cannot be done here, a step, or everything', () => {
    const t = new Tour<Ctx>('t', steps);
    t.act('move', ctx);
    t.skip(); // b
    expect(t.step?.id).toBe('c');
    expect(t.skipImpossible({ grenades: 0 })).toBe(true); // no grenades: c can't be done
    expect(t.finished).toBe(true);
    expect(t.toJSON()).toMatchObject({ done: ['a'], skipped: ['b', 'c'] });
    const w = new Tour<Ctx>('t', steps);
    w.setOpen(true);
    w.skip(true);
    expect(w.finished).toBe(true);
    expect(w.skippedAll).toBe(true);
    expect(w.toJSON()).toMatchObject({ skippedAll: true, open: false });
  });

  it('resumes from saved progress (unknown steps dropped) and restarts', () => {
    const t = new Tour<Ctx>('t', steps, { id: 't', done: ['a', 'gone'], skipped: [], skippedAll: false, open: true });
    expect(t.step?.id).toBe('b');
    expect(t.toJSON().done).toEqual(['a']);
    expect(new Tour<Ctx>('t', steps, { id: 'other', done: ['a'], skipped: [], skippedAll: false, open: true }).step?.id).toBe('a');
    t.restart();
    expect(t.step?.id).toBe('a');
  });

  it('saves per tour in mf.tour.v1; storage that throws or holds junk is ignored', () => {
    const s = new MemoryStorage();
    saveTour(s, { id: 'x', done: ['a'], skipped: [], skippedAll: false, open: true });
    saveTour(s, { id: 'y', done: [], skipped: [], skippedAll: true, open: false });
    expect(Object.keys(JSON.parse(s.getItem(TOUR_KEY)!))).toEqual(['x', 'y']);
    expect(loadTour(s, 'x')?.done).toEqual(['a']);
    s.setItem(TOUR_KEY, '[1,2]');
    expect(loadTours(s)).toEqual({});
    s.setItem(TOUR_KEY, '{nope');
    expect(loadTours(s)).toEqual({});
    const broken = { getItem: () => { throw new Error('private'); }, setItem: () => { throw new Error('private'); } };
    expect(() => saveTour(broken, { id: 'x', done: [], skipped: [], skippedAll: false, open: false })).not.toThrow();
    expect(loadTour(broken, 'x')).toBeNull();
  });
});

describe('First flight: the goals', () => {
  const devices: Device[] = ['keyboard', 'pad', 'touch'];

  it('five goals, run → fly → fire → dash → throw; three hits; Throw needs grenades', () => {
    expect(FLIGHT_GOALS.map((g) => g.id)).toEqual(['run', 'fly', 'hit', 'dash', 'throw']);
    expect(FLIGHT_GOALS.find((g) => g.id === 'hit')?.count).toBe(3);
    expect(FLIGHT_GOALS.find((g) => g.id === 'throw')?.needs?.({ grenades: 0 })).toBe(false);
  });

  it('keys come from the bindings by action; touch rings its controls and shows no caps', () => {
    expect(goalView('run', 'keyboard').keys).toEqual(['left', 'right']);
    expect(goalView('run', 'pad').keys).toEqual(['left']); // one stick
    expect(goalView('fly', 'keyboard')).toMatchObject({ keys: ['jet'], hud: 'fuel', marker: 'up', touch: null });
    expect(goalView('dash', 'keyboard')).toMatchObject({ hud: 'dash', touch: null });
    expect(goalView('throw', 'pad')).toMatchObject({ keys: ['grenade'], hud: 'belt', marker: 'target' });
    for (const g of FLIGHT_GOALS) expect(goalView(g.id, 'touch').keys).toEqual([]);
    expect(goalView('run', 'touch').touch).toBe('move');
    expect(goalView('hit', 'touch').touch).toBe('aim');
    expect(goalView('fly', 'touch')).toMatchObject({ touch: 'move', hud: 'fuel' });
  });

  it('copy: titles 1–3 words, bodies ≤ 12, no exclamation marks; touch follows the hand and the fire mode', () => {
    for (const g of FLIGHT_GOALS)
      for (const d of devices)
        for (const moveSide of ['left', 'right'] as const)
          for (const fire of ['auto', 'pull', 'button', 'release']) {
            const c = FLIGHT_COPY[g.id as FlightGoalId](d, { moveSide, fire });
            expect(words(c.title)).toBeLessThanOrEqual(3);
            expect(words(c.body)).toBeLessThanOrEqual(12);
            expect(`${c.title} ${c.body} ${c.help}`).not.toMatch(/!|awesome|great job|let's/i);
          }
    expect(goalView('run', 'touch', { moveSide: 'right', fire: 'hold' }).body).toContain('right dial');
    expect(goalView('hit', 'touch', { moveSide: 'left', fire: 'release' }).body).toContain('lift to fire');
    expect(goalView('hit', 'touch', { moveSide: 'right', fire: 'pull' }).body).toContain('left dial');
    expect(goalView('hit', 'touch', { moveSide: 'left', fire: 'auto' }).body).toContain('fires itself');
    expect(goalView('hit', 'touch', { moveSide: 'left', fire: 'button' })).toMatchObject({ touch: 'fire' });
  });

  it('the Briefing\'s Change cycles Touch, Keyboard and mouse, Controller', () => {
    expect([nextDevice('touch'), nextDevice('keyboard'), nextDevice('pad')]).toEqual(['keyboard', 'pad', 'touch']);
  });
});

describe('First flight: the tracker', () => {
  const at = (x: number, y = 0, grounded = true, alive = true) => ({ x, y, grounded, alive });

  it('Run after 3 m either way; Fly at 3.5 m over the lowest ground stood on', () => {
    const t = new FlightTracker();
    expect(t.frame(at(10))).toEqual([]); // not begun
    t.begin(at(10, 2));
    expect(t.frame(at(12.9, 2))).toEqual([]);
    expect(t.frame(at(6.9, 2))).toEqual(['move']);
    t.begin(at(0, 2));
    expect(t.frame(at(0, 0))).toEqual([]); // stepped down a ledge: the ground is 0 now
    expect(t.frame(at(0, 3.4, false))).toEqual([]);
    expect(t.frame(at(0, 3.5, false))).toEqual(['reach']);
    expect(t.frame(at(0, 9, false, false))).toEqual([]); // dead
  });

  it('the local player\'s hits on a target, dashes and throws', () => {
    const t = new FlightTracker();
    const ev: SimEvent[] = [
      { type: 'hit', attacker: 1, target: 5, damage: 10, zone: 0, source: 0 },
      { type: 'hit', attacker: 1, target: 2, damage: 10, zone: 0, source: 0 }, // not a target
      { type: 'hit', attacker: 3, target: 5, damage: 10, zone: 0, source: 0 }, // not mine
      { type: 'dash', player: 1, x: 0, y: 0, dir: 0 },
      { type: 'dash', player: 3, x: 0, y: 0, dir: 0 },
      { type: 'throw', owner: 1, grenade: 0 },
    ];
    expect(t.events(ev, 1, (id) => id === 5)).toEqual(['hit-dummy', 'dash', 'throw']);
  });

  it('markers: the run 4 m away from the targets (they end up in front), 4 m up; the nearest target', () => {
    expect(markerPoint('run', { x: 10, ground: 1 }, -1)).toEqual({ x: 14, y: 2 });
    expect(markerPoint('run', { x: 10, ground: 1 }, 1)).toEqual({ x: 6, y: 2 });
    expect(markerPoint('up', { x: 10, ground: 1 }, 1)).toEqual({ x: 11.5, y: 5 });
    expect(nearest([{ x: 20 }, { x: 4 }, { x: 13 }], 10)).toEqual({ x: 13 });
    expect(nearest([], 0)).toBeNull();
  });
});

// ---- the runner, with a fake range, spotlight and clock

function harness(storage = new MemoryStorage()) {
  const me = { id: 1, x: 0, y: 0, grounded: true, alive: true, grenades: 2 };
  const world: FlightWorld = { me, targets: [{ id: 5, x: 12, y: 0 }], isTarget: (id) => id === 5 };
  let now = 0;
  let covered = false;
  let device: Device = 'keyboard';
  const shown: SpotStep[] = [];
  const stamps: string[] = [];
  let hides = 0;
  const spot = {
    onSkip: null as ((id: string, all: boolean) => void) | null,
    onPrimary: null as ((id: string) => void) | null,
    current: null as SpotStep | null,
    show(s: SpotStep) {
      shown.push(s);
      this.current = s;
    },
    update() {},
    hide() {
      hides++;
      this.current = null;
      return Promise.resolve();
    },
    stamp(t: string) {
      stamps.push(t);
    },
    dispose() {},
  };
  const log = new EventLog(storage, () => 1000);
  const facts = new FactStore(storage, () => 1000);
  const memory = { log, facts, record: (e: Parameters<EventLog['record']>[0]) => log.record(e), fact: (e: FactEvent) => facts.apply(e) } as unknown as TourMemory;
  const went: string[] = [];
  const flight = new FirstFlight({
    memory,
    storage,
    world: () => world,
    toScreen: (x, y) => ({ x: x * 10, y: 500 - y * 10 }),
    device: () => device,
    // a pad's shown bindings (gamepad/prompts.ts) carry pad codes
    bindings: () => (device === 'pad' ? { ...defaultBindings(), left: ['PadLS'], right: [], jet: ['Pad6'], dash: ['Pad5'] } : defaultBindings()),
    cap: (c) => c.replace(/^Key|Left$/g, ''),
    touchWords: () => ({ moveSide: 'left', fire: 'auto' }),
    touchRect: () => null,
    covered: () => covered,
    liveFire: () => went.push('live-fire'),
    home: () => went.push('home'),
    clock: () => now,
    spotlight: spot as unknown as Spotlight,
  });
  const tick = (ms = 16) => {
    now += ms;
    flight.frame();
  };
  const last = () => shown[shown.length - 1]!;
  const steps = () => (log.entries() as Logged[]).filter((e) => e.t === 'tour.step').map((e) => (e.t === 'tour.step' ? `${e.step}:${e.status}` : ''));
  return { flight, me, world, spot, shown, stamps, last, tick, log, facts, went, steps, storage, setCovered: (c: boolean) => (covered = c), setDevice: (d: Device) => (device = d), hides: () => hides };
}

describe('First flight: the runner', () => {
  it('runs the five goals by doing them, stamps each, and offers Live fire at the end', () => {
    const h = harness();
    h.tick();
    expect(h.last()).toMatchObject({ id: 'first-flight:run', title: 'Run.', keys: ['A', 'D'], block: 'none', eyebrow: TOUR_COPY.orders(1, 5), progress: [0, 5] });
    h.me.x = 3.1;
    h.tick();
    expect(h.stamps).toEqual(['Confirmed']);
    expect(h.last().progress).toEqual([1, 5]);
    h.tick(CONFIRM_MS);
    expect(h.last()).toMatchObject({ id: 'first-flight:fly', keys: ['W'] });
    h.me.y = 3.6;
    h.me.grounded = false;
    h.tick();
    h.tick(CONFIRM_MS);
    expect(h.last().id).toBe('first-flight:hit');
    const hit: SimEvent = { type: 'hit', attacker: 1, target: 5, damage: 10, zone: 0, source: 0 };
    h.flight.onEvents([hit], 1);
    expect(h.last().body).toContain('1/3');
    h.flight.onEvents([hit, hit], 1);
    h.tick(CONFIRM_MS);
    expect(h.last()).toMatchObject({ id: 'first-flight:dash', keys: ['Shift'] });
    h.flight.onEvents([{ type: 'dash', player: 1, x: 0, y: 0, dir: 0 }], 1);
    h.tick(CONFIRM_MS);
    h.flight.onEvents([{ type: 'throw', owner: 1, grenade: 0 }], 1);
    h.tick(CONFIRM_MS);
    expect(h.last()).toMatchObject({ id: 'first-flight:done', primary: { label: 'Live fire' }, skipLabel: 'Later' });
    expect(h.steps()).toEqual(['run:shown', 'run:done', 'fly:shown', 'fly:done', 'hit:shown', 'hit:done', 'dash:shown', 'dash:done', 'throw:shown', 'throw:done']);
    expect(h.log.entries().find((e) => e.t === 'tour.end')).toMatchObject({ result: 'finished' });
    expect(h.facts.get().tours[FIRST_FLIGHT]).toMatchObject({ finished: true, done: ['run', 'fly', 'hit', 'dash', 'throw'] });
    expect(h.facts.get().promoted).toBe(true); // well under 40 s
    expect(flightWasOpen(h.storage)).toBe(false);
    h.spot.onPrimary?.('first-flight:done');
    expect(h.went).toEqual(['live-fire']);
  });

  it('a pad picked up mid-goal: the same goal, now in its glyphs (no travel, no new log line)', () => {
    const h = harness();
    h.tick();
    expect(h.last().keys).toEqual(['A', 'D']);
    h.setDevice('pad');
    h.tick();
    expect(h.last()).toMatchObject({ id: 'first-flight:run', keys: ['PadLS'] });
    h.setDevice('touch');
    h.tick();
    expect(h.last()).toMatchObject({ id: 'first-flight:run', keys: [], body: 'Drag the left dial. Reach the marker.' });
    expect(h.steps()).toEqual(['run:shown']);
  });

  it('nothing moves on by itself: after 20 s it only offers help (logged once)', () => {
    const h = harness();
    for (let i = 0; i < 100; i++) h.tick(600);
    expect(h.last()).toMatchObject({ id: 'first-flight:run', timeoutMs: HELP_AFTER_MS });
    expect(h.steps()).toEqual(['run:shown', 'run:timeout-offered']);
  });

  it('waits under a menu and comes back; a reload resumes at the next goal', () => {
    const h = harness();
    h.tick();
    h.me.x = 4;
    h.tick();
    h.tick(CONFIRM_MS);
    h.setCovered(true);
    h.tick();
    expect(h.hides()).toBe(1);
    const n = h.shown.length;
    h.tick();
    expect(h.shown.length).toBe(n);
    h.setCovered(false);
    h.tick();
    expect(h.last().id).toBe('first-flight:fly');
    expect(flightWasOpen(h.storage)).toBe(true);
    // the page reloads: a new runner on the same storage starts at Fly
    const again = harness(h.storage);
    again.tick();
    expect(again.last().id).toBe('first-flight:fly');
  });

  it('Skip this, Skip training, and leaving part-way', () => {
    const h = harness();
    h.tick();
    h.spot.onSkip?.('first-flight:run', false);
    h.tick();
    expect(h.last().id).toBe('first-flight:fly');
    h.spot.onSkip?.('first-flight:fly', true);
    expect(h.went).toEqual(['home']);
    expect(h.steps()).toEqual(['run:shown', 'run:skipped', 'fly:shown', 'fly:skipped']);
    expect(h.log.entries().find((e) => e.t === 'tour.end')).toMatchObject({ result: 'skipped-all' });
    expect(h.facts.get().tours[FIRST_FLIGHT]?.skipped).toBe(true);
    expect(flightWasOpen(h.storage)).toBe(false);

    const g = harness();
    g.tick();
    g.flight.dispose();
    expect(g.steps()).toEqual(['run:shown', 'run:abandoned']);
    expect(g.log.entries().find((e) => e.t === 'tour.end')).toMatchObject({ result: 'abandoned' });
    expect(flightWasOpen(g.storage)).toBe(false);
  });

  it('no grenades: Throw skips itself; Restart goes back to Run', () => {
    const h = harness();
    h.me.grenades = 0;
    h.tick();
    for (const go of [() => (h.me.x = 4), () => ((h.me.y = 4), (h.me.grounded = false))]) {
      go();
      h.tick();
      h.tick(CONFIRM_MS);
    }
    h.flight.onEvents(Array(3).fill({ type: 'hit', attacker: 1, target: 5, damage: 10, zone: 0, source: 0 }), 1);
    h.tick(CONFIRM_MS);
    h.flight.onEvents([{ type: 'dash', player: 1, x: 0, y: 0, dir: 0 }], 1);
    h.tick(CONFIRM_MS);
    expect(h.last().id).toBe('first-flight:done');
    expect(loadTour(h.storage, FIRST_FLIGHT)?.skipped).toEqual(['throw']);
    h.flight.restart();
    h.tick();
    expect(h.last().id).toBe('first-flight:run');
  });
});
