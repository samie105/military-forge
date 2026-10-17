/**
 * Map events (docs/02 §20.7): things that just happen to the whole map for a while (a gravity
 * surge, an EMP storm, fog, wind gusts, a reversed-gravity pocket), on a schedule.
 *
 * The schedule is a pure function of the room seed, the tick and the map. There is no clock state
 * to send: the server, every client predicting its player (same seed from WELCOME, same tick
 * numbering) and every replay find the same event at the same tick, including when a client
 * re-simulates old ticks or jumps ahead.
 */
import { EVENT_KINDS, resolveEvent, type MapDef, type ResolvedEvent } from '@military-forge/content';
import { hash4, hashToUnit, simExp } from '@military-forge/shared';
import { DT, ticks } from './constants';

/** Per map (the wire's MAP_EVENT sizes). */
export const MAX_EVENTS = 32;
export const MAX_ZONES = 255;

/** Hash salt for the schedule (keeps it independent of weapon spread, which hashes the same seed). */
const SCHEDULE_SALT = 0x6d617065; // "mape"

/** Phase of a map event, as reported in 'mapEvent' sim events. */
export const MapEventPhase = {
  /** the banner says it is coming; nothing has changed yet */
  Warning: 0,
  /** its effects are on */
  Start: 1,
  /** its effects are off again */
  End: 2,
} as const;
export type MapEventPhase = (typeof MapEventPhase)[keyof typeof MapEventPhase];

export interface CompiledEvent {
  index: number;
  id: string;
  /** every field, resolved from the event and its kind */
  def: ResolvedEvent;
  dragKeep: number;
  warnTicks: number;
  durTicks: number;
  /** wind gust period in ticks, 0 = steady */
  gustTicks: number;
  /** random schedule weight */
  weight: number;
  /** zones tied to it (MapZone.event), in map order */
  zones: number[];
}

/** One scheduled occurrence of an event, covering [warnTick, endTick). */
export interface EventOccurrence {
  /** index into EventClock.events */
  event: number;
  /** counts occurrences across the schedule: the cycle index, or the entry number across loops */
  occurrence: number;
  warnTick: number;
  startTick: number;
  endTick: number;
  /** the event zone switched on (pickOneZone), −1 = all of them */
  zone: number;
  /** the wind blows the other way this time */
  flip: boolean;
}

export function createOccurrence(): EventOccurrence {
  return { event: -1, occurrence: 0, warnTick: 0, startTick: 0, endTick: 0, zone: -1, flip: false };
}

type CompiledSchedule =
  | { kind: 'random'; start: number; cycle: number; chance: number; totalWeight: number }
  | { kind: 'timeline'; start: number; loop: number; entries: { event: number; warnTick: number; startTick: number; endTick: number }[] };

/** Problems with a map's event defs and schedule, appended to `errors` (zone links: checkMechanics). */
export function checkEvents(map: MapDef, errors: string[]): void {
  const events = map.events;
  if (!events) return;
  const defs = events.defs ?? [];
  const ids = new Map<string, number>();
  // the snapshot's MAP_EVENT carries the event index in 5 bits and the zone index in 8 (255 = all)
  if (defs.length > MAX_EVENTS) errors.push(`events: at most ${MAX_EVENTS} per map`);
  if ((map.zones?.length ?? 0) > MAX_ZONES) errors.push(`zones: at most ${MAX_ZONES} per map`);
  defs.forEach((e, i) => {
    const where = `event "${e.id}"`;
    if (!e.id || ids.has(e.id)) errors.push(`event #${i}: id must be unique and not empty`);
    ids.set(e.id, i);
    if (!Object.hasOwn(EVENT_KINDS, e.kind)) errors.push(`${where}: unknown kind "${e.kind}"`);
    const r = resolveEvent(e);
    if (!(r.duration >= 1 / 60 && r.duration <= 600)) errors.push(`${where}: duration must be 1 tick to 600 s`);
    if (!(r.warning >= 0 && r.warning <= 30)) errors.push(`${where}: warning must be 0–30 s`);
    if (!(r.gustPeriod >= 0 && r.gustPeriod <= 60)) errors.push(`${where}: gustPeriod must be 0–60 s`);
  });
  const s = events.schedule;
  if (!s) {
    errors.push('events: missing schedule');
    return;
  }
  if (s.kind === 'random') {
    if (!(s.start >= 0)) errors.push('schedule: start must be ≥ 0');
    if (!(s.cycle > 0)) errors.push('schedule: cycle must be > 0');
    if (s.chance !== undefined && !(s.chance >= 0 && s.chance <= 1)) errors.push('schedule: chance must be 0–1');
    for (const [id, w] of Object.entries(s.weights ?? {})) {
      if (!ids.has(id)) errors.push(`schedule: weight for unknown event "${id}"`);
      if (!(typeof w === 'number' && w >= 0 && Number.isFinite(w))) errors.push(`schedule: weight for "${id}" must be ≥ 0`);
    }
    let total = 0;
    for (const e of defs) {
      const w = s.weights?.[e.id] ?? 1;
      total += w;
      const r = resolveEvent(e);
      if (w > 0 && ticks(r.warning) + Math.max(1, ticks(r.duration)) > ticks(s.cycle)) {
        errors.push(`schedule: event "${e.id}" (warning + duration) doesn't fit in the ${s.cycle} s cycle`);
      }
    }
    if (defs.length === 0) errors.push('schedule: no events to schedule');
    else if (!(total > 0)) errors.push('schedule: no event has a weight above 0');
  } else if (s.kind === 'timeline') {
    if (!((s.start ?? 0) >= 0)) errors.push('schedule: start must be ≥ 0');
    let lastEnd = 0;
    for (const entry of s.entries ?? []) {
      const i = ids.get(entry.event);
      if (i === undefined) {
        errors.push(`schedule: unknown event "${entry.event}"`);
        continue;
      }
      const r = resolveEvent(defs[i]!);
      const at = ticks(entry.at);
      if (at - ticks(r.warning) < lastEnd) errors.push(`schedule: "${entry.event}" at ${entry.at} s overlaps the entry before it (warnings included)`);
      lastEnd = at + Math.max(1, ticks(r.duration));
    }
    if (s.loop !== undefined && !(s.loop > 0 && ticks(s.loop) >= lastEnd)) errors.push('schedule: loop must be > 0 and cover every entry');
  } else {
    errors.push(`schedule: unknown kind "${(s as { kind: string }).kind}"`);
  }
}

