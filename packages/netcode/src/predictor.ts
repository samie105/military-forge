/**
 * Client-side prediction + reconciliation for the local player (docs/05 §8).
 *
 * The shared sim runs the local player on the client with the same seed and tick numbering as the
 * server, so a correctly predicted tick produces bit-identical quantised state. Each predicted tick
 * records its input and the exact LocalState integers in a 128-tick ring. When a snapshot reports
 * the server's state for tick `ack`:
 *   - equal integers (the common case) → nothing to do;
 *   - otherwise → adopt the server state, re-simulate ack+1 … now from the recorded inputs, and
 *     hide the position jump with a visual offset that decays over ~80 ms, pulling the drawn
 *     player at most CORRECTION_PULL_MAX a second (a slide, not a yank); past CORRECTION_SNAP, a jump.
 *
 * The prediction world holds only the local player. Not predicted (server-authoritative, arrive as
 * corrections): damage from others, knockback from explosions, deaths, respawn position, and own
 * grenade flight (docs/05 §7.3 is a later step: thrown grenades are removed from the prediction).
 */
import {
  LS,
  applyLocalState,
  captureLocalState,
  createLocalState,
  describeLocalDiff,
  localStatesEqual,
  type LocalState,
} from '@military-forge/protocol';
import { POS_INV, simExp } from '@military-forge/shared';
import { PlayerState, copyInput, createInput, type Game, type Input, type SimEvent } from '@military-forge/sim';

export const HISTORY_TICKS = 128;
const MASK = HISTORY_TICKS - 1;
/** Position errors beyond this are teleports/respawns: snap instead of smoothing. */
export const SNAP_DISTANCE = 3;
/** A correction smaller than this (1 mm, ~1/30 px at default zoom) is not counted as visible. */
export const VISIBLE_ERROR = 0.001;
/** Visual error decay time constant (docs/05 §8). */
export const SMOOTHING_SECONDS = 0.08;
/**
 * The most a correction pulls the drawn player per second (m/s, ~1.6× a walk): a correction reads
 * as a slide, not a yank. The exponential's start is 1/SMOOTHING_SECONDS of the error a second
 * (12.5 m/s for 1 m); a latency spike's corrections pulled at up to 32 m/s (netfeel, MTN).
 */
export const CORRECTION_PULL_MAX = 8;
/**
 * A visual error bigger than this (one correction, or several in a row) is shown as one jump
 * instead (m): a slide that long would drag the drawn player far behind its real one, where its
 * shots start. Latency spikes (the server ran without our inputs for half a second) cause them.
 */
export const CORRECTION_SNAP = 2;
/** Longest gap fast-forward will simulate; beyond it the next snapshot is adopted instead. */
const MAX_FAST_FORWARD = 600;

export type ReconcileKind =
  /** prediction was exact */
  | 'match'
  /** some field differed (e.g. hp from a hit) but the position did not move */
  | 'mispredicted'
  /** position moved by more than VISIBLE_ERROR: smoothed */
  | 'corrected'
  /** moved more than SNAP_DISTANCE (respawn, teleport): no smoothing */
  | 'snapped'
  /** no history for that tick (start, resync, or the client fell behind): server state taken as is */
  | 'adopted'
  /** older than a snapshot already reconciled */
  | 'stale'
  /** not started yet */
  | 'idle';

export interface PredictionStats {
  matches: number;
  mispredictions: number;
  corrections: number;
  snaps: number;
  adopted: number;
  replayedTicks: number;
  /** metres, of the latest misprediction */
  lastErrorM: number;
  maxErrorM: number;
  /** which fields differed in the latest misprediction (debugging) */
  lastDiff: string;
}

export function createPredictionStats(): PredictionStats {
  return { matches: 0, mispredictions: 0, corrections: 0, snaps: 0, adopted: 0, replayedTicks: 0, lastErrorM: 0, maxErrorM: 0, lastDiff: '' };
}

/** Both dead = equal: the client holds its respawn timer (spawn choice is the server's). */
function statesMatch(predicted: LocalState, server: LocalState): boolean {
  if (predicted[LS.alive] === 0 && server[LS.alive] === 0) return true;
  return localStatesEqual(predicted, server);
}

