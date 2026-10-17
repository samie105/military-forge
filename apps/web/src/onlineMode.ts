/**
 * Online mode: the local player is predicted with the shared sim and reconciled against the
 * server's exact state (docs/05 §8); remote players are interpolated ~100 ms in the past (§10).
 * Inputs are tagged with the server tick they're for and paced by the server's input-buffer health
 * (§4). All of that lives in @military-forge/netcode's NetClient; this file is the browser glue:
 * WebSocket, network conditioner (§15.2), input sampling and the render Frame.
 *
 * A dropped connection reconnects on its own (backoff 250 ms → 2 s, for up to 20 s: the room's
 * grace) and presents the session token, so the player comes back where it was (§13).
 *
 * The transport is WebTransport (UDP datagrams) when the server has a gateway and the browser
 * supports it, else WebSocket (transport.ts, §2.1). `?transport=ws|wt` forces one.
 */
import { weapons, NO_WEAPON, type MapDef, type Tuning } from '@military-forge/content';
import { ConditionedLink, NetClient, TICK_MS, describeNetSim, type ConditionerSettings, type RemotePose, type Scheduler } from '@military-forge/netcode';
import { CloseCode, MsgType, isUnreliableMessage, type SnapshotPlayer } from '@military-forge/protocol';
import { u16ToAngle } from '@military-forge/shared';
import type { PlayerState, SimEvent } from '@military-forge/sim';
import type { Camera } from './camera';
import type { InputSampler } from './input';
import type { Renderer } from './render';
import { connectGame, type GameTransport } from './transport';
import type { Frame, PlayerView, RewindView } from './view';

/** how long to keep trying after a drop: the room keeps our player this long */
const RECONNECT_WINDOW_MS = 20_000;
/** close codes that mean "don't come back" */
const WT_SILENCE_MS = 1500;
const FATAL_CLOSE = new Set<number>([CloseCode.VersionMismatch, CloseCode.RoomFull, CloseCode.BadMessage, CloseCode.RateLimited, CloseCode.DuplicateSession]);

const browserScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export class OnlineMode {
  private transport: GameTransport | null = null;
  /** how the current/last connection was made, for the net graph */
  private transportNote = '';
  private disposed = false;
  private kicked = false;
  /** first drop of the current outage (0 = connected) */
  private droppedAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer = 0;
  /** when the transport last delivered anything (the silence watchdog) */
  private lastMessageAt = 0;
  /** the next attempt goes straight to WebSocket (WebTransport just went silent on us) */
  private skipWebTransport = false;
  readonly net: NetClient;
  private readonly up: ConditionedLink;
  private readonly down: ConditionedLink;
  private status = 'connecting…';
  private bytesIn = 0;
  private bytesOut = 0;
  private snapCount = 0;
  private rate = { kbIn: 0, kbOut: 0, snaps: 0, windowStart: performance.now() };
  private readonly renderPos = { x: 0, y: 0 };
  private readonly remotePos: RemotePose = { x: 0, y: 0, src: null! };
  /** called when the room's tuning changed under us (another client's live edit) */
  onTuningFromServer: () => void = () => {};

  constructor(
    private readonly url: string,
    name: string,
    private readonly sampler: InputSampler,
    private readonly camera: Camera,
    private readonly renderer: Renderer,
    private readonly onFatal: (message: string) => void,
    /** network conditioner settings, edited live by the debug panel */
    readonly netSim: ConditionerSettings,
    /** 'auto': WebTransport when available, else WebSocket */
    private readonly preferTransport: 'auto' | 'wt' | 'ws' = 'auto',
  ) {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.up = new ConditionedLink(netSim.up, () => netSim.enabled, browserScheduler, (b) => this.rawSend(b), isUnreliableMessage, seed);
    this.down = new ConditionedLink(netSim.down, () => netSim.enabled, browserScheduler, (b) => this.onMessage(b), isUnreliableMessage, seed ^ 0x9e3779b9);
    this.net = new NetClient({
      name,
      now: () => performance.now(),
      send: (bytes) => {
        this.bytesOut += bytes.length;
        this.up.send(bytes);
      },
    });

    this.open();
  }

  private open(): void {
    const attempt = {};
    this.currentAttempt = attempt;
    const prefer = this.skipWebTransport && this.preferTransport === 'auto' ? 'ws' : this.preferTransport;
    this.skipWebTransport = false;
    connectGame(this.url, prefer, {
      onMessage: (bytes) => {
        if (this.currentAttempt !== attempt) return;
        this.lastMessageAt = performance.now();
        this.bytesIn += bytes.length;
        this.down.send(bytes);
      },
      onClose: (code, reason) => {
        if (this.currentAttempt === attempt) this.dropped(code, reason);
      },
    }, this.droppedAt !== 0).then(
      ({ transport, fallbackReason }) => {
        if (this.currentAttempt !== attempt || this.disposed) return transport.close();
        this.transport = transport;
        this.lastMessageAt = performance.now();
        // the conditioner models what loss does to this transport: retransmit stalls on TCP
        this.netSim.up.stream = this.netSim.down.stream = transport.kind === 'ws';
        this.transportNote = transport.kind === 'wt' ? 'WebTransport (UDP)' : `WebSocket${fallbackReason ? ` (${fallbackReason})` : ''}`;
        this.status = this.droppedAt ? 'resuming…' : 'joining…';
        this.net.onOpen();
      },
      (e: Error) => {
        if (this.currentAttempt === attempt) this.dropped(1006, e.message);
      },
    );
  }

  private currentAttempt: object | null = null;

  private dropped(code: number, reason: string): void {
    if (this.disposed) return;
    this.transport = null;
    const why = `${code}${reason ? `: ${reason}` : ''}`;
    const now = performance.now();
    if (!this.droppedAt) this.droppedAt = now;
    // never welcomed, kicked, refused, or out of time: give up
    const canRetry = this.net.sessionToken !== '' && !this.kicked && !FATAL_CLOSE.has(code) && now - this.droppedAt < RECONNECT_WINDOW_MS;
    if (!canRetry) {
      this.status = `disconnected (${why})`;
      this.onFatal(`${this.status} — is the game server running? (pnpm dev)`);
      return;
    }
    this.net.onClose();
    const delay = Math.min(2000, 250 * 2 ** this.reconnectAttempt++);
    this.status = `reconnecting… (${why}; retry in ${(delay / 1000).toFixed(2)} s)`;
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  get map(): MapDef {
    return this.net.map;
  }

  private rawSend(bytes: Uint8Array): void {
    this.transport?.send(bytes);
  }


  private onMessage(bytes: Uint8Array): void {
    const msg = this.net.receive(bytes);
    if (!msg) return;
    switch (msg.type) {
      case MsgType.Welcome:
        this.status = msg.resumed ? `connected (resumed after ${((performance.now() - this.droppedAt) / 1000).toFixed(1)} s)` : 'connected';
        this.droppedAt = 0;
        this.reconnectAttempt = 0;
        break;
      case MsgType.Roster:
        this.renderer.setNames(this.net.names);
        break;
      case MsgType.Tuning:
        this.onTuningFromServer();
        break;
      case MsgType.Snapshot: {
        this.snapCount++;
        // own shots are drawn from the prediction the moment they're fired; skip the server's copies
        const me = this.net.myId;
        // SOUND events (gunfire off screen) have no renderer yet: audio comes later
        this.renderer.onEvents(
          msg.events.filter((e): e is SimEvent => e.type !== 'sound' && !(e.type === 'shot' && e.shooter === me)),
          me,
        );
        break;
      }
      case MsgType.Kick:
        this.kicked = true;
        this.status = `kicked: ${msg.reason}`;
        this.onFatal(this.status);
        break;
      default:
        break;
    }
  }

  tuning(): Tuning {
    return this.net.tuning;
  }

  setTuning(t: Tuning): void {
    this.net.setTuning(t);
  }

  respawn(): void {
    this.net.respawn();
  }

  zoomMax(): number {
    const me = this.net.predictor?.player;
    if (!me?.alive) return 1;
    const ws = me.weapons.filter((w) => w.def !== NO_WEAPON).map((w) => weapons[w.def]!.zoomMax);
    return me.dual ? Math.min(...ws) : (weapons[me.weapons[me.active]!.def]?.zoomMax ?? 1);
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.reconnectTimer);
    this.currentAttempt = null;
    this.up.dispose();
    this.down.dispose();
    this.transport?.close();
  }

  /**
   * A WebTransport session can stay "open" with nothing arriving (a hung gateway, a path that went
   * dark) until QUIC's idle timeout. Snapshots come 15–30 times a second, so after 1.5 s of silence
   * give up on it and resume over WebSocket.
   */
  private checkSilence(now: number): void {
    const t = this.transport;
    if (t?.kind !== 'wt' || !this.net.isConnected || now - this.lastMessageAt < WT_SILENCE_MS) return;
    this.currentAttempt = null; // its close is ours, not a drop to handle twice
    t.close(1000, 'no traffic');
    this.skipWebTransport = true;
    this.dropped(1006, `no traffic for ${WT_SILENCE_MS / 1000} s`);
  }

  update(dt: number): Frame {
    const now = performance.now();
    this.checkSilence(now);
    const t = this.net.tuning;
    // 60 Hz (± the pacer's 3 %) predicted ticks, one input each, aimed from the predicted shoulder
    this.net.update(dt, (me: PlayerState | null, out) => {
      const sx = me ? me.shoulderX(t) : 0;
      const sy = me ? me.shoulderY(t) : 0;
      this.sampler.sample(this.camera, sx, sy, out);
    });
    const own: SimEvent[] = this.net.drainEvents().filter((e) => e.type === 'shot');
    if (own.length) this.renderer.onEvents(own, this.net.myId);

    // rates for the net graph
    const windowMs = now - this.rate.windowStart;
    if (windowMs >= 1000) {
      this.rate = { kbIn: this.bytesIn / 1024 / (windowMs / 1000), kbOut: this.bytesOut / 1024 / (windowMs / 1000), snaps: this.snapCount / (windowMs / 1000), windowStart: now };
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.snapCount = 0;
    }

    const s = this.net.stats(now);
    const net = {
      rttMs: s.rttMs,
      snapshotsPerSec: this.rate.snaps,
      kbInPerSec: this.rate.kbIn,
      kbOutPerSec: this.rate.kbOut,
      interpDelayMs: this.net.interpDelay,
      status: `${this.status}${this.transportNote ? ` · ${this.transportNote}` : ''}`,
      prediction: {
        inputBufferHealth: s.inputBufferHealth,
        timeScale: s.timeScale,
        unackedTicks: s.unackedTicks,
        correctionsPerMin: s.correctionsPerMin,
        mispredictionsPerMin: s.mispredictionsPerMin,
        lastErrorCm: s.lastErrorCm,
        resyncs: s.resyncs,
        snapshotLossPct: s.snapshotLossPct,
        rttJitterMs: s.rttJitterMs,
        netSim: describeNetSim(this.netSim),
        lowBandwidth: s.lowBandwidth,
        suggestLowBandwidth: s.suggestLowBandwidth,
      },
    };
    const snaps = this.net.snapshots;
    const newest = snaps[snaps.length - 1];
    if (!newest) return { tick: 0, localId: -1, players: [], grenades: [], net };

    // remote players, interpolated around the render tick; the next input reports this tick, so
    // the server's lag compensation tests our shots against exactly this picture (docs/05 §7)
    const renderTick = this.net.remoteRenderTick(now);
    const players: PlayerView[] = [];
    const pred = this.net.predictor;
    for (const pb of newest.msg.players) {
      const isLocal = pb.id === this.net.myId;
      if (isLocal && pred?.started) {
        players.push(this.localView(pb));
        continue;
      }
      const pose = this.net.remotePose(pb.id, renderTick, this.remotePos);
      if (pose) players.push(this.remoteView(pose.src, isLocal, pose.x, pose.y));
    }
    return {
      tick: pred?.started ? pred.tick : newest.msg.serverTick,
      localId: this.net.myId,
      players,
      grenades: newest.msg.grenades.map((g) => ({ x: g.x, y: g.y, fuse: g.fuse })),
      net,
      rewinds: this.rewindViews(now),
    };
  }

  /** The server's rewinds of our recent shots (dev rooms), for the debug overlay. */
  private rewindViews(now: number): RewindView[] {
    const out: RewindView[] = [];
    for (const { msg, recvMs } of this.net.rewinds) {
      const age = (now - recvMs) / 1000;
      if (age < 1) out.push({ age, rewindMs: msg.rewindTicks * TICK_MS, clamped: msg.clamped, targets: msg.targets });
    }
    return out;
  }

  /** The predicted local player (server-only counters from the newest snapshot). */
  private localView(server: SnapshotPlayer): PlayerView {
    const pred = this.net.predictor!;
    const p = pred.player;
    const pos = pred.renderPosition(this.net.alpha, this.renderPos);
    return {
      id: p.id,
      name: this.net.names.get(p.id) ?? 'You',
      isBot: false,
      isLocal: true,
      alive: p.alive,
      x: pos.x,
      y: pos.y,
      vx: p.vx,
      vy: p.vy,
      grounded: p.grounded,
      crouched: p.crouched,
      jetting: p.jetting,
      aim: p.aim,
      hp: p.hp,
      fuel: p.fuel,
      fuelRegenDelay: p.fuelRegenDelay,
      frags: p.frags,
      active: p.active,
      dual: p.dual,
      weapons: p.weapons.map((w) => ({ def: w.def, mag: w.mag, reserve: w.reserve, reloadTicks: w.reloadTicks })),
      meleeTicks: p.meleeTicks,
      respawnTicks: server.respawnTicks,
      kills: server.kills,
      deaths: server.deaths,
    };
  }

  private remoteView(src: SnapshotPlayer, isLocal: boolean, x: number, y: number): PlayerView {
    return {
      id: src.id,
      name: this.net.names.get(src.id) ?? `#${src.id}`,
      isBot: src.isBot,
      isLocal,
      alive: src.alive,
      x,
      y,
      vx: src.vx,
      vy: src.vy,
      grounded: src.grounded,
      crouched: src.crouched,
      jetting: src.jetting,
      aim: u16ToAngle(src.aim),
      hp: src.hp,
      fuel: 0,
      fuelRegenDelay: -1,
      frags: 0,
      active: src.active,
      dual: src.dual,
      // other players' ammo isn't sent (only the local block has it)
      weapons: src.weapons.map((w) => ({ def: w.def, mag: 0, reserve: 0, reloadTicks: 0 })),
      respawnTicks: src.respawnTicks,
      kills: src.kills,
      deaths: src.deaths,
    };
  }
}
