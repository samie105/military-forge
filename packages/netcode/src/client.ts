/**
 * The client half of the netcode, without any DOM: handshake, clock sync, input pacing, prediction
 * and reconciliation, snapshot buffering for interpolation, and the numbers for the net graph.
 * The web client wraps it with a WebSocket, input sampling and rendering; tests drive it against a
 * real Room through the network conditioner with a fake clock.
 */
import { applyContentOverrides, clampAdmin, createTuning, getMap, type AdminValues, type MapDef, type Tuning } from '@military-forge/content';
import {
  BitWriter,
  CmdKind,
  DecodeError,
  MsgType,
  SnapshotDecoder,
  decodeMessage,
  encodeCmd,
  encodeHello,
  encodeInputInto,
  encodePing,
  type RewindDebugMsg,
  type ServerMessage,
  type SnapshotMsg,
  type SnapshotPlayer,
} from '@military-forge/protocol';
import { DT, Game, MAX_PLAYERS, SegFlag, createInput, createRayHit, type Input, type PlayerState, type SimEvent } from '@military-forge/sim';
import { InputPacer, RttEstimator, type PacerOptions } from './clock';
import { bracketSnapshots, extrapolationTicks, lerpPosition, quantizeRenderTick, type SnapshotBracket } from './interpolation';
import { OwnProjectiles, type GrenadeView } from './ownProjectiles';
import { Predictor, type ReconcileKind } from './predictor';
import { TICK_MS, unwrapTick } from './ticks';

export interface NetClientOptions {
  name: string;
  /**
   * The API's join ticket for this room (docs/06 §6), sent in every HELLO. The server spends it on a
   * new player only: a resume is admitted by the session token, so a used or expired ticket is fine then.
   */
  ticket?: string;
  /** hands bytes to the transport (through the conditioner, if any) */
  send(bytes: Uint8Array): void;
  /**
   * The transport is a stream (WebSocket; the default): a stalled connection keeps what it couldn't
   * send and hands it all over when it recovers, seconds of INPUTs at once that the server can't
   * use any more. So while the server has been silent for STALL_MS, or `backlog()` is high, INPUTs
   * go out only 4 times a second: each carries the newest inputs, all a recovering server needs.
   * false for datagrams (WebTransport): a stall just loses them.
   */
  stream?: () => boolean;
  /** bytes the transport has queued but not sent yet (WebSocket bufferedAmount) */
  backlog?: () => number;
  /** monotonic milliseconds */
  now(): number;
  /** inputs per packet: the newest plus redundant copies (docs/05 §1: 3–4) */
  redundancy?: number;
  /**
   * remote players are drawn this far in the past (docs/05 §10). Unset (the default): adaptive, from
   * how unevenly snapshots arrive (adaptInterpDelay); set: fixed (tests).
   */
  interpDelayMs?: number;
  pacer?: Partial<PacerOptions>;
  /**
   * The admin page's content numbers are this client's own to set (the default: a browser). false
   * when the client shares its content module with the server, in one process (netsim, tests): the
   * admin values are process-wide, so a client applying a delayed OVERRIDES, or clearing them,
   * would change the server's weapons mid-run. It still records them (adminValues, adminTuned).
   */
  ownContent?: boolean;
}

export interface ReceivedSnapshot {
  msg: SnapshotMsg;
  recvMs: number;
  /** encoded size, bytes */
  bytes: number;
}


/** Fills `out` with this tick's input; `me` is the predicted local player (null before the first snapshot). */
export type InputSource = (me: PlayerState | null, out: Input) => void;

/** A remote player as drawn at a render tick (docs/05 §10). */
export interface RemotePose {
  x: number;
  y: number;
  /** discrete fields (alive, crouch, weapons…) come from this snapshot entry */
  src: SnapshotPlayer;
  /**
   * a melee swing's progress at the render tick (v16; 0 idle, 1 = started, fractional between
   * ticks): from the later snapshot when its swing had already started by then, else the earlier
   * one's carried on, so a swing plays smoothly between snapshots two or four ticks apart (set by
   * remotePose; optional so a caller's own scratch pose needn't carry it)
   */
  meleeTicks?: number;
}

/**
 * A remote swing's progress at render tick `t`, from two snapshots (`m0` at tick `t0`, `m1` at
 * `t1`): meleeTicks counts up one a tick from 1 when a swing starts and drops to 0 when it ends.
 */