export class Predictor {
  readonly player: PlayerState;
  /** next tick to simulate (= the server tick the next input is for) */
  tick = 0;
  started = false;
  /** events from forward-predicted ticks (own shots…); the caller drains it. Replays add nothing. */
  readonly events: SimEvent[] = [];
  /** visual error being smoothed away, added to the render position */
  readonly offset = { x: 0, y: 0 };
  /** how far the last decayOffset moved the drawn player (m): a correction's slide, felt as a pull */
  lastSlideM = 0;
  readonly stats = createPredictionStats();
  /** newest server tick reconciled */
  lastAck = -1;

  private readonly histTick = new Float64Array(HISTORY_TICKS).fill(-1);
  private readonly histInput: Input[] = Array.from({ length: HISTORY_TICKS }, createInput);
  private readonly histState: LocalState[] = Array.from({ length: HISTORY_TICKS }, createLocalState);
  private readonly inputs: (Input | undefined)[] = [];
  private readonly lastInput = createInput();
  private prevX = 0;
  private prevY = 0;
  private currX = 0;
  private currY = 0;

  /**
   * `game` is a client-side world with the room's map, seed and tuning and no other players: the
   * local player is created in it with the server's id (the spread seed includes the id and tick).
   */
  constructor(
    readonly game: Game,
    playerId: number,
    name = 'You',
  ) {
    const p = new PlayerState(playerId);
    p.name = name;
    game.players[playerId] = p;
    this.player = p;
  }

  /** Takes `state` as the player's state at the start of `tick` (= after the server simulated tick − 1). */
  reset(state: LocalState, tick: number): void {
    const wasStarted = this.started;
    const beforeX = this.currX;
    const beforeY = this.currY;
    applyLocalState(state, this.player);
    this.tick = tick;
    this.game.tick = tick;
    this.histTick.fill(-1);
    const i = (tick - 1) & MASK;
    this.histTick[i] = tick - 1;
    this.histState[i]!.set(state);
    this.histInput[i]!.buttons = state[LS.prevButtons]!;
    this.lastAck = tick - 1;
    this.currX = this.prevX = this.player.x;
    this.currY = this.prevY = this.player.y;
    this.started = true;
    if (wasStarted) this.applyError(beforeX - this.currX, beforeY - this.currY);
  }

  /** Predicts one tick with `input` and records it. */
  step(input: Readonly<Input>): void {
    const t = this.tick;
    this.simulate(t, input);
    for (const e of this.game.events) this.events.push(e);
    const i = t & MASK;
    this.histTick[i] = t;
    copyInput(this.histInput[i]!, input);
    captureLocalState(this.player, this.histState[i]!);
    this.prevX = this.currX;
    this.prevY = this.currY;
    this.currX = this.player.x;
    this.currY = this.player.y;
    this.tick = t + 1;
  }

  /** Runs ahead to `toTick` with a held input (start-up and hard resync). */
  fastForward(toTick: number, input: Readonly<Input>): void {
    if (toTick - this.tick > MAX_FAST_FORWARD) {
      // hopelessly behind: skip; the next snapshot has no history entry and is adopted
      this.tick = toTick;
      this.game.tick = toTick;
      this.histTick.fill(-1);
      return;
    }
    while (this.tick < toTick) this.step(input);
  }

  /** The input recorded for `tick`, if it is still in the history. */
  inputAt(tick: number): Input | null {
    const i = tick & MASK;
    return this.histTick[i] === tick ? this.histInput[i]! : null;
  }

  /** The predicted state recorded for `tick`, if it is still in the history. */
  stateAt(tick: number): LocalState | null {
    const i = tick & MASK;
    return this.histTick[i] === tick ? this.histState[i]! : null;
  }

