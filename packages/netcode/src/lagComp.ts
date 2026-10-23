/**
 * Server-side lag compensation for hitscan (docs/05 §7.1).
 *
 * The room records every player's hit pose (position, crouch, alive, facing, riot shield up or
 * slung) at the end of each tick in a 1 s ring. When a client's input fires on tick T, the room tells us the tick that client's screen
 * was showing remote players at (its render tick, sent in INPUT). Hitscan then tests each target at
 * the pose the shooter saw: the two snapshot ticks around that render tick, interpolated exactly as
 * the client interpolates them (interpolation.ts). The shooter itself is never rewound, and damage
 * applies now.
 *
 * Cap (docs/05 §7.1): 250 ms of latency on top of the most the adaptive interpolation delay can
 * be (200 ms; one tick more for low-bandwidth clients), so 450 ms of rewind at most. In this
 * tick-aligned model a shot at tick T was aimed at render tick ≈ T − (RTT + input buffer +
 * interpolation delay): netfeel's p90 is 140 ms on a LAN, 300 ms at the trial box's 110 ms,
 * 380 ms at 150 ms ±40 and 520 ms at 250 ms. So up to ~250 ms RTT every shot lands where it was
 * aimed; beyond, players lead their shots, and fake lag gains at most the cap. The trial box ran
 * 900 ms for 500 ms phones (QA, 23 Oct 2026): players were hit up to 0.9 s after reaching cover,
 * 3.6 m at a walk. The cover rule (sim rewind.ts) adds to the cap: a rewind over 150 ms doesn't
 * count against a target that is behind solid cover now. A server sets its own latency cap
 * (LAG_COMP_LATENCY_MS, or the admin page's net.lagCompMs, live).
 */
import { MAX_PLAYERS, shieldRaised, shieldSlung, type HitPose, type PlayerState, type TargetRewind } from '@military-forge/sim';
import { lerpPosition } from './interpolation';
import { TICK_MS } from './ticks';

/** Latency the server compensates at most, on top of the interpolation delay (docs/05 §1). */
export const LAG_COMP_LATENCY_CAP_MS = 250;
/** NetClient's starting interpolation delay (docs/05 §10); it adapts within 50–200 ms. */
export const INTERP_DELAY_MS = 100;
/** The most NetClient's adaptive interpolation delay can be (client.ts MAX_INTERP_DELAY_MS). */
export const MAX_VIEW_DELAY_MS = 200;
/** Hit-pose history kept per player: 2.1 s at 60 Hz (room for a LAG_COMP_MAX_MS up to 2 s). */
export const POSE_HISTORY_TICKS = 128;
const MASK = POSE_HISTORY_TICKS - 1;
const ALIVE = 1;
const CROUCHED = 2;
const FACING_LEFT = 4;
/** riot shield up and blocking the front: the shield is rewound with its owner */
const SHIELD = 8;
/** riot shield slung, blocking the back */
const SHIELD_BACK = 16;

export interface LagCompOptions {
  /** the room's snapshot interval in ticks: clients interpolate between those ticks */
  snapshotEvery?: number;
  /**
   * latency compensated at most (ms), on top of each shooter's view delay (setView): default
   * LAG_COMP_LATENCY_CAP_MS, i.e. 450 ms of rewind normally, 467 ms in low-bandwidth mode (+ 1
   * tick of input batching)
   */
  latencyCapMs?: number;
  /** a total rewind cap in ms for every shooter instead (tests, tools) */
  maxRewindMs?: number;
  /** keep a log of every rewind for the debug overlay (dev) */
  log?: boolean;
}

/** One target tested by one shot (debug overlay, tests). */
export interface RewindRecord {
  /** the tick being simulated when the shot was fired */
  tick: number;
  shooter: number;
  target: number;
  /** the shooter's render tick, and the tick actually used after the cap */
  viewTick: number;
  usedTick: number;
  clamped: boolean;
  /** turned down by the cover rule: the target was tested where it is (sim rewind.ts) */
  covered: boolean;
  x: number;
  y: number;
  crouched: boolean;
  alive: boolean;
  /** where the target really was when the shot was tested */
  nowX: number;
  nowY: number;
}

