/**
 * First flight (docs/design/onboarding-research.md §3.4; controls research item 8): five goals in the
 * range, about 90 s, each ticked by doing it. This is the pure part, unit-tested: the goals, what each
 * device is shown for them (the HUD plate or touch control to ring, the world marker, the actions whose
 * keys the callout shows), and the tracker that turns the sim's frames and events into tour events.
 * The runner that shows them through the spotlight is tour/firstFlight.ts.
 */
import type { SimEvent } from '@military-forge/sim';
import type { ActionId } from '../shell/controls';
import { FLIGHT_COPY, type FlightCopy } from './copy';
import type { Device } from './log';
import type { TourEvent, TourStepDef } from './tour';

export const FIRST_FLIGHT = 'first-flight';

/** a run that long ticks Run */
export const RUN_M = 3;
/** Run's marker, this far from the start, away from the targets (so they're in front, at range, for Fire) */
export const RUN_MARKER_M = 4;
/** Fly's marker, this high over the ground the goal began on; reaching REACH_M ticks it */
export const UP_M = 4;
export const REACH_M = 3.5;
/** Fire ticks on this many hits on a target */
export const HITS = 3;
/** after this long on one goal, the callout offers help and "Skip this" (never moves on by itself) */
export const HELP_AFTER_MS = 20_000;
/** the "Confirmed" stamp (P7) before the next goal */
export const CONFIRM_MS = 600;
/** a whole First flight under this is a promotion (§3.3): recruit hints off */
export const PROMOTE_UNDER_MS = 40_000;

export type FlightGoalId = 'run' | 'fly' | 'hit' | 'dash' | 'throw';

/** what the goals' `needs` read */
export interface FlightContext {
  /** grenades on the local player's belt */
  grenades: number;
}

export interface FlightGoal extends TourStepDef<FlightContext> {
  id: FlightGoalId;
}

export const FLIGHT_GOALS: readonly FlightGoal[] = [
  { id: 'run', done: ['move'] },
  { id: 'fly', done: ['reach'] },
  { id: 'hit', done: ['hit-dummy'], count: HITS },
  { id: 'dash', done: ['dash'] },
  // no grenades on this belt (a map without them): skipped by itself
  { id: 'throw', done: ['throw'], needs: (c) => c.grenades > 0 },
];

/** Where in the world a goal points: the run's end, the height to reach, the nearest target. */
export type Marker = 'run' | 'up' | 'target';

/** A touch control the tour can ring (touch/layout.ts ControlId). */
export type TouchControl = 'move' | 'aim' | 'fire' | 'dash' | 'grenade' | 'jet';

export interface GoalView {
  title: string;
  body: string;
  help: string;
  /** the actions whose keys (or pad glyphs) follow the body: the player's own bindings */
  keys: readonly ActionId[];
  /** the HUD plate to ring (`data-tour`), when the device has the HUD's plates */
  hud: 'fuel' | 'dash' | 'belt' | null;
  /** the touch control to ring (touch only) */
  touch: TouchControl | null;
  marker: Marker | null;
}

/** Touch settings the words depend on. */
export interface TouchWords {
  /** the move dial's side (left-handed mirrors the layout) */
  moveSide: 'left' | 'right';
  /** the fire mode (touch/settings.ts FireMode: auto, pull, button, release) */
  fire: string;
  /** the layout shows a JET button (Classic): Fly rings it */
  jetButton?: boolean;
  /** a DASH button is pinned: otherwise (the default, #259) a flick of the move dial dashes and Dash rings the dial */
  dashButton?: boolean;
}

const SHAPE: Record<FlightGoalId, Omit<GoalView, 'title' | 'body' | 'help'>> = {
  run: { keys: ['left', 'right'], hud: null, touch: 'move', marker: 'run' },
  fly: { keys: ['jet'], hud: 'fuel', touch: 'move', marker: 'up' },
  hit: { keys: ['fire'], hud: null, touch: 'aim', marker: 'target' },
  dash: { keys: ['dash'], hud: 'dash', touch: 'dash', marker: null },
  throw: { keys: ['grenade'], hud: 'belt', touch: 'grenade', marker: 'target' },
};

/** What a goal shows on a device: the words, the keys, what is ringed. */
export function goalView(goal: FlightGoalId, device: Device, touch: TouchWords = { moveSide: 'left', fire: 'auto' }): GoalView {
  const shape = SHAPE[goal];
  const copy: FlightCopy = FLIGHT_COPY[goal](device, touch);
  if (device === 'touch') {
    // touch: the control is ringed and named; no key caps (the words say which dial or button)
    // Fire with the FIRE button (that fire mode): the button, not the aim dial
    // Fly on Classic: the JET button; Dash without a pinned button: the move dial's flick (#259)
    const control =
      goal === 'hit' && touch.fire === 'button' ? 'fire' : goal === 'fly' && touch.jetButton ? 'jet' : goal === 'dash' && !touch.dashButton ? 'move' : shape.touch;
    return { ...copy, keys: [], hud: goal === 'fly' ? 'fuel' : null, touch: control, marker: shape.marker };
  }
  // a pad's move stick has one code (left and right are the same stick)
  return { ...copy, keys: device === 'pad' && goal === 'run' ? ['left'] : shape.keys, hud: shape.hud, touch: null, marker: shape.marker };
}

/** What the tracker reads of the local player each frame. */
export interface FlightSample {
  x: number;
  y: number;
  grounded: boolean;
  alive: boolean;
}

/**
 * The sim, read for the tour: "move" once the player is RUN_M from where the goal began, "reach" once
 * REACH_M over the ground it began on (the lowest ground stood on since), and the local player's hits
 * on a target, dashes and throws from the sim's events. `begin` starts a goal's measure.
 */
export class FlightTracker {
  private x0 = Number.NaN;
  private ground = Number.NaN;

  begin(me: FlightSample): void {
    this.x0 = me.x;
    this.ground = me.y;
  }

  /** where the goal began (NaN before `begin`) */
  get origin(): { x: number; ground: number } {
    return { x: this.x0, ground: this.ground };
  }

  frame(me: FlightSample): TourEvent[] {
    if (!me.alive || Number.isNaN(this.x0)) return [];
    const out: TourEvent[] = [];
    if (Math.abs(me.x - this.x0) >= RUN_M) out.push('move');
    if (me.y - this.ground >= REACH_M) out.push('reach');
    // the ground the climb is measured from: the lowest stood on (a ledge reached counts before this)
    if (me.grounded && me.y < this.ground) this.ground = me.y;
    return out;
  }

  events(events: readonly SimEvent[], me: number, isTarget: (id: number) => boolean): TourEvent[] {
    const out: TourEvent[] = [];
    for (const e of events) {
      if (e.type === 'hit' && e.attacker === me && e.target !== me && isTarget(e.target)) out.push('hit-dummy');
      else if (e.type === 'dash' && e.player === me) out.push('dash');
      else if (e.type === 'throw' && e.owner === me) out.push('throw');
    }
    return out;
  }
}

/** The world point a marker sits on, from where the goal began; `toward` is the targets' side (±1). */
export function markerPoint(marker: Exclude<Marker, 'target'>, origin: { x: number; ground: number }, toward: number): { x: number; y: number } {
  return marker === 'run' ? { x: origin.x - RUN_MARKER_M * toward, y: origin.ground + 1 } : { x: origin.x + 1.5 * toward, y: origin.ground + UP_M };
}

/** The nearest of `points` to x (the target the Fire and Throw goals ring), or null. */
export function nearest<P extends { x: number }>(points: readonly P[], x: number): P | null {
  let best: P | null = null;
  for (const p of points) if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  return best;
}
