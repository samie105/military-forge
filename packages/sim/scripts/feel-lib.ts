/**
 * Shared feel measurements (docs/02 §19): run the real sim with scripted inputs and return
 * objective numbers. Used by `feel` (report) and `tune` (target-driven parameter sweep).
 */
import { BUZZ, DEFAULT_LOADOUT, HAMMER, weapons, type MapDef, type Tuning, type WeaponDef } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { Btn, Game, createInput, type Input, type PlayerState } from '../src';

function flat(width = 400, ceiling = 60): MapDef {
  const rect = (x0: number, y0: number, x1: number, y1: number) => ({ points: [x0, y0, x1, y0, x1, y1, x0, y1] });
  return {
    id: 'feel-flat',
    name: 'feel',
    bounds: { minX: -2, minY: -6, maxX: width + 2, maxY: ceiling + 2 },
    solids: [rect(-2, -6, width + 2, 0), rect(-2, 0, 0, ceiling), rect(width, 0, width + 2, ceiling), rect(-2, ceiling, width + 2, ceiling + 2)],
    oneWays: [],
    spawns: [{ x: 10, y: 0 }],
    dummies: [],
    labels: [],
  };
}

function setup(tuning: Partial<Tuning>, seed = 1): { game: Game; p: PlayerState; step: (buttons: number, aimRad?: number) => void } {
  const game = new Game({ map: flat(), seed, tuning });
  const p = game.addPlayer('probe');
  const input: Input = createInput();
  const inputs: (Input | undefined)[] = [];
  inputs[p.id] = input;
  const step = (buttons: number, aimRad = 0) => {
    input.buttons = buttons;
    input.aim = angleToU16(aimRad);
    game.step(inputs);
  };
  for (let i = 0; i < 10; i++) step(0);
  return { game, p, step };
}

export interface MovementMetrics {
  /** max height reached holding jet from the ground with a full tank (m) */
  climb: number;
  /** seconds until the tank is empty while holding jet */
  burn: number;
  /** take-off to landing (s) */
  airtime: number;
  /** ground refill from an empty tank to full, including the regen delay (s) */
  refill: number;
  /** jet + run right until landing (m) */
  jetRun: number;
  /** seconds spent above 3 m by feathering the jet: the best of several tap rhythms */
  hover: number;
  /** apex of a 0.2 s jet tap from standing (m) */
  tapHop: number;
  /** seconds from pressing jet on the ground to 2 m up */
  to2m: number;
  /** ms to reach walk speed */
  toWalk: number;
  /** stop distance from walk speed (m) */
  stop: number;
}

export function measureMovement(tuning: Partial<Tuning> = {}): MovementMetrics {
  const m: MovementMetrics = { climb: 0, burn: 0, airtime: 0, refill: 0, jetRun: 0, hover: 0, tapHop: 0, to2m: 0, toWalk: 0, stop: 0 };
  {
    const { p, step } = setup(tuning);
    let t = 0;
    let emptyAt = -1;
    while (t < 900) {
      step(Btn.Jet);
      t++;
      m.climb = Math.max(m.climb, p.y);
      if (m.to2m === 0 && p.y >= 2) m.to2m = t / 60;
      if (emptyAt < 0 && p.fuel <= 0) emptyAt = t;
      if (emptyAt > 0 && p.grounded) break;
    }
    m.burn = emptyAt / 60;
    m.airtime = t / 60;
  }
  {
    // from empty, standing: what a player waits after burning the whole tank and landing
    const { p, step, game } = setup(tuning);
    p.fuel = 0;
    p.fuelRegenDelay = Math.round(game.tuning.fuelRegenDelayAir * 60); // just stopped jetting
    let refill = 0;
    while (p.fuel < game.tuning.fuelMax - 0.01 && refill < 1800) {
      step(0);
      refill++;
    }
    m.refill = refill / 60;
  }
  {
    const { p, step } = setup(tuning);
    for (let t = 0; t < 120 && (t < 12 || !p.grounded); t++) {
      step(t < 12 ? Btn.Jet : 0);
      m.tapHop = Math.max(m.tapHop, p.y);
    }
  }
  {
    const { p, step } = setup(tuning);
    const x0 = p.x;
    let t = 0;
    while (t < 1200) {
      step(p.fuel > 0 ? Btn.Jet | Btn.Right : Btn.Right);
      t++;
      if (t > 30 && p.grounded) break;
    }
    m.jetRun = p.x - x0;
  }
  // Hover: a skilled player feathers to stay up as long as possible. Try a spread of rhythms
  // (height bands with different fall-speed triggers, and fixed on/off tap patterns) and keep the best.
  const rhythms: ((p: PlayerState, t: number) => boolean)[] = [
    ...[3.5, 4, 5].flatMap((lo) => [-0.5, -1, -2].map((vyMin) => (p: PlayerState) => p.y < lo || p.vy < vyMin)),
    ...[
      [2, 2],
      [3, 3],
      [4, 4],
      [6, 6],
    ].map(([on, off]) => (p: PlayerState, t: number) => p.y < 3.5 || t % (on! + off!) < on!),
  ];
  for (const rhythm of rhythms) {
    const { p, step } = setup(tuning);
    let t = 0;
    let above = 0;
    while (t < 1800) {
      step(rhythm(p, t) ? Btn.Jet : 0);
      t++;
      if (p.y > 3) above++;
      if (t > 120 && p.grounded) break;
    }
    m.hover = Math.max(m.hover, above / 60);
  }
  {
    const { p, step, game } = setup(tuning);
    let t = 0;
    while (p.vx < game.tuning.walkMax - 0.01 && t < 60) {
      step(Btn.Right);
      t++;
    }
    m.toWalk = (t / 60) * 1000;
    const x0 = p.x;
    t = 0;
    while (p.vx > 0 && t < 60) {
      step(0);
      t++;
    }
    m.stop = p.x - x0;
  }
  return m;
}

