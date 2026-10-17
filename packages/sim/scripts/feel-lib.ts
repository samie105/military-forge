/**
 * Shared feel measurements (docs/02 §19): run the real sim with scripted inputs and return
 * objective numbers. Used by `feel` (report) and `tune` (target-driven parameter sweep).
 */
import {
  BUZZ,
  DEFAULT_LOADOUT,
  HAMMER,
  RIOT_SHIELD,
  defaultTuning,
  weapons,
  type MapDef,
  type MapEventKind,
  type MapZone,
  type Tuning,
  type WeaponDef,
  type ZoneKind,
} from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { Btn, Game, SHIELD_RAISE_TICKS, createInput, giveShield, type Input, type PlayerState } from '../src';

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

function setup(tuning: Partial<Tuning>, seed = 1, map: MapDef = flat()): { game: Game; p: PlayerState; step: (buttons: number, aimRad?: number) => void } {
  const game = new Game({ map, seed, tuning });
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

export interface BlastMetrics {
  /** horizontal flight of a standing survivor, take-off to landing (m) */
  flew: number;
  /** highest point of that flight (m) */
  peak: number;
  hpLeft: number;
}

/** A frag going off on the floor `distance` metres from a standing player (docs/02 §14 knockback). */
export function measureBlast(distance: number, tuning: Partial<Tuning> = {}): BlastMetrics {
  const { game, p } = setup(tuning);
  const thrower = game.addPlayer('thrower');
  thrower.x = p.x + 150;
  const x0 = p.x;
  const g = game.allocGrenade()!;
  Object.assign(g, { alive: true, owner: thrower.id, x: x0 - distance, y: 0.15, vx: 0, vy: 0, fuse: 1 / 60 });
  let peak = 0;
  for (let t = 0; t < 600; t++) {
    game.step([]);
    peak = Math.max(peak, p.y);
    if (t > 3 && p.grounded && Math.abs(p.vx) < 0.05) break;
  }
  return { flew: p.x - x0, peak, hpLeft: p.hp };
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

// ---------- map zones (docs/02 §20) ----------

/** The feel map with one zone of `kind` (its defaults, plus `extra`) over `rect` (default: all of it). */
function zoned(kind: ZoneKind, rect: [number, number, number, number] = [-2, -6, 402, 62], extra: Partial<MapZone> = {}): MapDef {
  return { ...flat(), zones: [{ id: kind, kind, rect, ...extra }] };
}

export interface ZoneMetrics {
  /** low-g zone: full-tank climb from the ground (m) */
  lowGClimb: number;
  /** low-g zone: apex of a 0.2 s jet tap (m) */
  lowGTapHop: number;
  /** zero-g zone: speed 1 s after a 0.2 s jet tap from the ground (m/s) */
  zeroGDrift: number;
  /** zero-g zone: seconds of holding Down to turn that drift around */
  zeroGDiveTurn: number;
  /** long-flight zone: seconds until a held jet empties the tank */
  longFlightBurn: number;
  /** long-flight zone: jet + run distance on one tank (m) */
  longFlightRun: number;
  /** reversed-gravity pocket (8 m tall): seconds until the bob at its top edge stays within ±0.5 m */
  reverseSettle: number;
  /** wind zone: sideways drift during a 1 s fall from rest (m) */
  windDrift: number;
  /** mud: walk speed (m/s) */
  mudSpeed: number;
  /** deep water: sink speed after 1 s from rest (m/s) */
  waterSink: number;
  /** jump pad: feet apex from standing on it (m) */
  jumpPadApex: number;
  /** boost pad: flight from a running start, take-off to landing (m) */
  boostPadFlight: number;
  /** bullet fog: how far each weapon's bullets carry with 10 m of fog starting 5 m out (m) */
  fogReach: Record<string, number>;
}

export function measureZones(tuning: Partial<Tuning> = {}): ZoneMetrics {
  const m: ZoneMetrics = {
    lowGClimb: 0,
    lowGTapHop: 0,
    zeroGDrift: 0,
    zeroGDiveTurn: 0,
    longFlightBurn: 0,
    longFlightRun: 0,
    reverseSettle: 0,
    windDrift: 0,
    mudSpeed: 0,
    waterSink: 0,
    jumpPadApex: 0,
    boostPadFlight: 0,
    fogReach: {},
  };
  {
    const { p, step } = setup(tuning, 1, zoned('lowG'));
    for (let t = 0; t < 1200 && !(t > 30 && p.grounded); t++) {
      step(p.fuel > 0 ? Btn.Jet : 0);
      m.lowGClimb = Math.max(m.lowGClimb, p.y);
    }
  }
  {
    const { p, step } = setup(tuning, 1, zoned('lowG'));
    for (let t = 0; t < 600 && (t < 12 || !p.grounded); t++) {
      step(t < 12 ? Btn.Jet : 0);
      m.lowGTapHop = Math.max(m.lowGTapHop, p.y);
    }
  }
  {
    const { p, step } = setup(tuning, 1, zoned('zeroG'));
    for (let t = 0; t < 12; t++) step(Btn.Jet);
    for (let t = 0; t < 60; t++) step(0);
    m.zeroGDrift = Math.hypot(p.vx, p.vy);
    let t = 0;
    while (p.vy > 0 && t < 600) {
      step(Btn.Down);
      t++;
    }
    m.zeroGDiveTurn = t / 60;
  }
  {
    const { p, step } = setup(tuning, 1, zoned('longFlight'));
    let t = 0;
    while (p.fuel > 0 && t < 1800) {
      step(Btn.Jet);
      t++;
    }
    m.longFlightBurn = t / 60;
  }
  {
    const { p, step } = setup(tuning, 1, zoned('longFlight'));
    const x0 = p.x;
    for (let t = 0; t < 2400 && !(t > 30 && p.grounded); t++) step(p.fuel > 0 ? Btn.Jet | Btn.Right : Btn.Right);
    m.longFlightRun = p.x - x0;
  }
  {
    const { p, step } = setup(tuning, 1, zoned('reverseG', [-2, -6, 402, 8]));
    let calmSince = -1;
    for (let t = 0; t < 1800; t++) {
      step(0);
      const off = Math.abs(p.y + 0.75 - 8);
      if (off > 0.5) calmSince = -1;
      else if (calmSince < 0) calmSince = t;
    }
    m.reverseSettle = calmSince < 0 ? Infinity : calmSince / 60;
  }
  {
    const { p, step } = setup(tuning, 1, zoned('wind'));
    p.y = 30;
    p.grounded = false;
    const x0 = p.x;
    for (let t = 0; t < 60; t++) step(0);
    m.windDrift = p.x - x0;
  }
  {
    const { p, step } = setup(tuning, 1, zoned('slow', [-2, -6, 402, 2]));
    for (let t = 0; t < 60; t++) step(Btn.Right);
    m.mudSpeed = p.vx;
  }
  {
    const { p, step } = setup(tuning, 1, zoned('water', [-2, -6, 402, 40]));
    p.y = 30;
    p.grounded = false;
    for (let t = 0; t < 60; t++) step(0);
    m.waterSink = -p.vy;
  }
  {
    const { p, step } = setup(tuning, 1, zoned('jumpPad', [8, 0, 12, 1.2]));
    for (let t = 0; t < 120; t++) {
      step(0);
      m.jumpPadApex = Math.max(m.jumpPadApex, p.y);
    }
  }
  {
    const { p, step } = setup(tuning, 1, zoned('boostPad', [20, 0, 22, 1.2]));
    while (p.grounded) step(Btn.Right);
    const x0 = p.x;
    for (let t = 0; t < 600 && !p.grounded; t++) step(0);
    m.boostPadFlight = p.x - x0;
  }
  for (const w of weapons) {
    if (w.fireMode === 'melee') continue;
    const { game, p, step } = setup(tuning, 1, zoned('damping', [p0x(5), -6, p0x(15), 62]));
    if (DEFAULT_LOADOUT.indexOf(w.index) !== 0) game.setLoadout(p, [w.index, DEFAULT_LOADOUT[1]]);
    step(Btn.Fire, 0);
    const shot = game.events.find((e) => e.type === 'shot');
    m.fogReach[w.name] = shot && shot.type === 'shot' ? Math.hypot(shot.ex - p.shoulderX(game.tuning), shot.ey - p.shoulderY(game.tuning)) : NaN;
  }
  return m;
}

/** x of a point `d` metres in front of the probe's shoulder (setup() leaves it at x 10, facing right). */
function p0x(d: number): number {
  return 10.08 + d;
}

// ---------- map events (docs/02 §20.7) ----------

/** The feel map with one event of `kind` (its defaults) running from the first tick for 20 s. */
function during(kind: MapEventKind): MapDef {
  return { ...flat(), events: { defs: [{ id: kind, kind, warning: 0, duration: 20 }], schedule: { kind: 'timeline', entries: [{ at: 0, event: kind }] } } };
}

export interface EventMetrics {
  /** gravity surge: full-tank climb (m) */
  surgeClimb: number;
  /** low gravity: apex of a 0.2 s jet tap (m) */
  lowGravityTapHop: number;
  /** fog bank: Hammer reach in the open (m) */
  fogHammerReach: number;
  /** wind gusts: sideways drift of a 1 s fall timed around a gust's peak (m) */
  gustDrift: number;
}

export function measureEvents(tuning: Partial<Tuning> = {}): EventMetrics {
  const m: EventMetrics = { surgeClimb: 0, lowGravityTapHop: 0, fogHammerReach: 0, gustDrift: 0 };
  {
    const { p, step } = setup(tuning, 1, during('gravitySurge'));
    for (let t = 0; t < 900 && !(t > 30 && p.grounded); t++) {
      step(p.fuel > 0 ? Btn.Jet : 0);
      m.surgeClimb = Math.max(m.surgeClimb, p.y);
    }
  }
  {
    const { p, step } = setup(tuning, 1, during('lowGravity'));
    for (let t = 0; t < 600 && (t < 12 || !p.grounded); t++) {
      step(t < 12 ? Btn.Jet : 0);
      m.lowGravityTapHop = Math.max(m.lowGravityTapHop, p.y);
    }
  }
  {
    const { game, p, step } = setup(tuning, 1, during('fog'));
    step(Btn.Fire, 0);
    const shot = game.events.find((e) => e.type === 'shot');
    m.fogHammerReach = shot && shot.type === 'shot' ? Math.hypot(shot.ex - p.shoulderX(game.tuning), shot.ey - p.shoulderY(game.tuning)) : NaN;
  }
  {
    // setup() spends 10 ticks settling; the 3 s gust peaks 1.5 s in: fall from 1 s to 2 s
    const { p, step } = setup(tuning, 1, during('gust'));
    for (let t = 10; t < 60; t++) step(0);
    p.y = 30;
    p.grounded = false;
    const x0 = p.x;
    for (let t = 0; t < 60; t++) step(0);
    m.gustDrift = Math.abs(p.x - x0);
  }
  return m;
}

// ---------- dash (docs/02 §21) ----------

export interface DashMetrics {
  /** standing, a dash with no direction (along the facing): ground covered until stopped (m) */
  flat: number;
  /** standing, an up-dash (Jet held on the press only): height reached (m) */
  up: number;
  /** standing, an up-right dash: height and distance at the apex (m) */
  diagUp: number;
  diagRun: number;
  /** from a 6 m hover, ticks to land with a down-dash vs falling (s) */
  slamTime: number;
  fallTime: number;
  /** a dash at a wall 1 m away: distance covered (m), ≤ 1 m minus the capsule radius */
  wallStop: number;
  /** seconds the burst lasts, for the animation */
  burst: number;
}

export function measureDash(tuning: Partial<Tuning> = {}): DashMetrics {
  const m: DashMetrics = { flat: 0, up: 0, diagUp: 0, diagRun: 0, slamTime: 0, fallTime: 0, wallStop: 0, burst: 0 };
  {
    const { p, step } = setup(tuning);
    const x0 = p.x;
    step(Btn.Dash);
    for (let t = 0; t < 120 && (p.vx !== 0 || !p.grounded); t++) step(0);
    m.flat = p.x - x0;
  }
  {
    const { p, step } = setup(tuning);
    step(Btn.Dash | Btn.Jet);
    for (let t = 0; t < 120 && !(t > 5 && p.grounded); t++) {
      step(0);
      m.up = Math.max(m.up, p.y);
    }
  }
  {
    const { p, step } = setup(tuning);
    const x0 = p.x;
    step(Btn.Dash | Btn.Jet | Btn.Right);
    for (let t = 0; t < 120 && !(t > 5 && p.grounded); t++) {
      step(0);
      if (p.y > m.diagUp) {
        m.diagUp = p.y;
        m.diagRun = p.x - x0;
      }
    }
  }
  for (const slam of [true, false]) {
    const { p, step } = setup(tuning);
    p.y = 6;
    p.vy = 0;
    p.grounded = false;
    let t = 0;
    step(slam ? Btn.Dash | Btn.Down : 0);
    while (!p.grounded && t < 300) {
      step(0);
      t++;
    }
    if (slam) m.slamTime = (t + 1) / 60;
    else m.fallTime = (t + 1) / 60;
  }
  {
    const map = flat();
    map.solids.push({ points: [11.32, 0, 12, 0, 12, 4, 11.32, 4] }); // a wall face 1 m right of the probe's capsule
    const { p, step } = setup(tuning, 1, map);
    const x0 = p.x;
    step(Btn.Dash);
    for (let t = 0; t < 30; t++) step(0);
    m.wallStop = p.x - x0;
  }
  m.burst = (tuning.dashBurstTicks ?? defaultTuning.dashBurstTicks) / 60;
  return m;
}

export interface ShieldFireResult {
  /** mean seconds to kill the carrier (one that survives counts as the 20 s cap) */
  ttk: number;
  /** mean seconds until the shield broke, over the samples where it did (NaN: never) */
  breakAt: number;
  /** samples where the shield broke (the rest died with it up, hit around it, or survived) */
  breakRate: number;
  /** bullets/pellets that struck the shield ÷ fired */
  shieldRate: number;
  /** samples where the carrier died within 20 s */
  killRate: number;
}

/**
 * How the carrier stands: `front` faces the shooter with the shield up (the bullets must wear it
 * down first); `flank` faces away with it up (its back is bare); `back` faces away with it slung,
 * so the shield on its back takes the bullets.
 */
export type ShieldStance = 'front' | 'flank' | 'back';

/**
 * A shooter against a riot-shield carrier holding a Hammer `distance` metres away, both grounded,
 * the shooter re-aiming at the carrier's torso every tick (no aiming over or under the shield).
 * Averaged over `samples` seeds.
 */
export function measureShield(weapon: number, distance: number, stance: ShieldStance, tuning: Partial<Tuning> = {}, samples = 10): ShieldFireResult {
  const def = weapons[weapon]!;
  const semi = def.fireMode !== 'auto';
  const CAP = 1200;
  let ttkSum = 0;
  let breakSum = 0;
  let breaks = 0;
  let rateSum = 0;
  let killed = 0;
  for (let s = 1; s <= samples; s++) {
    const game = new Game({ map: flat(), seed: s * 7919, tuning });
    const p = game.addPlayer('probe');
    const c = game.addPlayer('carrier');
    game.setLoadout(p, [weapon, weapon === HAMMER.index ? BUZZ.index : HAMMER.index]);
    c.x = p.x + distance;
    const inputs: (Input | undefined)[] = [];
    const pin: Input = createInput();
    const cin: Input = { ...createInput(), aim: angleToU16(stance === 'front' ? Math.PI : 0) };
    inputs[p.id] = pin;
    inputs[c.id] = cin;
    for (let i = 0; i < 10; i++) game.step(inputs);
    giveShield(c, RIOT_SHIELD.hp);
    c.shieldStowed = stance === 'back';
    for (let i = 0; i < SHIELD_RAISE_TICKS + 5; i++) game.step(inputs);
    let shots = 0;
    let onShield = 0;
    let t = 0;
    let firing = false;
    while (c.alive && t < CAP) {
      pin.aim = angleToU16(Math.atan2(c.y + 0.7 - p.shoulderY(game.tuning), c.x - p.shoulderX(game.tuning)));
      pin.buttons = semi && firing ? 0 : Btn.Fire;
      firing = semi ? !firing : false;
      game.step(inputs);
      for (const e of game.events) {
        if (e.type === 'shot' && e.shooter === p.id) {
          shots++;
          if (e.hit === 3) onShield++;
        }
        if (e.type === 'shieldBreak' && e.owner === c.id) {
          breakSum += t / 60;
          breaks++;
        }
      }
      t++;
    }
    if (!c.alive) killed++;
    ttkSum += t / 60;
    rateSum += shots ? onShield / shots : 0;
  }
  return { ttk: ttkSum / samples, breakAt: breaks ? breakSum / breaks : Number.NaN, breakRate: breaks / samples, shieldRate: rateSum / samples, killRate: killed / samples };
}