export function swingAt(m0: number, t0: number, m1: number, t1: number, t: number): number {
  if (m1 > 0) {
    const at = m1 - (t1 - t);
    if (at >= 1) return at;
  }
  // the earlier swing carried on (if it ended within the gap, by at most the gap's few ticks)
  return m0 > 0 ? m0 + (t - t0) : 0;
}

export interface NetClientStats {
  rttMs: number;
  rttJitterMs: number;
  /** % of snapshots that never arrived (sequence gaps), over the last ~10 s */
  snapshotLossPct: number;
  inputBufferHealth: number;
  timeScale: number;
  /** ticks predicted but not yet confirmed by a snapshot */
  unackedTicks: number;
  correctionsPerMin: number;
  mispredictionsPerMin: number;
  lastErrorCm: number;
  resyncs: number;
  lowBandwidth: boolean;
  /** snapshot loss has stayed above 10 % for 5 s: worth offering low-bandwidth mode (docs/05 §13) */
  suggestLowBandwidth: boolean;
}

/** remote players are drawn this far back in low-bandwidth mode (15 Hz snapshots); lag comp allows for it */
export const LOW_BANDWIDTH_INTERP_DELAY_MS = 150;
/** the adaptive interpolation delay's range (docs/05 §10: 50–200 ms; lag comp's cap allows for the top) */
export const MIN_INTERP_DELAY_MS = 50;
export const MAX_INTERP_DELAY_MS = 200;
/** where it starts, before any snapshot has been seen */
const START_INTERP_DELAY_MS = 100;
/** snapshots the delay is worked out from (~3 s) */
const INTERP_WINDOW = 90;
/** how fast it moves, ms per second: up quickly (remote players run ~6 % slow meanwhile), down gently */
const INTERP_GROW_PER_SEC = 60;
const INTERP_SHRINK_PER_SEC = 10;
const MAX_STEPS_PER_UPDATE = 16;
const PING_INTERVAL_MS = 1000;
const PING_BURST = 5;
const PING_BURST_INTERVAL_MS = 50;
const SNAPSHOT_BUFFER = 60;
const TICK_S = TICK_MS / 1000;
/** a carried-on remote player stops this far from a wall (m: about a body's half-width) and from a floor or ceiling (half its height) */
const EXTRAPOLATE_HALF_WIDTH = 0.35;
const EXTRAPOLATE_HALF_HEIGHT = 0.9;
const RATE_WINDOW_MS = 60_000;
/** no word from the server for this long (snapshots come every 33–67 ms): the connection has stalled */
const STALL_MS = 500;
/** more than this queued in the transport (~½ s of INPUTs) and it has stalled too */
const BACKLOG_LIMIT = 1024;
/** while stalled on a stream: at most one INPUT this often */
const STALLED_INPUT_INTERVAL_MS = 250;

export class NetClient {
  status = 'connecting…';
  /** from WELCOME: presented in HELLO to get our player back after a drop (docs/05 §13) */
  sessionToken = '';
  /** the join ticket every HELLO carries (NetClientOptions.ticket; replace it with a fresh one to rejoin) */
  ticket: string;
  /** times a dropped connection got its player back */
  reconnects = 0;
  /** a transport is open and the server welcomed us on it */
  private connected = false;
  /** resumed: hold prediction until the first (full) snapshot re-anchors it */
  private resyncPending = false;
  myId = -1;
  map: MapDef = getMap('movement-test');
  tuning: Tuning = createTuning();
  /**
   * The server's admin values (v13: WELCOME, OVERRIDES): their weapon, grenade and projectile
   * numbers are put in this page's content, so prediction runs on the server's. `{}`: none.
   */
  adminValues: AdminValues = {};
  seed = 1;
  predictor: Predictor | null = null;
  /** own grenades and projectiles, flown from the throw (docs/05 §7.3) */
  ownShots: OwnProjectiles | null = null;
  readonly rtt = new RttEstimator();
  readonly pacer: InputPacer;
  /** newest last; for remote-player interpolation */
  readonly snapshots: ReceivedSnapshot[] = [];
  /** delta snapshots whose baseline we didn't have (dropped, not acked: the server falls back) */
  deltaMisses = 0;
  /** INPUTs not sent because the connection had stalled (NetClientOptions.stream) */
  inputsHeldBack = 0;
  private readonly snapshotDecoder = new SnapshotDecoder();
  readonly names = new Map<number, string>();
  /**
   * Per id: the first server tick whose snapshots show its current holder (ROSTER `since`). Older
   * snapshots show whoever had the id before, so a joiner is never drawn at a leaver's old poses
   * (lag comp tests its current pose), whatever order ROSTER and snapshots arrive in.
   */
  private readonly heldSince = new Float64Array(MAX_PLAYERS).fill(-Infinity);
  /** predicted local events since the last drainEvents() (own shots: instant tracers) */
  private readonly predictedEvents: SimEvent[] = [];
  /** lag-compensation rewinds of our recent shots (dev rooms), newest last */
  readonly rewinds: { msg: RewindDebugMsg; recvMs: number }[] = [];
  /** reconcile outcomes since the last drain (tests, debugging) */
  readonly outcomes: Record<ReconcileKind, number> = { match: 0, mispredicted: 0, corrected: 0, snapped: 0, adopted: 0, stale: 0, idle: 0 };