export class LagCompensator implements TargetRewind {
  readonly snapshotEvery: number;
  private readonly baseLatencyMs: number;
  private readonly baseFixedTicks: number;
  private latencyMs: number;
  private fixedCapTicks: number;
  /** rewinds performed during the latest tick (only with `log`) */
  readonly log: RewindRecord[] = [];
  /** shots tested with a rewind, how many hit the cap, and how many the cover rule turned down */
  rewinds = 0;
  clamped = 0;
  covers = 0;

  private readonly logging: boolean;
  private readonly tickAt = new Float64Array(POSE_HISTORY_TICKS).fill(-1);
  private readonly xs = new Float64Array(POSE_HISTORY_TICKS * MAX_PLAYERS);
  private readonly ys = new Float64Array(POSE_HISTORY_TICKS * MAX_PLAYERS);
  private readonly flags = new Uint8Array(POSE_HISTORY_TICKS * MAX_PLAYERS);
  private readonly views = new Float64Array(MAX_PLAYERS).fill(Number.NaN);
  /** who holds each id, and since which tick: ids are reused, older history isn't theirs */
  private readonly occupant: (PlayerState | null)[] = new Array<PlayerState | null>(MAX_PLAYERS).fill(null);
  private readonly since = new Float64Array(MAX_PLAYERS);
  /** each shooter's snapshot spacing in ticks (low-bandwidth clients get fewer snapshots) */
  private readonly spacing = new Uint8Array(MAX_PLAYERS);
  private readonly caps = new Float64Array(MAX_PLAYERS);
  private current = 0;
  private readonly lerped = { x: 0, y: 0 };

  constructor(options: LagCompOptions = {}) {
    this.snapshotEvery = Math.max(1, options.snapshotEvery ?? 2);
    this.latencyMs = this.baseLatencyMs = options.latencyCapMs ?? LAG_COMP_LATENCY_CAP_MS;
    this.fixedCapTicks = this.baseFixedTicks = options.maxRewindMs === undefined ? Number.NaN : options.maxRewindMs / TICK_MS;
    this.logging = options.log ?? false;
  }

  /** The cap for a shooter with the most view delay (ticks). */
  get maxRewindTicks(): number {
    return Number.isNaN(this.fixedCapTicks) ? (this.latencyMs + MAX_VIEW_DELAY_MS) / TICK_MS : this.fixedCapTicks;
  }

  /** The latency compensated at most (ms), on top of the view delay; NaN under a fixed total cap. */
  get latencyCapMs(): number {
    return Number.isNaN(this.fixedCapTicks) ? this.latencyMs : Number.NaN;
  }

  /**
   * A new latency cap (ms) from the next setView on (the admin page, live), in place of any fixed
   * total; null: the options' again.
   */
  setLatencyCap(ms: number | null): void {
    if (ms === null) {
      this.latencyMs = this.baseLatencyMs;
      this.fixedCapTicks = this.baseFixedTicks;
    } else {
      this.latencyMs = Math.max(0, ms);
      this.fixedCapTicks = Number.NaN;
    }
  }

  /** Old positions belong to the previous arena after a lobby map change. */
  reset(): void {
    this.tickAt.fill(-1);
    this.occupant.fill(null);
    this.since.fill(0);
    this.log.length = 0;
  }

