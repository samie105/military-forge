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
 *
 * Rooms by code (the app shell): MATCH_STATE (0x23) drives the lobby, countdown and results
 * screens; lobby commands go out as CMDs; the predicted player gets the server's input freeze
 * (docs/06 §5.2) so the countdown doesn't mispredict; the session token is kept in sessionStorage
 * so a page reload resumes the same player within the room's reconnect grace.
 */
import { weapons, NO_WEAPON, type MapDef, type Tuning } from '@military-forge/content';
import { ConditionedLink, NetClient, TICK_MS, describeNetSim, type ConditionerSettings, type RemotePose, type Scheduler } from '@military-forge/netcode';
import { CloseCode, CmdKind, MsgType, encodeCmd, isUnreliableMessage, type MatchStateMsg, type SnapshotPlayer } from '@military-forge/protocol';
import { u16ToAngle } from '@military-forge/shared';
import { MatchPhase, TICK_RATE, blindIntensity, type PlayerState, type SimEvent } from '@military-forge/sim';
import type { Camera } from './camera';
import { cloudView, statusView } from './grenadeViews';
import type { InputSampler } from './input';
import { mapEventView } from './mapEvent';
import { ThrowPreview } from './throwPreview';
import type { Renderer } from './render';
import { connectGame, type GameTransport } from './transport';
import { mobilityView, shieldView, type CloudView, type Frame, type PlayerView, type RewindView } from './view';

/**
 * How long to keep trying after a drop. The room keeps our player 20 s; after that a rejoin is a new
 * player, which needs a fresh join ticket (OnlineOptions.refreshTicket), so a flaky connection can
 * be out for up to a minute and still come back on its own.
 */
const RECONNECT_WINDOW_MS = 60_000;
const WT_SILENCE_MS = 1500;
/** close codes that mean "don't come back" */
const FATAL_CLOSE = new Set<number>([
  CloseCode.VersionMismatch,
  CloseCode.RoomFull,
  CloseCode.BadMessage,
  CloseCode.RateLimited,
  CloseCode.DuplicateSession,
  CloseCode.NoRoom,
  CloseCode.TicketInvalid,
  1000,
  1008,
  1011,
]);
/** how often the scoreboard's ping column hears from us */
const PING_REPORT_MS = 3000;

export type ConnectionState = 'connecting' | 'joining' | 'connected' | 'reconnecting' | 'failed';

/** What the shell shows about the connection. */
export interface ConnectionInfo {
  state: ConnectionState;
  /** reconnecting: the last drop; failed: why it ended (close reason, or the error) */
  detail: string;
  /** the close code that ended it (failed), 0 otherwise */
  code: number;
  /** reconnecting: when this outage started (performance.now), 0 otherwise */
  since: number;
}

export interface OnlineOptions {
  /** a room by code: its MATCH_STATE drives the shell, and the session survives a page reload */
  room?: string;
  /** the API's join ticket for that room (docs/06 §6); a retry after a failure asks the API for a new one */
  ticket?: string;
  /**
   * A fresh ticket for the same room (the API's join): when a reconnect comes back after the room let
   * our player go, the old ticket is spent or expired and the server says so (4007).
   */
  refreshTicket?: () => Promise<string | null>;
}

const sessionKey = (room: string) => `room.session.${room}`;

function loadToken(room: string | undefined): string {
  if (!room) return '';
  try {
    return sessionStorage.getItem(sessionKey(room)) ?? '';
  } catch {
    return '';
  }
}

function saveToken(room: string | undefined, token: string | null): void {
  if (!room) return;
  try {
    if (token) sessionStorage.setItem(sessionKey(room), token);
    else sessionStorage.removeItem(sessionKey(room));
  } catch {
    /* no storage: a reload joins as a new player */
  }
}

const browserScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export class OnlineMode {
  /** the throw arc while a grenade throw is aimed (both views draw it) */
  private readonly throwPreview = new ThrowPreview();
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
  private conn: ConnectionInfo = { state: 'connecting', detail: '', code: 0, since: 0 };
  /** the room's match (rooms by code), newest first received */
  matchState: MatchStateMsg | null = null;
  private nextPingReportAt = 0;
  private bytesIn = 0;
  private bytesOut = 0;
  private snapCount = 0;
  private rate = { kbIn: 0, kbOut: 0, snaps: 0, windowStart: performance.now() };
  private readonly renderPos = { x: 0, y: 0 };
  /** the most blinded the predicted local player was over this frame's ticks (a flashbang inside a hitch still shows) */
  private peakBlind = 0;
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
    private readonly options: OnlineOptions = {},
  ) {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.up = new ConditionedLink(netSim.up, () => netSim.enabled, browserScheduler, (b) => this.rawSend(b), isUnreliableMessage, seed);
    this.down = new ConditionedLink(netSim.down, () => netSim.enabled, browserScheduler, (b) => this.onMessage(b), isUnreliableMessage, seed ^ 0x9e3779b9);
    this.net = new NetClient({
      name,
      ...(options.ticket ? { ticket: options.ticket } : {}),
      now: () => performance.now(),
      send: (bytes) => {
        this.bytesOut += bytes.length;
        this.up.send(bytes);
      },
    });
    // a reload resumes the same player while the room still holds it
    this.net.sessionToken = loadToken(options.room);

    this.open();
  }

  /** The room code this mode plays in ('' = the dev room). */
  get room(): string {
    return this.options.room ?? '';
  }

  get connection(): ConnectionInfo {
    return this.conn;
  }

  get localId(): number {
    return this.net.myId;
  }

  /**
   * Best guess of the server's tick right now: the newest snapshot's tick plus the time since it
   * arrived (timers on the lobby, countdown and results screens).
   */
  serverTickNow(now = performance.now()): number {
    const snaps = this.net.snapshots;
    const newest = snaps[snaps.length - 1];
    if (!newest) return this.matchState?.phaseStartTick ?? 0;
    return newest.msg.serverTick + (now - newest.recvMs) / TICK_MS;
  }

  // ---- lobby and results commands (match rooms) ----

  private sendCmd(kind: number, payload = ''): void {
    if (!this.net.isConnected) return;
    const bytes = encodeCmd(kind, payload);
    this.bytesOut += bytes.length;
    this.up.send(bytes);
  }

  setReady(on: boolean): void {
    this.sendCmd(CmdKind.Ready, on ? '1' : '0');
  }

  startMatch(): void {
    this.sendCmd(CmdKind.StartMatch);
  }

  voteRematch(): void {
    this.sendCmd(CmdKind.Rematch);
  }

  returnToLobby(): void {
    this.sendCmd(CmdKind.ReturnToLobby);
  }

  setMatchSettings(settings: { timeLimit?: number; killLimit?: number; mapId?: string }): void {
    this.sendCmd(CmdKind.MatchSettings, JSON.stringify(settings));
  }

  /** Leaves for good: the server drops the player now (no reconnect grace), then the socket closes. */
  leave(): void {
    this.sendCmd(CmdKind.Leave);
    saveToken(this.options.room, null);
    this.dispose();
  }

  /**
   * The server freezes buttons outside WAITING and IN_PROGRESS (docs/06 §5.2); the prediction must
   * too, or the countdown would mispredict. GO is at a known tick, so it unfreezes on time.
   */
  private frozenAt(tick: number): boolean {
    const s = this.matchState;
    if (!s) return false;
    switch (s.phase) {
      case MatchPhase.Waiting:
      case MatchPhase.InProgress:
        return false;
      case MatchPhase.Countdown:
        return tick < s.phaseStartTick + s.rules.countdown * TICK_RATE;
      default:
        return true;
    }
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
        if (!this.droppedAt) this.conn = { state: 'joining', detail: '', code: 0, since: 0 };
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
    // back after the room let our player go: rejoin as a new player with a fresh ticket
    if (code === CloseCode.TicketInvalid && this.net.sessionToken !== '' && this.options.refreshTicket && now - this.droppedAt < RECONNECT_WINDOW_MS) {
      this.rejoinWithFreshTicket(why);
      return;
    }
    // never welcomed, kicked, refused, or out of time: give up
    const canRetry = this.net.sessionToken !== '' && !this.kicked && !FATAL_CLOSE.has(code) && now - this.droppedAt < RECONNECT_WINDOW_MS;
    if (!canRetry) {
      this.giveUp(code, reason);
      return;
    }
    this.net.onClose();
    const delay = Math.min(2000, 250 * 2 ** this.reconnectAttempt++);
    this.status = `reconnecting… (${why}; retry in ${(delay / 1000).toFixed(2)} s)`;
    this.conn = { state: 'reconnecting', detail: why, code, since: this.droppedAt };
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private giveUp(code: number, reason: string): void {
    this.status = `disconnected (${code}${reason ? `: ${reason}` : ''})`;
    this.conn = { state: 'failed', detail: reason || (code === 1006 ? 'connection lost' : `closed (${code})`), code, since: 0 };
    if (code === CloseCode.DuplicateSession || code === 1000) saveToken(this.options.room, null);
    this.onFatal(`${this.status} — is the game server running? (pnpm dev)`);
  }

  private rejoinWithFreshTicket(why: string): void {
    this.net.onClose();
    this.conn = { state: 'reconnecting', detail: why, code: CloseCode.TicketInvalid, since: this.droppedAt };
    this.status = `rejoining… (${why})`;
    const retry = () => {
      if (this.disposed) return;
      if (performance.now() - this.droppedAt >= RECONNECT_WINDOW_MS) {
        this.giveUp(CloseCode.TicketInvalid, 'could not rejoin the room');
        return;
      }
      this.options.refreshTicket!().then(
        (ticket) => {
          if (this.disposed) return;
          if (ticket === null) {
            this.giveUp(CloseCode.TicketInvalid, 'the room has closed');
            return;
          }
          // the old session token is dead: the server takes the fresh ticket and adds us as a new player
          this.net.ticket = ticket;
          this.open();
        },
        // the API is out too (the same outage): try again shortly
        () => (this.reconnectTimer = window.setTimeout(retry, 2000)),
      );
    };
    retry();
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
        this.conn = { state: 'connected', detail: '', code: 0, since: 0 };
        this.droppedAt = 0;
        this.reconnectAttempt = 0;
        saveToken(this.options.room, msg.sessionToken);
        break;
      case MsgType.MatchState:
        this.matchState = msg;
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
        this.conn = { state: 'failed', detail: msg.reason, code: msg.code, since: 0 };
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
      if (me?.alive) this.peakBlind = Math.max(this.peakBlind, blindIntensity(me));
      this.sampler.sample(this.camera, sx, sy, out);
      const tick = this.net.predictor?.tick;
      if (tick !== undefined && this.frozenAt(tick)) {
        out.buttons = 0;
        out.weaponSelect = 0;
      }
    });
    if (this.net.isConnected && now >= this.nextPingReportAt && this.net.rtt.count > 0) {
      this.nextPingReportAt = now + PING_REPORT_MS;
      this.sendCmd(CmdKind.ReportPing, String(Math.round(this.net.rtt.median)));
    }
    // own shots and dashes are drawn from prediction the moment they happen
    const own: SimEvent[] = this.net.drainEvents().filter((e) => e.type === 'shot' || e.type === 'dash');
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
    const clouds: CloudView[] = [];
    for (const c of newest.msg.clouds) {
      const view = cloudView(c.id, c.type, c.x, c.y, c.age);
      if (view) clouds.push(view);
    }
    return {
      tick: pred?.started ? pred.tick : newest.msg.serverTick,
      localId: this.net.myId,
      players,
      grenades: newest.msg.grenades.map((g) => ({ x: g.x, y: g.y, fuse: g.fuse, type: g.type, state: g.state, id: g.id })),
      pickups: newest.msg.pickups,
      clouds,
      net,
      rewinds: this.rewindViews(now),
      // the predicted game runs the map's event schedule on our own timeline: the banner matches the physics
      mapEvent: pred?.started ? mapEventView(pred.game) : null,
      // the throw arc runs on the predicted game too, from our predicted state
      throwArc: pred?.started ? this.throwPreview.update(pred.game, pred.player, this.sampler.throwAim) : null,
      matchSeed: (this.net.seed + (this.matchState?.number ?? 0)) >>> 0,
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

  private takePeakBlind(): number {
    const peak = this.peakBlind;
    this.peakBlind = 0;
    return peak;
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
      ...statusView(p, this.takePeakBlind()),
      active: p.active,
      dual: p.dual,
      weapons: p.weapons.map((w) => ({ def: w.def, mag: w.mag, reserve: w.reserve, reloadTicks: w.reloadTicks })),
      meleeTicks: p.meleeTicks,
      dashing: p.dashTicks > 0,
      shield: shieldView(p),
      shieldHp: p.shieldHp,
      ...mobilityView(pred.game, p),
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
      dashing: src.dashing,
      // other players' ammo isn't sent (only the local block has it)
      weapons: src.weapons.map((w) => ({ def: w.def, mag: 0, reserve: 0, reloadTicks: 0 })),
      shield: src.shield === 'up' ? 'front' : src.shield === 'slung' ? 'back' : src.shield === 'raising' ? 'raising' : undefined,
      respawnTicks: src.respawnTicks,
      kills: src.kills,
      deaths: src.deaths,
    };
  }
}