  private acc = 0;
  private helloAt = 0;
  /** when the server last sent anything */
  private lastHeardAt = 0;
  private nextStalledInputAt = 0;
  private nextPingAt = Infinity;
  private burstLeft = 0;
  private startTick = 0;
  private startAt = 0;
  private readonly input = createInput();
  private readonly writer = new BitWriter(64);
  private readonly packetInputs: Input[] = [];
  private readonly packetLags: number[] = [];
  /** the render tick shown when each predicted tick's input was sampled (by tick & 63) */
  private readonly sampledView = new Float64Array(64).fill(Number.NaN);
  private readonly sampledFor = new Float64Array(64).fill(-1);
  private lastSeq = -1;
  private readonly seqWindow: { at: number; lost: number }[] = [];
  private readonly correctionTimes: number[] = [];
  private readonly mispredictionTimes: number[] = [];
  private readonly redundancy: number;
  private interpDelayMs: number;
  private readonly baseInterpDelayMs: number;
  /** the adaptive delay's goal (adaptive only), and recent snapshots' arrival offsets (recv − serverTick × tick) */
  private interpTarget: number;
  private readonly adaptive: boolean;
  private readonly arrivals: number[] = [];
  /** low-bandwidth mode (docs/05 §2.2): one INPUT per 2 ticks, 15 Hz snapshots */
  private lowBw = false;
  /** until then snapshots may still arrive at either rate (a mode switch is on its way): lenient loss */
  private rateChangeUntil = 0;
  private unsentTicks = 0;
  private heavyLossSince = 0;
  private firstStatAt = 0;
  /** the render tick of the last frame drawn: what the player saw when the next input is sampled */
  private shownRenderTick = Number.NaN;
  private readonly bracket: SnapshotBracket = { a: null!, b: null!, alpha: 1 };
  private readonly lerped = { x: 0, y: 0 };
  private readonly extrapolateHit = createRayHit();

  constructor(private readonly options: NetClientOptions) {
    this.redundancy = Math.max(1, Math.min(4, options.redundancy ?? 4));
    this.adaptive = options.interpDelayMs === undefined;
    this.interpDelayMs = this.baseInterpDelayMs = this.interpTarget = options.interpDelayMs ?? START_INTERP_DELAY_MS;
    this.pacer = new InputPacer(options.pacer);
    this.ticket = options.ticket ?? '';
  }

  get joined(): boolean {
    return this.myId >= 0;
  }

  /**
   * The transport is open: say hello, presenting our session token if we had one (reconnect).
   * The HELLO→WELCOME round trip is the first RTT sample.
   */
  onOpen(): void {
    this.status = this.sessionToken ? 'resuming…' : 'joining…';
    this.helloAt = this.lastHeardAt = this.options.now();
    this.options.send(encodeHello(this.options.name, this.sessionToken, this.ticket));
  }

