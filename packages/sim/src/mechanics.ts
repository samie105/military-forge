/**
 * Map mechanics (docs/02 §20): map-wide rules, zones and scheduled map events.
 *
 * Compiled once per Game. A map with no rules, zones or events gets no MapMechanics at all
 * (Game.mech === null) and runs exactly the code it ran before, so its replays keep their hashes.
 *
 * Nothing here is authoritative state. The event schedule is a pure function of the room seed and
 * the tick (mapEvents.ts), and a zone's effect a pure function of position, so a client predicting
 * its own player (a Game with the same map, seed and tick numbering) gets every effect
 * bit-identical, with nothing new on the wire.
 */
import {
  MAX_LAUNCH,
  MODIFIER_FIELDS,
  ZONE_KINDS,
  isNeutral,
  resolveEvent,
  resolveModifiers,
  resolveZone,
  zonePoints,
  type MapDef,
  type MapModifiers,
  type ResolvedModifiers,
  type Tuning,
} from '@military-forge/content';
import { TAU, simCos, simExp } from '@military-forge/shared';
import { DT } from './constants';
import type { SimEvent } from './events';
import { EventClock, MapEventPhase, checkEvents, createOccurrence, type CompiledEvent, type EventOccurrence } from './mapEvents';
import type { PlayerState } from './player';

/** Pads a body can touch at once (more are ignored, in map order). */
export const MAX_PADS = 4;

/** What a body feels at one spot on one tick: the map rules × the running event × every zone it is in. */
export interface BodyEnv {
  gravityMul: number;
  fuelBurnMul: number;
  fuelRegenMul: number;
  moveSpeedMul: number;
  knockbackMul: number;
  /** airborne velocity kept per tick, e^(−drag·DT) (1 = no drag) */
  dragKeep: number;
  windX: number;
  windY: number;
  dive: number;
  jetDisabled: boolean;
  /** pads touched, in map order: unit launch direction and speed (m/s), the first `padCount` valid */
  readonly padUx: Float64Array;
  readonly padUy: Float64Array;
  readonly padSpeed: Float64Array;
  padCount: number;
}

export function createBodyEnv(): BodyEnv {
  return {
    gravityMul: 1,
    fuelBurnMul: 1,
    fuelRegenMul: 1,
    moveSpeedMul: 1,
    knockbackMul: 1,
    dragKeep: 1,
    windX: 0,
    windY: 0,
    dive: 0,
    jetDisabled: false,
    padUx: new Float64Array(MAX_PADS),
    padUy: new Float64Array(MAX_PADS),
    padSpeed: new Float64Array(MAX_PADS),
    padCount: 0,
  };
}

/** One zone, ready for point and ray tests. */
export interface CompiledZone {
  index: number;
  id: string;
  /** every effect, resolved from the zone and its kind */
  def: ResolvedModifiers;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  isRect: boolean;
  xs: Float64Array;
  ys: Float64Array;
  dragKeep: number;
  /** bullets: range used per metre inside (1 / bulletRangeMul) */
  bulletCost: number;
  /** pad launch: unit direction and speed (m/s); speed 0 = not a pad */
  launchUx: number;
  launchUy: number;
  launchSpeed: number;
  /** the event that switches it on (index into MapMechanics.events), −1 = always on */
  event: number;
}