/** A map's events and the schedule that says which one covers a tick. */
export class EventClock {
  readonly events: CompiledEvent[];
  private readonly schedule: CompiledSchedule | null;

  constructor(map: MapDef) {
    const defs = map.events?.defs ?? [];
    const schedule = map.events?.schedule;
    this.events = defs.map((e, index) => {
      const def = resolveEvent(e);
      return {
        index,
        id: e.id,
        def,
        dragKeep: def.drag > 0 ? simExp(-def.drag * DT) : 1,
        warnTicks: ticks(def.warning),
        durTicks: Math.max(1, ticks(def.duration)),
        gustTicks: def.gustPeriod > 0 ? Math.max(2, ticks(def.gustPeriod)) : 0,
        weight: schedule?.kind === 'random' ? (schedule.weights?.[e.id] ?? 1) : 0,
        zones: [],
      };
    });
    if (!schedule || this.events.length === 0) this.schedule = null;
    else if (schedule.kind === 'random') {
      this.schedule = {
        kind: 'random',
        start: ticks(schedule.start),
        cycle: Math.max(1, ticks(schedule.cycle)),
        chance: schedule.chance ?? 1,
        totalWeight: this.events.reduce((a, e) => a + e.weight, 0),
      };
    } else {
      const entries = schedule.entries.map((entry) => {
        const e = this.events[this.indexOf(entry.event)]!;
        const startTick = ticks(entry.at);
        return { event: e.index, warnTick: startTick - e.warnTicks, startTick, endTick: startTick + e.durTicks };
      });
      this.schedule = { kind: 'timeline', start: ticks(schedule.start ?? 0), loop: schedule.loop !== undefined ? ticks(schedule.loop) : 0, entries };
    }
  }

  indexOf(id: string): number {
    return this.events.findIndex((e) => e.id === id);
  }

  /**
   * The occurrence covering `tick` (its warning or active part) into `out`, or false. Only + − × ÷,
   * floor and integer hashing: identical on every engine.
   */
  occurrenceAt(seed: number, tick: number, out: EventOccurrence): boolean {
    const s = this.schedule;
    if (!s || tick < s.start) return false;
    if (s.kind === 'random') {
      // one cycle per `cycle` ticks; each event fits in its cycle, so only this one can cover the tick
      const k = Math.floor((tick - s.start) / s.cycle);
      if (s.chance < 1 && hashToUnit(hash4(seed, k, SCHEDULE_SALT, 0)) >= s.chance) return false;
      let pick = hashToUnit(hash4(seed, k, SCHEDULE_SALT, 1)) * s.totalWeight;
      let e: CompiledEvent | null = null;
      for (const c of this.events) {
        if (c.weight <= 0) continue;
        e = c;
        if (pick < c.weight) break;
        pick -= c.weight;
      }
      if (!e) return false;
      const slack = Math.max(0, s.cycle - e.warnTicks - e.durTicks);
      const warnTick = s.start + k * s.cycle + Math.floor(hashToUnit(hash4(seed, k, SCHEDULE_SALT, 2)) * (slack + 1));
      const endTick = warnTick + e.warnTicks + e.durTicks;
      if (tick < warnTick || tick >= endTick) return false;
      this.fill(out, seed, e, k, warnTick, warnTick + e.warnTicks, endTick);
      return true;
    }
    let local = tick - s.start;
    let lap = 0;
    if (s.loop > 0) {
      lap = Math.floor(local / s.loop);
      local -= lap * s.loop;
    }
    for (let i = 0; i < s.entries.length; i++) {
      const entry = s.entries[i]!;
      if (local < entry.warnTick || local >= entry.endTick) continue;
      const base = tick - local;
      this.fill(out, seed, this.events[entry.event]!, lap * s.entries.length + i, base + entry.warnTick, base + entry.startTick, base + entry.endTick);
      return true;
    }
    return false;
  }

  private fill(out: EventOccurrence, seed: number, e: CompiledEvent, occurrence: number, warnTick: number, startTick: number, endTick: number): void {
    out.event = e.index;
    out.occurrence = occurrence;
    out.warnTick = warnTick;
    out.startTick = startTick;
    out.endTick = endTick;
    out.zone = e.def.pickOneZone && e.zones.length > 0 ? e.zones[hash4(seed, occurrence, SCHEDULE_SALT, 3) % e.zones.length]! : -1;
    out.flip = e.def.windFlip && (hash4(seed, occurrence, SCHEDULE_SALT, 4) & 1) === 1;
  }
}