  /** The transport dropped (not a kick): freeze until a new one is open (call onOpen again). */
  onClose(): void {
    this.connected = false;
    this.status = 'reconnecting…';
    this.nextPingAt = Infinity;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** The server's admin values: into this page's content (prediction), kept for the HUD's tag. */
  private applyOverrides(json: string): void {
    let values: AdminValues;
    try {
      values = clampAdmin(JSON.parse(json || '{}'));
    } catch {
      values = {}; // not JSON: nothing changed, as far as this client can tell
    }
    this.adminValues = values;
    if (this.options.ownContent !== false) applyContentOverrides(values);
  }

  /** Leaving the server: the shipped numbers again (local play after an admin-tuned room plays as shipped). */
  clearOverrides(): void {
    this.adminValues = {};
    if (this.options.ownContent !== false) applyContentOverrides({});
  }

  /** The owner changed gameplay numbers on this server (the HUD's "Tuned by admin"). */
  get adminTuned(): boolean {
    for (const _ in this.adminValues) return true;
    return false;
  }

  /**
   * The room's host retunes the room. While disconnected the edit waits and goes out with the next
   * WELCOME (it was silently lost: the onboarding/sockets audit, L8); the server answers with the
   * room's tuning when it took something else (clamped, or we're no longer the host).
   */
  setTuning(t: Tuning): void {
    this.tuning = { ...t };
    if (this.predictor) this.predictor.game.tuning = this.tuning;
    if (this.ownShots) this.ownShots.tuning = this.tuning;
    if (this.connected) this.options.send(encodeCmd(CmdKind.SetTuning, JSON.stringify(t)));
    else this.pendingTuning = { ...t };
  }

  /** a host's tuning edit made while disconnected, sent on the next WELCOME */
  pendingTuning: Tuning | null = null;

  /**
   * Low-bandwidth mode (docs/05 §2.2, §13): inputs go two ticks per packet at 30 Hz (the 4-deep
   * redundancy still covers a lost packet), the server sends this client 15 Hz snapshots, and
   * remote players are drawn 150 ms back to bridge the wider gaps. Costs ~8 ms of input latency on
   * the server's side; prediction keeps your own movement instant.
   */
  setLowBandwidth(on: boolean): void {
    if (on !== this.lowBw) {
      // the server keeps its old rate until the CMD lands: about half an RTT, plus a 15 Hz interval
      const rtt = this.rtt.count > 0 ? this.rtt.median : 300;
      this.rateChangeUntil = this.options.now() + rtt + 4 * TICK_MS + 50;
    }
    this.lowBw = on;
    if (!this.adaptive) this.interpDelayMs = on ? Math.max(this.baseInterpDelayMs, LOW_BANDWIDTH_INTERP_DELAY_MS) : this.baseInterpDelayMs;
    else if (on) this.interpDelayMs = Math.max(this.interpDelayMs, LOW_BANDWIDTH_INTERP_DELAY_MS);
    this.unsentTicks = 0;
    if (this.connected) this.options.send(encodeCmd(CmdKind.SetLowBandwidth, on ? '1' : '0'));
  }

  get lowBandwidth(): boolean {
    return this.lowBw;
  }

  respawn(): void {
    this.options.send(encodeCmd(CmdKind.Respawn, ''));
  }

  /**
   * Handles one server message; returns it so the UI can react (roster, events, kicks), or null
   * for a delta snapshot we can't use.
   */
  receive(bytes: Uint8Array): ServerMessage | null {
    const now = this.options.now();
    this.lastHeardAt = now;
    let msg: ServerMessage;
    if (bytes[0] === MsgType.Snapshot) {
      try {
        msg = this.snapshotDecoder.decode(bytes);
      } catch (e) {
        if (!(e instanceof DecodeError) || !e.message.startsWith('missing baseline')) throw e;
        this.deltaMisses++;
        return null;
      }
    } else msg = decodeMessage(bytes) as ServerMessage;
    switch (msg.type) {
      case MsgType.Welcome: {
        const resumingSame = msg.resumed && this.predictor !== null && this.predictor.player.id === msg.playerId && this.map.id === msg.mapId;
        if (this.myId >= 0) {
          // a new connection: the server has fresh baselines for it, so drop ours
          this.snapshotDecoder.reset();
          this.lastSeq = -1;
          this.seqWindow.length = 0;
          this.pacer.reset();
          this.acc = 0;
          if (msg.resumed) this.reconnects++;
          // a fresh join (e.g. the server restarted) is a new timeline: old snapshots would skew the
          // render tick and the lag-comp view for their whole buffer
          if (!resumingSame) {
            this.snapshots.length = 0;
            this.arrivals.length = 0;
            this.names.clear();
            this.heldSince.fill(-Infinity);
          }
        }
        this.connected = true;
        if (this.lowBw) this.options.send(encodeCmd(CmdKind.SetLowBandwidth, '1')); // a new connection starts at full rate
        this.sessionToken = msg.sessionToken;
        this.myId = msg.playerId;
        this.status = msg.resumed ? 'connected (resumed)' : 'connected';
        this.seed = msg.seed;
        this.map = getMap(msg.mapId);
        this.tuning = parseTuning(msg.tuningJson, this.tuning);
        this.applyOverrides(msg.overridesJson);
        if (this.pendingTuning) {
          // the edit made while we were away: ours again, and the room's once it hears it
          this.tuning = { ...this.pendingTuning };
          this.options.send(encodeCmd(CmdKind.SetTuning, JSON.stringify(this.pendingTuning)));
          this.pendingTuning = null;
        }
        const rtt = now - this.helloAt;
        this.rtt.add(rtt);
        // Inputs sent now arrive ~1 RTT after the server sent this; land them mid-band early.
        const o = this.pacer.options;
        this.startTick = msg.serverTick + Math.ceil(rtt / TICK_MS + (o.low + o.high) / 2 + 0.5);
        this.startAt = now;
        // same player: keep predicting from the old state until the first snapshot re-anchors it
        if (resumingSame) {
          this.resyncPending = true;
          this.predictor!.game.tuning = this.tuning;
          if (this.ownShots) this.ownShots.tuning = this.tuning;
        } else {
          this.predictor = new Predictor(new Game({ map: this.map, seed: this.seed, tuning: this.tuning, dummies: false }), msg.playerId, this.options.name);
          this.ownShots = new OwnProjectiles(this.map, this.seed, this.tuning);
        }
        this.burstLeft = PING_BURST;
        this.nextPingAt = now;
        break;
      }
      case MsgType.Pong:
        this.rtt.add(now - msg.clientTime);
        break;
      case MsgType.Roster: {
        // ids are reused: snapshots from before a player's `since` show whoever had the id before
        for (const e of msg.entries) if (e.id >= 0 && e.id < MAX_PLAYERS) this.heldSince[e.id] = e.since;
        this.names.clear();
        for (const e of msg.entries) this.names.set(e.id, e.id === this.myId ? 'You' : e.name);
        break;
      }
      case MsgType.Tuning:
        this.tuning = parseTuning(msg.tuningJson, this.tuning);
        if (this.predictor) this.predictor.game.tuning = this.tuning;
        if (this.ownShots) this.ownShots.tuning = this.tuning;
        break;
      case MsgType.Overrides:
        this.applyOverrides(msg.overridesJson);
        break;
      case MsgType.Snapshot:
        this.onSnapshot(msg, now, bytes.length);
        break;
      case MsgType.Kick:
        this.status = `kicked: ${msg.reason}`;
        break;
      case MsgType.Debug:
        this.rewinds.push({ msg, recvMs: now });
        if (this.rewinds.length > 32) this.rewinds.shift();
        break;
    }
    return msg;
  }

  private onSnapshot(msg: SnapshotMsg, now: number, size: number): void {
    if (this.lastSeq >= 0) {
      // seqs run 1..65535 (0 means "nothing acked"), so they wrap mod 65535
      const gap = (msg.seq - this.lastSeq + 0xffff) % 0xffff;
      if (gap === 0 || gap >= 0x8000) return; // duplicate or older than what we have
      // low-bandwidth clients get every other snapshot of the room's sequence (and just after a
      // switch either rate is fine)
      const per = this.lowBw || now < this.rateChangeUntil ? 2 : 1;
      this.seqWindow.push({ at: now, lost: Math.max(0, Math.round(gap / per) - 1) });
    }
    this.lastSeq = msg.seq;
    this.snapshots.push({ msg, recvMs: now, bytes: size });
    this.arrivals.push(now - msg.serverTick * TICK_MS);
    if (this.arrivals.length > INTERP_WINDOW) this.arrivals.shift();
    if (this.adaptive) this.interpTarget = this.adaptInterpDelay();
    this.ownShots?.onSnapshot(msg, this.myId);
    if (this.snapshots.length > SNAPSHOT_BUFFER) this.snapshots.shift();

    const pred = this.predictor;
    if (!pred || !msg.local) return;
    const ack = unwrapTick(msg.ackInputTick, msg.serverTick - 1);
    if (!pred.started || this.resyncPending) {
      this.resyncPending = false;
      // first state of our player: predict from it, running ahead to the start estimate
      pred.reset(msg.local, ack + 1);
      const target = Math.round(this.startTick + (now - this.startAt) / TICK_MS);
      pred.fastForward(Math.max(ack + 2, target), createInput());
      this.acc = 0;
      this.firstStatAt = now;
      return;
    }
    this.pacer.onReport(msg.inputBufferHealth, now, ack);
    const kind = pred.reconcile(ack, msg.local);
    this.outcomes[kind]++;
    if (kind === 'corrected') this.correctionTimes.push(now);
    if (kind === 'corrected' || kind === 'mispredicted') this.mispredictionTimes.push(now);
  }

  /**
   * Advances the client clock by dt (real seconds): predicts and sends one input per tick at
   * 60 Hz × the pacer's time scale.
   */
  update(dtSec: number, sample: InputSource): void {
    const now = this.options.now();
    if (this.adaptive) {
      const d = this.interpTarget - this.interpDelayMs;
      const step = Math.min(dtSec, 0.25) * (d > 0 ? INTERP_GROW_PER_SEC : INTERP_SHRINK_PER_SEC);
      this.interpDelayMs += Math.max(-step, Math.min(step, d));
    }
    if (!this.connected || this.resyncPending) {
      this.predictor?.decayOffset(dtSec);
      return;
    }
    if (now >= this.nextPingAt) {
      this.options.send(encodePing(now));
      this.nextPingAt = now + (--this.burstLeft > 0 ? PING_BURST_INTERVAL_MS : PING_INTERVAL_MS);
    }
    const pred = this.predictor;
    if (!pred?.started) {
      pred?.decayOffset(dtSec);
      return;
    }

    const jump = this.pacer.takeJump();
    if (jump > 0) {
      // far behind the server (e.g. the tab slept): run ahead with the held input
      pred.fastForward(pred.tick + jump, this.input);
      this.sendInput();
    } else if (jump < 0) this.acc += jump * DT; // far ahead: hold still until the server catches up
    if (jump !== 0) this.pacer.jumpApplied(pred.tick - 1, now);

    this.acc += Math.min(dtSec, 0.25) * this.pacer.update(dtSec);
    const stalled = this.stalled(now);
    let held = 0;
    let steps = 0;
    while (this.acc >= DT && steps < MAX_STEPS_PER_UPDATE) {
      sample(pred.player, this.input);
      // what the player was looking at for this tick's input (lag compensation, docs/05 §7)
      this.sampledView[pred.tick & 63] = Number.isNaN(this.shownRenderTick) ? this.remoteRenderTick() : this.shownRenderTick;
      this.sampledFor[pred.tick & 63] = pred.tick;
      pred.step(this.input);
      this.ownShots?.afterStep(pred.tick - 1, pred.game, pred.player.id, pred.events);
      for (const e of pred.events) this.predictedEvents.push(e);
      pred.events.length = 0;
      if (!this.lowBw || ++this.unsentTicks >= 2) {
        if (stalled) held++;
        else this.sendInput();
        this.unsentTicks = 0;
      }
      this.acc -= DT;
      steps++;
    }
    if (held > 0 && now >= this.nextStalledInputAt) {
      // the newest tick's input and its redundant copies
      this.sendInput();
      this.nextStalledInputAt = now + STALLED_INPUT_INTERVAL_MS;
      held--;
    }
    this.inputsHeldBack += held;
    if (steps === MAX_STEPS_PER_UPDATE && this.acc > DT) this.acc = 0; // drop time; the pacer resyncs
    pred.decayOffset(dtSec);
  }

  /** Fraction of the way to the next predicted tick, for render interpolation. */
  get alpha(): number {
    return Math.max(0, Math.min(1, this.acc / DT));
  }

  /** Own predicted events since the last call (instant feedback; the server's copies are skipped). */
  drainEvents(): SimEvent[] {
    const out = this.predictedEvents.slice();
    this.predictedEvents.length = 0;
    return out;
  }

  /**
   * Server tick (fractional, 1/256 resolution) at which remote players are drawn: the newest
   * snapshots' best-case arrival time defines the server clock, minus the interpolation delay.
   * Call it when drawing a frame: the next input reports this tick, so the server's lag
   * compensation tests shots against exactly what that frame showed.
   */
  remoteRenderTick(now = this.options.now()): number {
    let offset = Infinity;
    for (const s of this.snapshots) offset = Math.min(offset, s.recvMs - s.msg.serverTick * TICK_MS);
    const tick = offset === Infinity ? 0 : Math.max(0, quantizeRenderTick((now - offset - this.interpDelayMs) / TICK_MS));
    this.shownRenderTick = tick;
    return tick;
  }

  /** The render tick of the last frame drawn (what the next input reports), NaN before the first. */
  get viewTick(): number {
    return this.shownRenderTick;
  }

  /** Where remote player `id` is drawn at `renderTick` (null if no snapshot has it). */
  remotePose(id: number, renderTick: number, out: RemotePose): RemotePose | null {
    const br = bracketSnapshots(this.snapshots, renderTick, this.bracket);
    if (!br) return null;
    const newest = this.snapshots[this.snapshots.length - 1]!.msg;
    const since = id >= 0 && id < MAX_PLAYERS ? this.heldSince[id]! : -Infinity;
    if (newest.serverTick < since) return null;
    const pb = newest.players.find((p) => p.id === id);
    if (!pb) return null;
    // a snapshot from before this id's holder got it shows someone else: hold the newest pose instead
    const p0 = (br.a.serverTick >= since ? br.a.players.find((p) => p.id === id) : undefined) ?? pb;
    const p1 = (br.b.serverTick >= since ? br.b.players.find((p) => p.id === id) : undefined) ?? pb;
    lerpPosition(p0.x, p0.y, p1.x, p1.y, br.alpha, this.lerped);
    out.x = this.lerped.x;
    out.y = this.lerped.y;
    // past the newest snapshot: carried on along its velocity for a moment, not frozen (interpolation.ts)
    if (renderTick > newest.serverTick && p1 === pb && pb.alive) this.extrapolate(pb, extrapolationTicks(renderTick - newest.serverTick) * TICK_S, out);
    out.src = br.alpha < 0.5 ? p0 : p1;
    out.meleeTicks = swingAt(p0.meleeTicks, br.a.serverTick, p1.meleeTicks, br.b.serverTick, renderTick);
    return out;
  }

  /**
   * Moves `out` (at `p`'s newest pose) on along `p`'s velocity for `seconds`, stopping short of
   * anything solid on the way (one-way platforms aside): a carried-on player doesn't walk into a
   * wall or sink into the floor. The map is the prediction's (none yet: no check).
   */
  private extrapolate(p: SnapshotPlayer, seconds: number, out: RemotePose): void {
    const dx = p.vx * seconds;
    const dy = p.vy * seconds;
    let len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-4) return;
    const world = this.predictor?.game.world;
    if (world) {
      const ux = dx / len;
      const uy = dy / len;
      // from the body's middle, kept a body's half-extent from what it would hit
      const reach = len + Math.abs(ux) * EXTRAPOLATE_HALF_WIDTH + Math.abs(uy) * EXTRAPOLATE_HALF_HEIGHT;
      if (world.raycast(p.x, p.y + EXTRAPOLATE_HALF_HEIGHT, ux, uy, reach, SegFlag.OneWay, this.extrapolateHit)) {
        len = Math.max(0, Math.min(len, this.extrapolateHit.t - Math.abs(ux) * EXTRAPOLATE_HALF_WIDTH - Math.abs(uy) * EXTRAPOLATE_HALF_HEIGHT));
      }
      out.x = p.x + ux * len;
      out.y = p.y + uy * len;
      return;
    }
    out.x = p.x + dx;
    out.y = p.y + dy;
  }