/** Problems with a map's rules, zones and events; empty when it compiles. */
export function checkMechanics(map: MapDef): string[] {
  const errors: string[] = [];
  const checkMods = (where: string, m: MapModifiers) => {
    for (const f of MODIFIER_FIELDS) {
      const v: unknown = m[f.key];
      if (v === undefined) continue;
      if (f.key === 'jetDisabled') {
        if (typeof v !== 'boolean') errors.push(`${where}: jetDisabled must be true or false`);
        continue;
      }
      const values = f.key === 'wind' ? (Array.isArray(v) && v.length === 2 ? (v as unknown[]) : null) : [v];
      if (!values) {
        errors.push(`${where}: wind must be [x, y]`);
        continue;
      }
      for (const x of values) {
        if (typeof x !== 'number' || !Number.isFinite(x) || x < f.min || x > f.max) errors.push(`${where}: ${f.key} must be a number in [${f.min}, ${f.max}]`);
      }
    }
  };
  // reversed gravity pins players to the ceiling unless Down can pull them back (dive)
  const checkReversed = (where: string, r: ResolvedModifiers) => {
    if (r.gravityMul < 0 && r.dive <= 0) errors.push(`${where}: reversed gravity (gravityMul < 0) needs dive > 0, or players are stuck at the ceiling`);
  };
  if (map.rules) {
    checkMods('rules', map.rules);
    checkReversed('rules', resolveModifiers(map.rules));
  }
  checkEvents(map, errors);
  const eventIds = new Set((map.events?.defs ?? []).map((e) => e.id));
  for (const e of map.events?.defs ?? []) {
    checkMods(`event "${e.id}"`, e);
    checkReversed(`event "${e.id}"`, resolveEvent(e));
  }

  const ids = new Set<string>();
  const zonesFor = new Map<string, number>();
  (map.zones ?? []).forEach((z, i) => {
    const where = `zone "${z.id}"`;
    if (!z.id || ids.has(z.id)) errors.push(`zone #${i}: id must be unique and not empty`);
    ids.add(z.id);
    if (!Object.hasOwn(ZONE_KINDS, z.kind)) errors.push(`${where}: unknown kind "${z.kind}"`);
    if ((z.rect === undefined) === (z.points === undefined)) errors.push(`${where}: needs exactly one of rect or points`);
    if (z.rect && !(z.rect.length === 4 && z.rect.every(Number.isFinite) && z.rect[0] < z.rect[2] && z.rect[1] < z.rect[3])) {
      errors.push(`${where}: rect must be [minX, minY, maxX, maxY] with min < max`);
    }
    if (z.points && !(z.points.length >= 6 && z.points.length % 2 === 0 && z.points.every(Number.isFinite))) {
      errors.push(`${where}: points must be ≥ 3 finite x, y pairs`);
    }
    checkMods(where, z);
    checkReversed(where, resolveZone(z));
    const launch = z.launch ?? (Object.hasOwn(ZONE_KINDS, z.kind) ? ZONE_KINDS[z.kind].defaults.launch : undefined);
    if (launch && !(launch.length === 2 && launch.every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_LAUNCH) && (launch[0] !== 0 || launch[1] !== 0))) {
      errors.push(`${where}: launch must be [x, y], not zero, each within ±${MAX_LAUNCH} m/s`);
    }
    if (z.event !== undefined) {
      if (!eventIds.has(z.event)) errors.push(`${where}: unknown event "${z.event}"`);
      zonesFor.set(z.event, (zonesFor.get(z.event) ?? 0) + 1);
    }
  });
  for (const e of map.events?.defs ?? []) {
    if (resolveEvent(e).pickOneZone) {
      if (!zonesFor.get(e.id)) errors.push(`event "${e.id}": pickOneZone needs at least one zone with event "${e.id}"`);
    }
  }
  return errors;
}

export class MapMechanics {
  readonly rules: ResolvedModifiers;
  readonly zones: CompiledZone[];
  /** the map's events and their schedule (null: no events) */
  readonly clock: EventClock | null;
  /** map rules × the running event: what a body outside every zone feels this tick */
  readonly global = createBodyEnv();
  /** map-wide bullet range multiplier this tick */
  bulletRangeMul: number;
  /** zones switched on this tick (event zones only while their event runs) */
  readonly zoneOn: Uint8Array;
  /** the tick beginTick last set up */
  tick = -1;
  /** the occurrence covering that tick (its warning or active part), when `hasEvent` */
  readonly current = createOccurrence();
  hasEvent = false;
  private readonly prev = createOccurrence();
  private readonly rulesDragKeep: number;
  private readonly kbEnv = createBodyEnv();

  /** Compiles a map's mechanics; null when it has none. Throws on invalid data. */
  static compile(map: MapDef): MapMechanics | null {
    const rules = resolveModifiers(map.rules ?? {});
    if (isNeutral(rules) && !map.zones?.length && !map.events) return null;
    const errors = checkMechanics(map);
    if (errors.length) throw new Error(`map "${map.id}": ${errors.join('; ')}`);
    return new MapMechanics(map, rules);
  }

  get events(): readonly CompiledEvent[] {
    return this.clock?.events ?? NO_EVENTS;
  }