  /** Stores everyone's hit pose for `tick` (the state a snapshot for that tick shows). */
  record(tick: number, players: readonly (PlayerState | null)[]): void {
    const slot = tick & MASK;
    this.tickAt[slot] = tick;
    const base = slot * MAX_PLAYERS;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const p = players[id] ?? null;
      if (p !== this.occupant[id]) {
        this.occupant[id] = p;
        this.since[id] = tick;
      }
      this.flags[base + id] = p
        ? (p.alive ? ALIVE : 0) | (p.crouched ? CROUCHED : 0) | (p.facing < 0 ? FACING_LEFT : 0) | (shieldRaised(p) ? SHIELD : 0) | (shieldSlung(p) ? SHIELD_BACK : 0)
        : 0;
      this.xs[base + id] = p ? p.x : 0;
      this.ys[base + id] = p ? p.y : 0;
    }
  }

  /** Before simulating `tick`: forget last tick's views (call setView for each shooter after). */
  begin(tick: number): void {
    this.current = tick;
    this.views.fill(Number.NaN);
    this.log.length = 0;
  }

  /**
   * The render tick `shooterId`'s screen showed when it sampled this tick's input (NaN: none), and
   * the spacing of the snapshots it interpolates between (default: the room's).
   */
  setView(shooterId: number, renderTick: number, snapshotEvery = this.snapshotEvery, interpDelayMs = MAX_VIEW_DELAY_MS): void {
    if (shooterId < 0 || shooterId >= MAX_PLAYERS) return;
    this.views[shooterId] = renderTick;
    this.spacing[shooterId] = snapshotEvery;
    this.caps[shooterId] = Number.isNaN(this.fixedCapTicks) ? (this.latencyMs + interpDelayMs) / TICK_MS : this.fixedCapTicks;
  }

  pose(target: PlayerState, shooter: PlayerState, out: HitPose): boolean {
    const view = this.views[shooter.id]!;
    if (Number.isNaN(view)) return false;
    const current = this.current;
    const earliest = current - this.caps[shooter.id]!; // set with the view, this tick
    const clamped = view < earliest;
    const t = Math.min(current, Math.max(earliest, view));
    // the client interpolates between snapshot ticks (multiples of its snapshot spacing)
    const every = this.spacing[shooter.id] || this.snapshotEvery;
    const newestSnapshot = Math.floor(current / every) * every;
    let a = Math.floor(t / every) * every;
    let b = a + every;
    if (b > newestSnapshot) a = b = newestSnapshot; // past the newest snapshot: the client holds it
    const sa = a & MASK;
    const sb = b & MASK;
    // older than the history, or from before this player got the id (including a leave and a join
    // since the last record()): test the current pose, which is where the client draws a new holder
    if (this.tickAt[sa] !== a || this.occupant[target.id] !== target || a < this.since[target.id]!) return false;
    if (this.tickAt[sb] !== b) b = a;
    const ia = sa * MAX_PLAYERS + target.id;
    const ib = (b & MASK) * MAX_PLAYERS + target.id;
    const alpha = b > a ? Math.max(0, Math.min(1, (t - a) / (b - a))) : 1;
    lerpPosition(this.xs[ia]!, this.ys[ia]!, this.xs[ib]!, this.ys[ib]!, alpha, this.lerped);
    out.x = this.lerped.x;
    out.y = this.lerped.y;
    const f = alpha < 0.5 ? this.flags[ia]! : this.flags[ib]!;
    out.alive = (f & ALIVE) !== 0;
    out.crouched = (f & CROUCHED) !== 0;
    out.facing = (f & FACING_LEFT) !== 0 ? -1 : 1;
    out.shield = (f & SHIELD) !== 0;
    out.shieldBack = (f & SHIELD_BACK) !== 0;
    out.ticksBack = current - t;
    this.rewinds++;
    if (clamped) this.clamped++;
    if (this.logging) {
      this.log.push({
        tick: current,
        shooter: shooter.id,
        target: target.id,
        viewTick: view,
        usedTick: t,
        clamped,
        covered: false,
        x: out.x,
        y: out.y,
        crouched: out.crouched,
        alive: out.alive,
        nowX: target.x,
        nowY: target.y,
      });
    }
    return true;
  }

  covered(target: PlayerState, shooter: PlayerState): void {
    this.covers++;
    const last = this.logging ? this.log[this.log.length - 1] : undefined;
    if (last && last.target === target.id && last.shooter === shooter.id) last.covered = true;
  }
}