  /**
   * The interpolation delay the last few seconds of snapshots ask for (docs/05 §10): one snapshot
   * interval, plus how much later than the quickest the slow ones arrived (95th percentile), plus an
   * interval for each snapshot lost in a row in the longer gaps (the next one must bridge them). A clean path
   * gets ~60 ms (was a fixed 100), 150 ms ±40 jitter ~130 ms; it never goes past 200 ms, where lag
   * compensation's cap stops covering it. Remote players freeze when this is too short.
   */
  private adaptInterpDelay(): number {
    const a = this.arrivals;
    if (a.length < 10) return this.interpTarget;
    let best = Infinity;
    for (const x of a) best = Math.min(best, x);
    const late = a.map((x) => x - best).sort((x, y) => x - y);
    const p95 = late[Math.min(late.length - 1, Math.floor(0.95 * late.length))]!;
    const interval = (this.lowBw ? 4 : 2) * TICK_MS;
    // gaps: a loss needs one more interval to bridge, a burst as many as it lost in a row (the
    // second-longest gap of the last 10 s: one odd burst doesn't set it, a habit does)
    const gaps = this.seqWindow.map((w) => w.lost).sort((x, y) => y - x);
    const gap = Math.min(3, gaps[1] ?? 0);
    const floor = this.lowBw ? LOW_BANDWIDTH_INTERP_DELAY_MS : MIN_INTERP_DELAY_MS;
    return Math.max(floor, Math.min(MAX_INTERP_DELAY_MS, interval * (1 + gap) + p95 + 10));
  }