export interface FireResult {
  /** mean seconds to kill (a target that survives counts as the 10 s cap) */
  ttk: number;
  /** bullets/pellets (or swings) that hit ÷ fired */
  hitRate: number;
  /** samples where the target died within 10 s */
  killRate: number;
}

/**
 * TTK + hit rate vs a standing dummy, re-aiming at the torso every tick, averaged over `samples`
 * seeds. `weapon` is a weapon index: the default loadout's guns are measured from their own slot
 * (so their numbers stay comparable across tuning passes); any other weapon replaces slot 0.
 * Pellets count individually. Melee weapons swing (Fire) instead of shooting.
 */
export function measureWeapon(weapon: number, distance: number, airborne: boolean, tuning: Partial<Tuning> = {}, samples = 20): FireResult {
  const def = weapons[weapon]!;
  const slot = DEFAULT_LOADOUT.indexOf(weapon);
  const semi = def.fireMode !== 'auto';
  let ttkSum = 0;
  let rateSum = 0;
  let killed = 0;
  for (let s = 1; s <= samples; s++) {
    const { game, p, step } = setup(tuning, s * 7919);
    if (slot < 0) game.setLoadout(p, [weapon, DEFAULT_LOADOUT[1]]);
    const d = game.addDummy({ name: 'target', x: p.x + distance, y: 0, script: { kind: 'idle' } });
    for (let i = 0; i < 5; i++) step(0);
    if (slot === 1) {
      step(Btn.Swap);
      for (let i = 0; i < 20; i++) step(0);
    }
    let shots = 0;
    let hits = 0;
    let t = 0;
    let firing = false;
    while (d.alive && t < 600) {
      const aim = Math.atan2(d.y + 0.7 - p.shoulderY(game.tuning), d.x - p.shoulderX(game.tuning));
      // hold the range against recoil push (nothing else moves the shooter sideways)
      const drift = p.x - (d.x - distance);
      const steer = def.fireMode === 'melee' ? 0 : drift < -0.25 ? Btn.Right : drift > 0.25 ? Btn.Left : 0;
      // semi-auto and melee alternate press/release so every other tick is a fresh trigger pull
      step((airborne && p.y < 1.5 ? Btn.Jet : 0) | (semi && firing ? 0 : Btn.Fire) | steer, aim);
      firing = semi ? !firing : false;
      for (const e of game.events) {
        if (e.type === 'shot' && e.shooter === p.id) shots++;
        if (e.type === 'hit' && e.attacker === p.id) hits++;
      }
      if (def.fireMode === 'melee' && p.meleeTicks === 1) shots++;
      t++;
    }
    if (!d.alive) killed++;
    ttkSum += t / 60;
    rateSum += shots ? hits / shots : 0;
  }
  return { ttk: ttkSum / samples, hitRate: rateSum / samples, killRate: killed / samples };
}

export type SpreadOverride = Partial<WeaponDef['spread']>;

/** Temporarily patches weapon spread for a measurement (scripts only; restores afterwards). */
export function withSpread<T>(overrides: { hammer?: SpreadOverride; buzz?: SpreadOverride }, fn: () => T): T {
  const saved = { hammer: { ...HAMMER.spread }, buzz: { ...BUZZ.spread } };
  Object.assign(HAMMER.spread, overrides.hammer ?? {});
  Object.assign(BUZZ.spread, overrides.buzz ?? {});
  try {
    return fn();
  } finally {
    Object.assign(HAMMER.spread, saved.hammer);
    Object.assign(BUZZ.spread, saved.buzz);
  }
}

export interface GrenadeMetrics {
  firstBounce: number;
  detonation: number;
}

export function measureGrenade(tuning: Partial<Tuning> = {}): GrenadeMetrics {
  const { game, p, step } = setup(tuning);
  step(Btn.Grenade, Math.PI / 4);
  const g = game.grenades.find((x) => x.alive)!;
  let firstLandX = NaN;
  let prevVy = g.vy;
  let detonation = NaN;
  for (let i = 0; i < 200 && g.alive; i++) {
    const x = g.x;
    step(0);
    if (Number.isNaN(firstLandX) && prevVy < 0 && g.vy > prevVy + 1) firstLandX = x;
    prevVy = g.vy;
    const ex = game.events.find((e) => e.type === 'explosion');
    if (ex && ex.type === 'explosion') detonation = ex.x;
  }
  return { firstBounce: firstLandX - p.x, detonation: detonation - p.x };
}