  /** Compares the server's state after tick `ack` with the prediction; rewinds and replays on mismatch. */
  reconcile(ack: number, server: LocalState): ReconcileKind {
    if (!this.started) return 'idle';
    if (ack <= this.lastAck) return 'stale';
    this.lastAck = ack;
    const i = ack & MASK;
    const known = this.histTick[i] === ack && ack < this.tick;
    if (known && statesMatch(this.histState[i]!, server)) {
      this.stats.matches++;
      return 'match';
    }
    if (!known) {
      if (ack >= this.tick - 1) {
        // the server is at (or past) our newest prediction: we're running behind
        this.stats.adopted++;
        this.reset(server, ack + 1);
        return 'adopted';
      }
      // no record of that tick (it predates a reset/skip): adopt it and replay what we have
      this.stats.adopted++;
    } else {
      this.stats.mispredictions++;
      this.stats.lastDiff = describeLocalDiff(this.histState[i]!, server);
    }

    const beforeX = this.currX;
    const beforeY = this.currY;
    applyLocalState(server, this.player);
    this.histTick[i] = ack;
    this.histState[i]!.set(server);
    // fallback for ticks missing from the history: hold what the server last saw
    if (known) copyInput(this.lastInput, this.histInput[i]!);
    else this.lastInput.buttons = server[LS.prevButtons]!;
    let replayed = 0;
    for (let t = ack + 1; t < this.tick; t++) {
      const j = t & MASK;
      if (this.histTick[j] === t) copyInput(this.lastInput, this.histInput[j]!);
      else {
        this.histTick[j] = t;
        copyInput(this.histInput[j]!, this.lastInput);
      }
      this.simulate(t, this.lastInput);
      captureLocalState(this.player, this.histState[j]!);
      replayed++;
    }
    this.stats.replayedTicks += replayed;
    this.currX = this.player.x;
    this.currY = this.player.y;
    const prev = this.stateAt(this.tick - 2);
    this.prevX = prev ? prev[LS.x]! / POS_INV : this.currX;
    this.prevY = prev ? prev[LS.y]! / POS_INV : this.currY;
    const kind = this.applyError(beforeX - this.currX, beforeY - this.currY);
    return known ? kind : 'adopted';
  }

  /** Render position: tick interpolation (alpha ∈ [0,1) of the next tick) plus the smoothed error. */
  renderPosition(alpha: number, out: { x: number; y: number }): { x: number; y: number } {
    const dx = this.currX - this.prevX;
    const dy = this.currY - this.prevY;
    const jumped = Math.abs(dx) + Math.abs(dy) > SNAP_DISTANCE;
    out.x = (jumped ? this.currX : this.prevX + dx * alpha) + this.offset.x;
    out.y = (jumped ? this.currY : this.prevY + dy * alpha) + this.offset.y;
    return out;
  }

  /** Decays the visual error (call once per rendered frame). */
  decayOffset(dtSec: number): void {
    const x0 = this.offset.x;
    const y0 = this.offset.y;
    const len = Math.sqrt(x0 * x0 + y0 * y0);
    if (len > 0) {
      // exponential (SMOOTHING_SECONDS), never pulling faster than CORRECTION_PULL_MAX
      const d = Math.min(len * (1 - simExp(-dtSec / SMOOTHING_SECONDS)), CORRECTION_PULL_MAX * dtSec);
      const k = len > d ? (len - d) / len : 0;
      this.offset.x *= k;
      this.offset.y *= k;
    }
    if (Math.abs(this.offset.x) + Math.abs(this.offset.y) < 1e-4) this.offset.x = this.offset.y = 0;
    const sx = x0 - this.offset.x;
    const sy = y0 - this.offset.y;
    this.lastSlideM = Math.sqrt(sx * sx + sy * sy);
  }

  private applyError(dx: number, dy: number): ReconcileKind {
    const err = Math.sqrt(dx * dx + dy * dy);
    this.stats.lastErrorM = err;
    if (err > SNAP_DISTANCE) {
      this.offset.x = this.offset.y = 0;
      this.prevX = this.currX;
      this.prevY = this.currY;
      this.stats.snaps++;
      return 'snapped';
    }
    this.offset.x += dx;
    this.offset.y += dy;
    // a big error (or errors in a row that add up to one): one jump now, not a long drag
    if (this.offset.x * this.offset.x + this.offset.y * this.offset.y > CORRECTION_SNAP * CORRECTION_SNAP) {
      this.offset.x = this.offset.y = 0;
      this.stats.snaps++;
    }
    if (err <= VISIBLE_ERROR) return 'mispredicted';
    this.stats.corrections++;
    this.stats.maxErrorM = Math.max(this.stats.maxErrorM, err);
    return 'corrected';
  }

  private simulate(t: number, input: Readonly<Input>): void {
    const p = this.player;
    // respawning (and where) is the server's call: hold the timer while dead
    if (!p.alive && p.respawnTicks < 2) p.respawnTicks = 2;
    this.game.tick = t;
    this.inputs[p.id] = input;
    this.game.step(this.inputs);
    // own grenades and projectiles (rockets, shells, blades, orbs, flames) aren't predicted yet: the server's arrive in snapshots
    for (const e of this.game.events) if (e.type === 'throw' || e.type === 'launch') this.game.grenades[e.grenade]!.alive = false;
  }
}