  /**
   * Grenades and projectiles to draw now: the newest snapshot's, with our own predicted ones from
   * the throw instead of the server's copies (OwnProjectiles).
   */
  grenadeViews(_now = this.options.now()): GrenadeView[] {
    const newest = this.snapshots[this.snapshots.length - 1]?.msg ?? null;
    if (this.ownShots) return this.ownShots.views(newest);
    return (newest?.grenades ?? []).map((g) => ({ key: `s${g.id}`, id: g.id, owner: g.owner, x: g.x, y: g.y, vx: g.vx, vy: g.vy, fuse: g.fuse, type: g.type, state: g.state }));
  }

  /**
   * For a view that draws the snapshots' grenades on its own timeline (render3d's OnlineView): our
   * predicted ones, and whether a server grenade is one of them (skip it).
   */
  ownGrenadeViews(): GrenadeView[] {
    return this.ownShots?.ownViews() ?? [];
  }

  predictsGrenade(id: number): boolean {
    return this.ownShots?.predicts(id) ?? false;
  }

  get interpDelay(): number {
    return this.interpDelayMs;
  }

  stats(now = this.options.now()): NetClientStats {
    const window = (times: number[]) => {
      while (times.length > 0 && times[0]! < now - RATE_WINDOW_MS) times.shift();
      const span = Math.min(RATE_WINDOW_MS, Math.max(10_000, now - this.firstStatAt));
      return (times.length * 60_000) / span;
    };
    while (this.seqWindow.length > 0 && this.seqWindow[0]!.at < now - 10_000) this.seqWindow.shift();
    let lost = 0;
    for (const s of this.seqWindow) lost += s.lost;
    const received = this.seqWindow.length;
    const pred = this.predictor;
    const lossPct = received + lost > 0 ? (100 * lost) / (received + lost) : 0;
    if (lossPct > 10) this.heavyLossSince ||= now;
    else this.heavyLossSince = 0;
    return {
      rttMs: this.rtt.median,
      rttJitterMs: this.rtt.jitter,
      snapshotLossPct: lossPct,
      inputBufferHealth: this.pacer.health,
      timeScale: this.pacer.timeScale,
      unackedTicks: pred?.started ? pred.tick - 1 - pred.lastAck : 0,
      correctionsPerMin: window(this.correctionTimes),
      mispredictionsPerMin: window(this.mispredictionTimes),
      lastErrorCm: (pred?.stats.lastErrorM ?? 0) * 100,
      resyncs: this.pacer.resyncs,
      lowBandwidth: this.lowBw,
      suggestLowBandwidth: !this.lowBw && this.heavyLossSince > 0 && now - this.heavyLossSince >= 5000,
    };
  }