  private constructor(map: MapDef, rules: ResolvedModifiers) {
    this.rules = rules;
    this.rulesDragKeep = rules.drag > 0 ? simExp(-rules.drag * DT) : 1;
    const clock = map.events ? new EventClock(map) : null;
    this.clock = clock;
    this.zones = (map.zones ?? []).map((z, index) => {
      const r = resolveZone(z);
      const pts = zonePoints(z);
      const n = pts.length / 2;
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        xs[i] = pts[i * 2]!;
        ys[i] = pts[i * 2 + 1]!;
        minX = Math.min(minX, xs[i]!);
        maxX = Math.max(maxX, xs[i]!);
        minY = Math.min(minY, ys[i]!);
        maxY = Math.max(maxY, ys[i]!);
      }
      const launch = r.launch;
      const speed = launch ? Math.sqrt(launch[0] * launch[0] + launch[1] * launch[1]) : 0;
      const event = z.event !== undefined && clock ? clock.indexOf(z.event) : -1;
      if (event >= 0) clock!.events[event]!.zones.push(index);
      return {
        index,
        id: z.id,
        def: r,
        minX,
        minY,
        maxX,
        maxY,
        isRect: z.rect !== undefined,
        xs,
        ys,
        dragKeep: r.drag > 0 ? simExp(-r.drag * DT) : 1,
        bulletCost: 1 / r.bulletRangeMul,
        launchUx: speed > 0 ? launch![0] / speed : 0,
        launchUy: speed > 0 ? launch![1] / speed : 0,
        launchSpeed: speed,
        event,
      };
    });
    this.zoneOn = new Uint8Array(this.zones.length);
    this.bulletRangeMul = rules.bulletRangeMul;
    this.setGlobal(null, 0);
  }

  /**
   * Sets up tick `tick`: the running event, the map-wide modifiers and which zones are on. Pushes a
   * 'mapEvent' sim event when an event's warning starts, when it starts and when it ends.
   */
  beginTick(seed: number, tick: number, events: SimEvent[]): void {
    this.tick = tick;
    const clock = this.clock;
    if (!clock) return; // rules and zones alone never change from tick to tick
    const cur = this.current;
    this.hasEvent = clock.occurrenceAt(seed, tick, cur);
    if (tick > 0 && clock.occurrenceAt(seed, tick - 1, this.prev) && this.prev.endTick === tick) this.announce(events, this.prev, MapEventPhase.End, 0);
    if (this.hasEvent) {
      if (tick === cur.warnTick && cur.warnTick < cur.startTick) this.announce(events, cur, MapEventPhase.Warning, cur.startTick - tick);
      if (tick === cur.startTick) this.announce(events, cur, MapEventPhase.Start, cur.endTick - tick);
    }
    this.setGlobal(this.hasEvent && tick >= cur.startTick ? cur : null, tick);
  }

  /** The event running on the last tick set up (its warning counts), or null. */
  get activeEvent(): EventOccurrence | null {
    return this.hasEvent ? this.current : null;
  }

  private announce(events: SimEvent[], o: EventOccurrence, phase: MapEventPhase, ticksLeft: number): void {
    events.push({ type: 'mapEvent', event: o.event, phase, occurrence: o.occurrence, zone: o.zone, flip: o.flip, ticks: ticksLeft });
  }

  private setGlobal(active: EventOccurrence | null, tick: number): void {
    const g = this.global;
    const r = this.rules;
    g.gravityMul = r.gravityMul;
    g.fuelBurnMul = r.fuelBurnMul;
    g.fuelRegenMul = r.fuelRegenMul;
    g.moveSpeedMul = r.moveSpeedMul;
    g.knockbackMul = r.knockbackMul;
    g.dragKeep = this.rulesDragKeep;
    g.windX = r.windX;
    g.windY = r.windY;
    g.dive = r.dive;
    g.jetDisabled = r.jetDisabled;
    this.bulletRangeMul = r.bulletRangeMul;
    for (const z of this.zones) this.zoneOn[z.index] = z.event < 0 ? 1 : 0;
    if (!active) return;
    const e = this.clock!.events[active.event]!;
    const d = e.def;
    g.gravityMul *= d.gravityMul;
    g.fuelBurnMul *= d.fuelBurnMul;
    g.fuelRegenMul *= d.fuelRegenMul;
    g.moveSpeedMul *= d.moveSpeedMul;
    g.knockbackMul *= d.knockbackMul;
    g.dragKeep *= e.dragKeep;
    if (d.windX !== 0 || d.windY !== 0) {
      // gusts swell from nothing to full and back: 0.5 − 0.5·cos(2π·t/T)
      const gust = e.gustTicks > 0 ? 0.5 - 0.5 * simCos((TAU * ((tick - active.startTick) % e.gustTicks)) / e.gustTicks) : 1;
      g.windX += (active.flip ? -d.windX : d.windX) * gust;
      g.windY += d.windY * gust;
    }
    g.dive = Math.max(g.dive, d.dive);
    g.jetDisabled = g.jetDisabled || d.jetDisabled;
    this.bulletRangeMul *= d.bulletRangeMul;
    for (const zi of e.zones) if (active.zone < 0 || active.zone === zi) this.zoneOn[zi] = 1;
  }

  /** True when the point is inside the zone (rects inclusive; polygons even-odd, half-open). */
  contains(z: CompiledZone, x: number, y: number): boolean {
    if (x < z.minX || x > z.maxX || y < z.minY || y > z.maxY) return false;
    if (z.isRect) return true;
    const xs = z.xs;
    const ys = z.ys;
    let inside = false;
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      const yi = ys[i]!;
      const yj = ys[j]!;
      if (yi > y !== yj > y && x < ((xs[j]! - xs[i]!) * (y - yi)) / (yj - yi) + xs[i]!) inside = !inside;
    }
    return inside;
  }

  /** What a body at (x, y) feels this tick. `out` is overwritten. */
  envAt(x: number, y: number, out: BodyEnv): BodyEnv {
    const g = this.global;
    out.gravityMul = g.gravityMul;
    out.fuelBurnMul = g.fuelBurnMul;
    out.fuelRegenMul = g.fuelRegenMul;
    out.moveSpeedMul = g.moveSpeedMul;
    out.knockbackMul = g.knockbackMul;
    out.dragKeep = g.dragKeep;
    out.windX = g.windX;
    out.windY = g.windY;
    out.dive = g.dive;
    out.jetDisabled = g.jetDisabled;
    out.padCount = 0;
    for (const z of this.zones) {
      if (this.zoneOn[z.index] === 0 || !this.contains(z, x, y)) continue;
      const d = z.def;
      out.gravityMul *= d.gravityMul;
      out.fuelBurnMul *= d.fuelBurnMul;
      out.fuelRegenMul *= d.fuelRegenMul;
      out.moveSpeedMul *= d.moveSpeedMul;
      out.knockbackMul *= d.knockbackMul;
      out.dragKeep *= z.dragKeep;
      out.windX += d.windX;
      out.windY += d.windY;
      out.dive = Math.max(out.dive, d.dive);
      out.jetDisabled = out.jetDisabled || d.jetDisabled;
      if (z.launchSpeed > 0 && out.padCount < MAX_PADS) {
        out.padUx[out.padCount] = z.launchUx;
        out.padUy[out.padCount] = z.launchUy;
        out.padSpeed[out.padCount++] = z.launchSpeed;
      }
    }
    return out;
  }

  /** What a player feels: the environment at its body centre. */
  bodyEnv(p: PlayerState, t: Tuning, out: BodyEnv): BodyEnv {
    return this.envAt(p.x, p.y + (p.crouched ? t.crouchHeight : t.standHeight) / 2, out);
  }

  /** The knockback multiplier on a player where it stands now (blasts, bullets, melee). */
  knockbackMul(p: PlayerState, t: Tuning): number {
    return this.bodyEnv(p, t, this.kbEnv).knockbackMul;
  }

  /** The map's move-speed multiplier where a player stands now (a cut dash's exit caps). */
  moveSpeedMul(p: PlayerState, t: Tuning): number {
    return this.bodyEnv(p, t, this.kbEnv).moveSpeedMul;
  }

  // ---------- bullets ----------

  private rayCount = 0;
  private readonly rayT = new Float64Array(256);
  /** per ray event: the zone index entered, or −1 − index when the ray leaves it */
  private readonly rayZone = new Int32Array(256);
  private readonly crossings = new Float64Array(128);
  private insideFlags = new Uint8Array(0);

  /**
   * Sets up one bullet's ray (unit direction): where it enters and leaves the damping zones.
   * bulletReach and bulletCost then answer for that ray.
   */
  castBullet(ox: number, oy: number, dx: number, dy: number): void {
    this.rayCount = 0;
    for (const z of this.zones) {
      if (z.bulletCost === 1 || this.zoneOn[z.index] === 0) continue;
      // crossings of the zone outline with the ray's line (half-open straddle test: vertices count once)
      let n = 0;
      let behind = 0;
      const xs = z.xs;
      const ys = z.ys;
      for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
        const ax = xs[j]!;
        const ay = ys[j]!;
        const bx = xs[i]!;
        const by = ys[i]!;
        const sa = dx * (ay - oy) - dy * (ax - ox);
        const sb = dx * (by - oy) - dy * (bx - ox);
        if (sa > 0 === sb > 0) continue;
        const ex = bx - ax;
        const ey = by - ay;
        const t = ((ax - ox) * ey - (ay - oy) * ex) / (sb - sa);
        if (t < 0) behind++;
        else if (n < this.crossings.length) this.crossings[n++] = t;
      }
      sortAscending(this.crossings, n);
      // inside at the muzzle when an odd number of crossings lie behind it
      let isInside = (behind & 1) === 1;
      for (let k = 0; k < n && this.rayCount < this.rayT.length; k++) {
        this.rayT[this.rayCount] = this.crossings[k]!;
        this.rayZone[this.rayCount++] = isInside ? -1 - z.index : z.index;
        isInside = !isInside;
      }
    }
    // stable insertion sort by t (equal t keep zone order): deterministic
    const ts = this.rayT;
    const zs = this.rayZone;
    for (let i = 1; i < this.rayCount; i++) {
      const t = ts[i]!;
      const z = zs[i]!;
      let j = i - 1;
      while (j >= 0 && ts[j]! > t) {
        ts[j + 1] = ts[j]!;
        zs[j + 1] = zs[j]!;
        j--;
      }
      ts[j + 1] = t;
      zs[j + 1] = z;
    }
  }

  /**
   * How far (true metres) the ray set up by castBullet carries a bullet of weapon range `range`:
   * the map-wide multiplier scales the range, and each metre inside a damping zone costs
   * 1 / its bulletRangeMul metres of it (overlapping zones multiply).
   */
  bulletReach(range: number): number {
    return this.sweep(range * this.bulletRangeMul, Infinity, true);
  }

  /** Weapon range used up by `t` true metres along the ray (the distance damage falloff reads). */
  bulletCost(t: number): number {
    return this.sweep(Infinity, t, false) / this.bulletRangeMul;
  }

  /** Walks the ray's zone crossings: the reach for `budget` (wantReach), else the cost up to `until`. */
  private sweep(budget: number, until: number, wantReach: boolean): number {
    this.resetInside();
    let rate = this.rateInside();
    let used = 0;
    let prevT = 0;
    for (let i = 0; i < this.rayCount; i++) {
      const t = this.rayT[i]!;
      if (wantReach) {
        if (used + rate * (t - prevT) >= budget) return prevT + (budget - used) / rate;
      } else if (t >= until) return used + rate * (until - prevT);
      used += rate * (t - prevT);
      prevT = t;
      const z = this.rayZone[i]!;
      this.insideFlags[z < 0 ? -1 - z : z] = z < 0 ? 0 : 1;
      rate = this.rateInside();
    }
    return wantReach ? prevT + (budget - used) / rate : used + rate * (until - prevT);
  }

  /** Marks the damping zones the ray starts inside: those whose first crossing is a way out. */
  private resetInside(): void {
    if (this.insideFlags.length !== this.zones.length) this.insideFlags = new Uint8Array(this.zones.length);
    this.insideFlags.fill(0);
    for (let i = this.rayCount - 1; i >= 0; i--) {
      const z = this.rayZone[i]!;
      this.insideFlags[z < 0 ? -1 - z : z] = z < 0 ? 1 : 0;
    }
  }

  private rateInside(): number {
    let rate = 1;
    for (const z of this.zones) if (this.insideFlags[z.index] === 1) rate *= z.bulletCost;
    return rate;
  }
}

const NO_EVENTS: readonly CompiledEvent[] = [];

/** In-place ascending insertion sort of the first n values. */
function sortAscending(a: Float64Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const v = a[i]!;
    let j = i - 1;
    while (j >= 0 && a[j]! > v) {
      a[j + 1] = a[j]!;
      j--;
    }
    a[j + 1] = v;
  }
}