  /** A stream transport that has stalled: what we send now would only pile up (NetClientOptions.stream). */
  private stalled(now: number): boolean {
    if (this.options.stream && !this.options.stream()) return false;
    return now - this.lastHeardAt > STALL_MS || (this.options.backlog?.() ?? 0) > BACKLOG_LIMIT;
  }

  /** The render tick shown when `tick`'s input was sampled (NaN if it wasn't sampled, e.g. fast-forwarded). */
  private viewAt(tick: number): number {
    return this.sampledFor[tick & 63] === tick ? this.sampledView[tick & 63]! : Number.NaN;
  }

  private sendInput(): void {
    const pred = this.predictor!;
    const newest = pred.tick - 1;
    // what the player was looking at when each input was sampled (lag compensation, docs/05 §7):
    // the newest one's render tick, and how much older each other input's view was. Exact even
    // when several ticks are sampled in one frame (low-bandwidth batching, slow frames)
    let renderTick = this.viewAt(newest);
    if (Number.isNaN(renderTick)) renderTick = Number.isNaN(this.shownRenderTick) ? this.remoteRenderTick() : this.shownRenderTick;
    let n = 0;
    for (let k = 0; k < this.redundancy; k++) {
      const input = pred.inputAt(newest - k);
      if (!input) break;
      const view = this.viewAt(newest - k);
      this.packetLags[n] = Number.isNaN(view) ? k : Math.max(0, renderTick - view);
      this.packetInputs[n++] = input;
    }
    if (n === 0) return;
    const bytes = encodeInputInto(
      this.writer,
      {
        newestTick: newest & 0xffff,
        ackSnapshotSeq: Math.max(0, this.lastSeq) & 0xffff,
        renderTick: Math.floor(renderTick) & 0xffff,
        renderFrac: Math.floor((renderTick % 1) * 256),
        inputs: this.packetInputs,
        renderLags: this.packetLags,
      },
      n,
    );
    this.options.send(bytes.slice()); // the conditioner may hold on to it
  }
}

function parseTuning(json: string, fallback: Tuning): Tuning {
  try {
    return createTuning(JSON.parse(json) as Partial<Tuning>);
  } catch {
    return fallback;
  }
}
