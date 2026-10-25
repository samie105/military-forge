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
import { adminTuning, createTuning, defaultTuning, weapons, NO_WEAPON, type AdminValues, type MapDef, type Tuning } from '@military-forge/content';
import { diag } from './diag/log';
import { JetWatch } from './diag/jetWatch';
import { autoReport } from './diag/report';
import { RECONNECT_WINDOW_MS, reconnectDelay } from './shell/reconnect';
import { adminTuningKeys } from './shell/tune';
import { ConditionedLink, NetClient, TICK_MS, describeNetSim, type ConditionerSettings, type RemotePose, type Scheduler } from '@military-forge/netcode';
import { CloseCode, CmdKind, MsgType, encodeCmd, isUnreliableMessage, type MatchStateMsg, type SnapshotPlayer, type SpectateMsg } from '@military-forge/protocol';
import { u16ToAngle } from '@military-forge/shared';
import { MatchPhase, TICK_RATE, blindIntensity, type PlayerState, type SimEvent } from '@military-forge/sim';
import { audio } from './audio';
import { lookBook, looksFromWire, savedLookIds } from './looks/book';
import type { Camera } from './camera';
import { cloudView, statusView } from './grenadeViews';
import type { InputSampler } from './input';
import { mapEventView } from './mapEvent';
import { AimLinePreview } from './aimLine';
import { ThrowPreview } from './throwPreview';
import type { Renderer } from './render';
import { connectGame, type GameTransport, type TransportHandlers } from './transport';
import { mobilityView, shieldView, type CloudView, type Frame, type PlayerView, type RewindView } from './view';

/**
 * How long to keep trying after a drop. The room keeps our player 20 s; after that a rejoin is a new
 * player, which needs a fresh join ticket (OnlineOptions.refreshTicket), so a flaky connection can
 * be out for up to a minute and still come back on its own.
 */
/**
 * A WebTransport session silent this long is given up for WebSocket. 1.5 s (was) is shorter than a
 * phone's upload queue spike (the owner's MTN 4G: p95 1.35 s round trips, 19 Oct 2026): every spike
 * would have thrown the session away for TCP, the transport that suffers most from them.
 */
const WT_SILENCE_MS = 3000;
/**
 * The same for WebSocket (the onboarding/sockets audit, M1): a TCP path that goes dark doesn't
 * close, it just stops delivering, and the socket stays "open" for as long as the stall lasts (a
 * 47 s lobby stall showed nothing; afterwards TCP's backed-off retransmits took ~15 s more). After
 * 4 s of silence (snapshots come 15–30 a second; a 500 ms phone's worst tail is ~1.3 s) the socket
 * is dropped, the reconnect banner shows, and fresh connections are tried until one gets through.
 */
const WS_SILENCE_MS = 4000;
/** A HELLO that gets no WELCOME in this long: the connection is as good as silent. */
const JOIN_SILENCE_MS = 8000;
/**
 * A reconnect this quick stays out of sight (the owner on a phone, 23 Oct 2026: "keeps returning
 * and returning"): the banner shows only once an outage has lasted this long while the page was in
 * view. Phones drop and resume all the time (an app switch, the notification shade, a 4G stall),
 * and a resume takes ~1–2 s; a banner and a "Back" chip for each read as the game falling over.
 */
export const QUIET_OUTAGE_MS = 3000;

/** a server that said it's updating is back in a few seconds (systemd restarts it at once): the first rejoin waits this long */
const SERVER_UPDATE_WAIT_MS = 3000;
/** how often the watchdog looks (a timer: it runs behind the lobby and in a hidden tab too) */
const WATCHDOG_MS = 100;
/**
 * In play, a connection quiet this long gets a spare opened beside it, and one quiet HEDGE_SWITCH_MS
 * is swapped for the spare (snapshots come 15–30 a second: 0.8 s of nothing is already odd).
 */
const HEDGE_OPEN_MS = 800;
const HEDGE_SWITCH_MS = 1300;
/** close codes that mean "don't come back" */
const FATAL_CLOSE = new Set<number>([
  CloseCode.VersionMismatch,
  CloseCode.RoomFull,
  CloseCode.BadMessage,
  CloseCode.RateLimited,
  CloseCode.DuplicateSession,
  CloseCode.NoRoom,
  CloseCode.TicketInvalid,
  CloseCode.SpectatorsFull,
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
  /** reconnecting: when the tries stop (performance.now), 0 otherwise */
  until: number;
  /** reconnecting: the try under way (1, 2, …); failed: the tries made after the drop */
  attempt: number;
  /** failed: the last round trip and snapshot loss heard before the end (-1: never connected) */
  lastPingMs: number;
  lossPct: number;
}

const FRESH: Pick<ConnectionInfo, 'since' | 'until' | 'attempt' | 'lastPingMs' | 'lossPct'> = { since: 0, until: 0, attempt: 0, lastPingMs: -1, lossPct: 0 };
/** a quick reconnect, as the shell sees it: still connected (OnlineMode.connection) */
const QUIET_CONNECTED: ConnectionInfo = Object.freeze({ state: 'connected', detail: '', code: 0, ...FRESH });

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
  /**
   * A local room (same Wi-Fi, lan/): the connection is made here instead of to a game server, a
   * WebRTC link to the host's browser (or, for the host, a link inside the page). Called again to
   * reconnect. `url` is then only a label.
   */
  connect?: (handlers: TransportHandlers, reconnect: boolean) => Promise<GameTransport>;
  /** a local room (the lobby says so: same Wi-Fi only) */
  local?: boolean;
  /** this page hosts the room (a local room's host plays through a link in the page): its own room closing is no failure to report */
  host?: boolean;
  /** v19: the look to wear (the saved look as cosmetic wire ids); the room holds it to what we own */
  look?: readonly number[];
  /**
   * v20: watch the room as a spectator (no slot, no input; the whole map a few seconds behind).
   * `play()` asks for a slot; the room seats us on this connection when one is free.
   */
  spectate?: boolean;
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

/**
 * The room's tuning changed: what it was and is, `live` once the match is under way here, and which
 * keys the owner's admin page changed (the rest are the host's: attribute them separately).
 */
export type TuningListener = (before: Tuning, after: Tuning, live: boolean, adminKeys: ReadonlySet<keyof Tuning>) => void;

export class OnlineMode {
  /** the throw arc while a grenade throw is aimed (both views draw it) */
  private readonly throwPreview = new ThrowPreview();
  private readonly aimLine = new AimLinePreview();
  private transport: GameTransport | null = null;
  /** how the current/last connection was made, for the net graph */
  private transportNote = '';
  private disposed = false;
  private kicked = false;
  /** first drop of the current outage (0 = connected) */
  private droppedAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer = 0;
  private watchdogTimer = 0;
  /** when the transport last delivered anything (the silence watchdog) */
  private lastMessageAt = 0;
  /** when the watchdog last looked */
  private watchdogAt = 0;
  /**
   * WebTransport failed us in view (went silent, or couldn't connect and fell back): WebSocket from
   * then on, for the rest of this room. It used to be for the next attempt only, so a phone whose
   * WebTransport kept failing went back and forth between the two on every reconnect.
   */
  private stickyWebSocket = false;
  /** when the page last came into view (an outage before that, in the background, wasn't seen) */
  private visibleAt = 0;
  private readonly onVisibility = () => this.visibilityChanged();
  /**
   * Back from the back/forward cache (iOS Safari keeps the page, its memory and the session's token,
   * but not its connection): don't wait out the silence watchdog; drop the dead socket now and resume
   * the session (the mobile audit, §4.9.2). Any other pageshow is a plain "back in view".
   */
  private readonly onPageShow = (e: Event) => {
    const t = this.transport;
    if ((e as PageTransitionEvent).persisted && t && !this.disposed) {
      this.currentAttempt = null; // its close is ours, not a drop to handle twice
      this.transport = null;
      t.close(4000, 'back from the page cache');
      if (!this.droppedAt) this.droppedAt = performance.now();
      this.dropped(1006, 'back from the page cache');
      return;
    }
    this.visibilityChanged();
  };
  private readonly onOnline = () => this.retryNow('back online');
  readonly net: NetClient;
  private readonly up: ConditionedLink;
  private readonly down: ConditionedLink;
  private status = 'connecting…';
  private conn: ConnectionInfo = { state: 'connecting', detail: '', code: 0, ...FRESH };
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
  private readonly remotePos: RemotePose = { x: 0, y: 0, src: null!, meleeTicks: 0 };
  /** called when the room's tuning changed under us (another client's live edit) */
  onTuningFromServer: () => void = () => {};
  private readonly tuningListeners = new Set<TuningListener>();
  private readonly hostListeners = new Set<(was: number, now: number) => void>();
  /** voice chat (voice/voice.ts, v18): VOICE_DOWN and VOICE_STATE go here, not to the netcode */
  private readonly voiceListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly connectedListeners = new Set<() => void>();
  /** the admin values last heard (WELCOME, OVERRIDES): to tell which tuning keys the admin just changed */
  private adminSeen: AdminValues = {};
  /** tuning keys the latest OVERRIDES changed: the TUNING right after it is the admin's for those */
  private adminKeys = new Set<keyof Tuning>();
  /** the room's tuning without the admin's: what "Tuned by host" compares with */
  private baseFor: AdminValues | null = null;
  private base: Tuning = defaultTuning;
  private lastTuning: Tuning | null = null;

  /**
   * Hears the room's tuning change under us: what it was and is, and `live` once the match is under
   * way here (the room's tuning arriving as we join isn't a change anyone made just now). Returns
   * the way to stop.
   */
  onTuning(fn: TuningListener): () => void {
    this.tuningListeners.add(fn);
    return () => this.tuningListeners.delete(fn);
  }

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
    // v19: the look we wear (the saved one unless the caller says); the room holds it to what we own
    const look = options.look ?? savedLookIds();
    this.net = new NetClient({
      name,
      ...(options.ticket ? { ticket: options.ticket } : {}),
      look,
      ...(options.spectate ? { spectate: true } : {}),
      now: () => performance.now(),
      send: (bytes) => {
        this.bytesOut += bytes.length;
        this.up.send(bytes);
      },
      // a stalled WebSocket queues INPUTs and delivers them all at once: NetClient thins them out
      stream: () => this.transport?.kind === 'ws',
      backlog: () => this.transport?.backlog() ?? 0,
    });
    // a reload resumes the same player while the room still holds it
    // (a spectator comes in fresh: an old token would bring a player back instead)
    if (!options.spectate) this.net.sessionToken = loadToken(options.room);

    this.open();
    this.watchdogTimer = window.setInterval(() => this.checkSilence(performance.now()), WATCHDOG_MS);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('pageshow', this.onPageShow);
      window.addEventListener('online', this.onOnline);
    }
  }

  /** The room code this mode plays in ('' = the dev room). */
  get room(): string {
    return this.options.room ?? '';
  }

  /** A local room (same Wi-Fi, lan/). */
  get local(): boolean {
    return this.options.local === true;
  }

  /**
   * What the shell shows: a reconnect stays "connected" until it has lasted QUIET_OUTAGE_MS in view
   * (no banner, no "Back" chip for a quick one); after that, the reconnect as it is.
   */
  get connection(): ConnectionInfo {
    const c = this.conn;
    if (c.state !== 'reconnecting' || !this.everConnected) return c;
    const seen = Math.max(c.since, this.visibleAt);
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return QUIET_CONNECTED;
    return performance.now() - seen < QUIET_OUTAGE_MS ? QUIET_CONNECTED : c;
  }

  /** a WELCOME came on some connection of this mode: a drop now is a reconnect, not a first join */
  private everConnected = false;

  /** Back in view: whatever went wrong in the background is retried now, and silence counted from now. */
  private visibilityChanged(): void {
    if (document.visibilityState !== 'visible') return;
    this.visibleAt = performance.now();
    // a frozen or throttled page heard nothing: that's no evidence against the connection
    this.lastMessageAt = Math.max(this.lastMessageAt, this.visibleAt);
    this.retryNow('back in view');
  }

  /** A reconnect waiting out its backoff tries now (the page is back in view, the network is back). */
  private retryNow(_why: string): void {
    if (this.disposed || this.transport || !this.droppedAt || this.conn.state !== 'reconnecting' || !this.reconnectTimer) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.open();
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

  // ---- spectating (v20, spectate/) ----

  /** The room took us as a spectator (no player): the spectate director drives the camera. */
  get spectating(): boolean {
    return this.net.spectating;
  }

  /** What the room last said about our spectating (mode, death cam target, queue, the room's spectators). */
  get spectateState(): SpectateMsg | null {
    return this.net.spectate;
  }

  /** Seconds a spectator's feed runs behind the match (0 when playing). */
  get spectateDelay(): number {
    return this.net.spectating ? this.net.spectateDelayTicks / TICK_RATE : 0;
  }

  /** The death cam (dead) or the spectator's record: follow this player. */
  follow(id: number): void {
    this.net.follow(id);
  }

  /** A spectator asks for a slot: 'now', 'next' (next round) or false (stay watching). */
  play(when: 'now' | 'next' | false): void {
    this.net.play(when);
  }

  // ---- voice chat (v18, voice/voice.ts) ----

  /** Everyone's name by voice id (the roster, and v20's spectators at 32 + seat): voice chat's labels. */
  get playerNames(): ReadonlyMap<number, string> {
    const spectators = this.net.spectate?.spectators ?? [];
    if (spectators.length === 0) return this.net.names;
    const names = new Map(this.net.names);
    for (const s of spectators) names.set(s.voiceId, s.name);
    return names;
  }

  /** VOICE_DOWN and VOICE_STATE as they arrive; returns the stop. */
  onVoice(fn: (bytes: Uint8Array) => void): () => void {
    this.voiceListeners.add(fn);
    return () => this.voiceListeners.delete(fn);
  }

  /** After every WELCOME (joined, or back after a drop); returns the stop. */
  onConnected(fn: () => void): () => void {
    this.connectedListeners.add(fn);
    return () => this.connectedListeners.delete(fn);
  }

  /** A voice frame up; skipped while a stalled WebSocket is backed up (stale voice is worse than none). */
  sendVoice(bytes: Uint8Array): void {
    if (!this.net.isConnected || (this.transport?.backlog() ?? 0) > 32 * 1024) return;
    this.bytesOut += bytes.length;
    this.up.send(bytes);
  }

  /** The Voice CMD (JSON, protocol voice.ts). */
  sendVoiceSettings(json: string): void {
    this.sendCmd(CmdKind.Voice, json);
  }

  /** Host: the room's limits and map (lobby only) and its bots (any phase, v17). */
  setMatchSettings(settings: { timeLimit?: number; killLimit?: number; mapId?: string; bots?: number; botLevel?: 'easy' | 'normal' | 'hard'; teams?: number }): void {
    this.sendCmd(CmdKind.MatchSettings, JSON.stringify(settings));
  }

  /** Host, lobby (v21 team modes): a player onto a team. */
  setTeam(id: number, team: number): void {
    this.sendCmd(CmdKind.SetTeam, JSON.stringify({ id, team }));
  }

  /** Leaves for good: the server drops the player now (no reconnect grace), then the socket closes. */
  leave(): void {
    this.sendCmd(CmdKind.Leave);
    saveToken(this.options.room, null);
    this.dispose();
  }

  /** jet held without flying: the event log hears why (diag/jetWatch.ts) */
  private readonly jetWatch = new JetWatch();

  private watchJet(me: PlayerState | null, buttons: number, now: number): void {
    this.jetWatch.step(me, buttons, now, () => {
      const tick = this.net.predictor?.tick;
      return `${tick !== undefined && this.frozenAt(tick) ? 'frozen (countdown)' : 'not frozen'}, phase ${this.matchState?.phase ?? '?'}`;
    });
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

  /**
   * Starts a connection for `attempt` (its messages count only once it's the current one). The
   * transport, or why it failed.
   */
  private connectFor(attempt: object, prefer: 'auto' | 'wt' | 'ws', reconnect: boolean): Promise<{ transport: GameTransport; fallbackReason: string | null }> {
    const handlers: TransportHandlers = {
      onMessage: (bytes) => {
        if (this.currentAttempt !== attempt) return;
        this.lastMessageAt = performance.now();
        this.bytesIn += bytes.length;
        this.down.send(bytes);
      },
      onClose: (code, reason) => {
        if (this.spare?.attempt === attempt) this.spare = null;
        if (this.currentAttempt === attempt) this.dropped(code, reason);
      },
    };
    const connect = this.options.connect;
    return connect ? connect(handlers, reconnect).then((transport) => ({ transport, fallbackReason: null as string | null })) : connectGame(this.url, prefer, handlers, reconnect);
  }

  private open(): void {
    const prefer = this.stickyWebSocket && this.preferTransport === 'auto' ? 'ws' : this.preferTransport;
    // a spare connection opened while this one went quiet (checkSilence): take it, ready or not
    const spare = this.spare;
    this.spare = null;
    const attempt = spare?.attempt ?? {};
    this.currentAttempt = attempt;
    (spare?.ready ?? this.connectFor(attempt, prefer, this.droppedAt !== 0)).then(
      ({ transport, fallbackReason }) => {
        if (this.currentAttempt !== attempt || this.disposed) return transport.close();
        // WebTransport was tried and failed (fell back): don't try it again on every reconnect
        if (fallbackReason !== null && prefer === 'auto' && transport.kind === 'ws' && !/not supported|no WebTransport gateway|default room only/.test(fallbackReason)) this.stickyWebSocket = true;
        this.transport = transport;
        this.lastMessageAt = performance.now();
        // the conditioner models what loss does to this transport: retransmit stalls on TCP
        this.netSim.up.stream = this.netSim.down.stream = transport.kind === 'ws';
        this.transportNote = transport.kind === 'wt' ? 'WebTransport (UDP)' : transport.kind === 'lan' ? 'local room (Wi-Fi)' : `WebSocket${fallbackReason ? ` (${fallbackReason})` : ''}`;
        this.status = this.droppedAt ? 'resuming…' : 'joining…';
        diag('net', `${this.transportNote} open${this.droppedAt ? `, resuming (try ${this.reconnectAttempt})` : ''}`);
        if (!this.droppedAt) this.conn = { ...FRESH, state: 'joining', detail: '', code: 0 };
        this.net.onOpen();
      },
      (e: Error & { code?: number }) => {
        // a local room's connector says why with a close code (4006: the room is gone)
        if (this.currentAttempt === attempt) diag('net', `connect failed: ${typeof e.code === 'number' ? e.code : 1006} ${e.message}`);
        if (this.currentAttempt === attempt) this.dropped(typeof e.code === 'number' ? e.code : 1006, e.message);
      },
    );
  }

  /**
   * A second connection, opened while the current one has gone quiet for HEDGE_OPEN_MS, ready to
   * take over at HEDGE_SWITCH_MS (the resume then costs one round trip, not a whole connection).
   */
  private spare: { attempt: object; ready: Promise<{ transport: GameTransport; fallbackReason: string | null }>; transport: GameTransport | null } | null = null;

  private openSpare(): void {
    const prefer = this.stickyWebSocket && this.preferTransport === 'auto' ? 'ws' : this.preferTransport;
    const attempt = {};
    // a reconnect: what /health said before stands (the page's pooled HTTP connection may be dead too)
    const ready = this.connectFor(attempt, prefer, true);
    const spare = { attempt, ready, transport: null as GameTransport | null };
    this.spare = spare;
    ready.then(
      (r) => {
        if (this.spare === spare) spare.transport = r.transport;
        else if (this.currentAttempt !== attempt) r.transport.close();
      },
      () => {
        if (this.spare === spare) this.spare = null;
      },
    );
  }

  private closeSpare(): void {
    const spare = this.spare;
    this.spare = null;
    spare?.transport?.close();
  }

  private currentAttempt: object | null = null;

  private dropped(code: number, reason: string): void {
    if (this.disposed) return;
    this.transport = null;
    const why = `${code}${reason ? `: ${reason}` : ''}`;
    const now = performance.now();
    diag('net', `closed ${why}${this.droppedAt ? ` (outage ${Math.round(now - this.droppedAt)} ms)` : ''}`);
    if (!this.droppedAt) this.droppedAt = now;
    // the server is updating (a deploy): its rooms go with it. Rejoin with a fresh ticket once it's
    // back (it takes a few seconds), not a resume it can't know about ("ticket expired", 23 Oct 2026)
    const updating = code === CloseCode.ServerUpdating || (code === 1001 && /restart/i.test(reason));
    if (updating && this.net.sessionToken !== '' && this.options.refreshTicket && now - this.droppedAt < RECONNECT_WINDOW_MS) {
      this.net.onClose();
      this.conn = { ...FRESH, state: 'reconnecting', detail: 'the server updated', code: CloseCode.ServerUpdating, since: this.droppedAt, until: this.droppedAt + RECONNECT_WINDOW_MS, attempt: 1 };
      this.status = 'the server updated: rejoining…';
      this.reconnectTimer = window.setTimeout(() => this.rejoinWithFreshTicket(why, CloseCode.ServerUpdating), SERVER_UPDATE_WAIT_MS);
      return;
    }
    // back after the room let our player go: rejoin as a new player with a fresh ticket
    if (code === CloseCode.TicketInvalid && this.net.sessionToken !== '' && this.options.refreshTicket && now - this.droppedAt < RECONNECT_WINDOW_MS) {
      this.rejoinWithFreshTicket(why);
      return;
    }
    // a spectator has no session to resume: it comes back for a fresh seat (a fresh ticket in a room by code)
    if (this.net.spectating && !this.kicked && !FATAL_CLOSE.has(code) && now - this.droppedAt < RECONNECT_WINDOW_MS) {
      if (this.options.refreshTicket) {
        this.rejoinWithFreshTicket(why);
        return;
      }
      this.net.onClose();
      const delay = reconnectDelay(this.reconnectAttempt++);
      this.conn = { ...FRESH, state: 'reconnecting', detail: why, code, since: this.droppedAt, until: this.droppedAt + RECONNECT_WINDOW_MS, attempt: this.reconnectAttempt };
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = 0;
        this.open();
      }, delay);
      return;
    }
    // never welcomed, kicked, refused, or out of time: give up
    const canRetry = this.net.sessionToken !== '' && !this.kicked && !FATAL_CLOSE.has(code) && now - this.droppedAt < RECONNECT_WINDOW_MS;
    if (!canRetry) {
      this.giveUp(code, reason);
      return;
    }
    this.net.onClose();
    const delay = reconnectDelay(this.reconnectAttempt++);
    this.status = `reconnecting… (${why}; retry in ${(delay / 1000).toFixed(2)} s)`;
    this.conn = { ...FRESH, state: 'reconnecting', detail: why, code, since: this.droppedAt, until: this.droppedAt + RECONNECT_WINDOW_MS, attempt: this.reconnectAttempt };
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      this.open();
    }, delay);
  }

  private giveUp(code: number, reason: string): void {
    this.status = `disconnected (${code}${reason ? `: ${reason}` : ''})`;
    const stats = this.net.stats();
    const heard = this.net.sessionToken !== '';
    this.conn = {
      state: 'failed',
      detail: reason || (code === 1006 ? 'connection lost' : `closed (${code})`),
      code,
      since: 0,
      until: 0,
      attempt: this.reconnectAttempt,
      lastPingMs: heard && Number.isFinite(stats.rttMs) ? Math.round(stats.rttMs) : -1,
      lossPct: heard ? stats.snapshotLossPct : 0,
    };
    if (code === CloseCode.DuplicateSession || code === 1000) saveToken(this.options.room, null);
    diag('net', `gave up: ${this.conn.detail} (code ${code}, ${this.reconnectAttempt} tries, ${heard ? 'had joined' : 'never joined'})`);
    // the owner can read what happened on this phone (diag/report.ts): a report goes by itself; leaving isn't a failure
    if (code !== 1000 && code !== CloseCode.DuplicateSession && !this.options.host) autoReport(`${this.options.local ? 'local room' : 'room'} ${this.options.room || ''}: ${this.conn.detail} (${code})`);
    this.onFatal(`${this.status} — is the game server running? (pnpm dev)`);
  }

  private rejoinWithFreshTicket(why: string, code: number = CloseCode.TicketInvalid): void {
    this.net.onClose();
    this.conn = { ...FRESH, state: 'reconnecting', detail: why, code, since: this.droppedAt, until: this.droppedAt + RECONNECT_WINDOW_MS, attempt: Math.max(1, this.reconnectAttempt) };
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
    if (bytes[0] === MsgType.VoiceDown || bytes[0] === MsgType.VoiceState) {
      for (const fn of this.voiceListeners) fn(bytes);
      return;
    }
    const msg = this.net.receive(bytes);
    if (!msg) return;
    switch (msg.type) {
      case MsgType.Welcome: {
        this.status = msg.resumed ? `connected (resumed after ${((performance.now() - this.droppedAt) / 1000).toFixed(1)} s)` : 'connected';
        diag('net', `welcomed: ${this.status}`);
        this.conn = { ...FRESH, state: 'connected', detail: '', code: 0 };
        this.everConnected = true;
        this.closeSpare(); // back without it
        this.droppedAt = 0;
        this.reconnectAttempt = 0;
        // a spectator has no session (''): nothing to resume on a reload
        saveToken(this.options.room, msg.sessionToken || null);
        for (const fn of this.connectedListeners) fn();
        // the room's tuning as it is now (it may have changed while we were away): an open Tune
        // panel and the HUD hear of it (not live: nobody "just" changed it)
        const keys = adminTuningKeys(this.adminSeen, this.net.adminValues);
        this.adminSeen = this.net.adminValues;
        const before = this.lastTuning ?? defaultTuning;
        const after = { ...this.net.tuning };
        this.lastTuning = after;
        if (sameTuning(before, after)) break;
        this.onTuningFromServer();
        for (const fn of this.tuningListeners) fn(before, after, false, keys);
        break;
      }
      case MsgType.Overrides:
        // the admin's values come just before its TUNING (room.ts applyAdmin): remember which keys they moved
        this.adminKeys = adminTuningKeys(this.adminSeen, this.net.adminValues);
        this.adminSeen = this.net.adminValues;
        break;
      case MsgType.MatchState: {
        const was = this.matchState?.hostId ?? -1;
        this.matchState = msg;
        lookBook.setHost(msg.hostId);
        // team modes (v21): who is on which team (the VS poster, team colours)
        lookBook.setTeams(msg.teams ?? 0, new Map(msg.lobby.map((e) => [e.id, e.team ?? -1] as const)));
        // the host left or went quiet (room.ts HOST_AWAY_TICKS): someone else runs the room now
        if (was >= 0 && msg.hostId >= 0 && msg.hostId !== was) for (const fn of this.hostListeners) fn(was, msg.hostId);
        break;
      }
      case MsgType.Roster:
        // the roster knows every bot; the snapshots only those in view
        this.renderer.setNames(this.net.names, new Set(msg.entries.filter((e) => e.isBot).map((e) => e.id)));
        // v19: everyone's look, ours included (what the others see us in), and who's in (the VS poster)
        lookBook.setRoster(this.net.myId, msg.entries.map((e) => ({ id: e.id, name: e.name, isBot: e.isBot })));
        lookBook.replace(looksFromWire(this.net.looks));
        break;
      case MsgType.Tuning: {
        const before = this.lastTuning ?? defaultTuning;
        const after = { ...this.net.tuning };
        this.lastTuning = after;
        const keys = this.adminKeys;
        this.adminKeys = new Set();
        this.onTuningFromServer();
        for (const fn of this.tuningListeners) fn(before, after, this.snapCount > 0, keys);
        break;
      }
      case MsgType.Snapshot: {
        this.snapCount++;
        // own shots are drawn from the prediction the moment they're fired; skip the server's copies
        const me = this.net.myId;
        // SOUND events (gunfire off screen) have no renderer: the sound plays them, from their side
        this.renderer.onEvents(
          msg.events.filter((e): e is SimEvent => e.type !== 'sound' && !(e.type === 'shot' && e.shooter === me)),
          me,
        );
        const sounds = msg.events.filter((e) => e.type === 'sound');
        audio.onEvents(sounds, me);
        if (sounds.length) this.renderer.onSounds(sounds); // the minimap hears them (no wallhacks: 4 m cells)
        break;
      }
      case MsgType.Kick:
        this.kicked = true;
        this.status = `kicked: ${msg.reason}`;
        this.conn = { ...FRESH, state: 'failed', detail: msg.reason, code: msg.code };
        this.onFatal(this.status);
        break;
      default:
        break;
    }
  }

  tuning(): Tuning {
    return this.net.tuning;
  }

  /** Hears the room's host change (the old one left or went quiet): old and new player ids. Returns the way to stop. */
  onHostChange(fn: (was: number, now: number) => void): () => void {
    this.hostListeners.add(fn);
    return () => this.hostListeners.delete(fn);
  }

  /** The room's tuning before any host's edits: the defaults with the admin's values ("Tuned by host" compares with it). */
  tuningBase(): Tuning {
    const values = this.net.adminValues;
    if (values !== this.baseFor) {
      this.baseFor = values;
      this.base = createTuning({ ...defaultTuning, ...adminTuning(values) });
    }
    return this.base;
  }

  setTuning(t: Tuning): void {
    this.lastTuning = { ...t };
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

  /** v19: wear another look (a Locker or creator save while in the room); everyone sees it in the next ROSTER. */
  setLook(look: readonly number[]): void {
    this.net.setLook(look);
  }

  dispose(): void {
    this.disposed = true;
    lookBook.clear();
    this.net.clearOverrides();
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.watchdogTimer);
    this.closeSpare();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('pageshow', this.onPageShow);
      window.removeEventListener('online', this.onOnline);
    }
    this.currentAttempt = null;
    this.up.dispose();
    this.down.dispose();
    this.transport?.close();
  }

  /**
   * A connection can stay "open" with nothing arriving: a hung gateway, or a path that went dark
   * (TCP doesn't close for that; QUIC only at its idle timeout). Snapshots come 15–30 times a
   * second, so after WT_SILENCE_MS / WS_SILENCE_MS of silence (JOIN_SILENCE_MS while waiting for
   * WELCOME) give up on it and resume on a fresh connection: WebSocket after a silent WebTransport.
   */
  private checkSilence(now: number): void {
    const t = this.transport;
    if (!t || this.disposed) return;
    // a hidden page's timers and messages are held back (or frozen): its silence means nothing; a
    // connection that really died says so with its close
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // a watchdog that ran late had a busy page (loading, a long frame): its messages may be queued
    // behind this check, so this look doesn't hedge
    const late = now - this.watchdogAt > 3 * WATCHDOG_MS;
    this.watchdogAt = now;
    const quiet = now - this.lastMessageAt;
    // in play, a quiet connection gets a spare at HEDGE_OPEN_MS and is swapped for it at
    // HEDGE_SWITCH_MS (owner's phones, 24 Oct: a carrier dropped their sockets every few minutes
    // without telling the phone; a resume took 5.5 s, 4 of them waiting out the silence)
    if (this.net.isConnected && t.kind !== 'lan' && !late) {
      if (quiet < HEDGE_OPEN_MS) {
        if (this.spare) this.closeSpare();
      } else if (!this.spare) this.openSpare();
      if (quiet >= HEDGE_SWITCH_MS) {
        this.currentAttempt = null; // its close is ours
        this.transport = null;
        t.close(4000, 'quiet: switching to a fresh connection');
        if (!this.droppedAt) this.droppedAt = this.lastMessageAt;
        this.net.onClose();
        this.reconnectAttempt = 1;
        this.status = 'resuming on a fresh connection…';
        this.conn = { ...FRESH, state: 'reconnecting', detail: 'the connection went quiet', code: 1006, since: this.droppedAt, until: this.droppedAt + RECONNECT_WINDOW_MS, attempt: 1 };
        this.open();
        return;
      }
    }
    const limit = !this.net.isConnected ? JOIN_SILENCE_MS : t.kind === 'ws' ? WS_SILENCE_MS : WT_SILENCE_MS;
    if (now - this.lastMessageAt < limit) return;
    this.currentAttempt = null; // its close is ours, not a drop to handle twice
    this.transport = null;
    t.close(4000, 'no traffic');
    // in view and silent: WebTransport isn't working on this network; WebSocket from now on
    if (t.kind === 'wt' && this.preferTransport === 'auto') this.stickyWebSocket = true;
    // the outage began when the traffic stopped
    if (!this.droppedAt) this.droppedAt = this.lastMessageAt;
    this.dropped(1006, `no traffic for ${Math.round(limit / 1000)} s`);
  }

  update(dt: number): Frame {
    const now = performance.now();
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
      this.watchJet(me, out.buttons, now);
    });
    if (this.net.isConnected && now >= this.nextPingReportAt && this.net.rtt.count > 0) {
      this.nextPingReportAt = now + PING_REPORT_MS;
      this.sendCmd(CmdKind.ReportPing, String(Math.round(this.net.rtt.median)));
    }
    // own shots and dashes are drawn from prediction the moment they happen
    const drained = this.net.drainEvents();
    const own: SimEvent[] = drained.filter((e) => e.type === 'shot' || e.type === 'dash');
    if (own.length) this.renderer.onEvents(own, this.net.myId);
    // our throws and launches, heard the moment they happen (the server's copies follow)
    audio.onEvents(
      drained.filter((e) => e.type === 'throw' || e.type === 'launch'),
      this.net.myId,
    );

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
      ...(this.transport ? { transport: this.transport.kind } : {}),
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
      if (pose) players.push(this.remoteView(pose.src, isLocal, pose.x, pose.y, pose.meleeTicks ?? pose.src.meleeTicks));
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
      // own grenades and projectiles from the throw (predicted), everyone else's from the newest snapshot
      grenades: this.net.grenadeViews(now).map((g) => ({ x: g.x, y: g.y, fuse: g.fuse, type: g.type, state: g.state, id: g.id, vx: g.vx, vy: g.vy })),
      pickups: newest.msg.pickups,
      clouds,
      net,
      rewinds: this.rewindViews(now),
      // the predicted game runs the map's event schedule on our own timeline: the banner matches the physics
      mapEvent: pred?.started ? mapEventView(pred.game) : null,
      // the throw arc runs on the predicted game too, from our predicted state
      throwArc: pred?.started ? this.throwPreview.update(pred.game, pred.player, this.sampler.throwAim) : null,
      // the sniper's aim line, on the predicted game too: where our shot would go now
      aimLine: pred?.started ? this.aimLine.update(pred.game, pred.player) : null,
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

  private remoteView(src: SnapshotPlayer, isLocal: boolean, x: number, y: number, meleeTicks = src.meleeTicks): PlayerView {
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
      burning: src.burning,
      windup: src.windup,
      // v16: a remote swing at the render tick (a miss shows too, not only the hit that lands)
      meleeTicks,
      // other players' ammo isn't sent (only the local block has it); the snapshot's reloading flag
      // marks the gun in hand as reloading (render3d drops a revolver's casings as a reload starts)
      weapons: src.weapons.map((w, i) => ({ def: w.def, mag: 0, reserve: 0, reloadTicks: src.reloading && i === src.active ? 1 : 0 })),
      shield: src.shield === 'up' ? 'front' : src.shield === 'slung' ? 'back' : src.shield === 'raising' ? 'raising' : undefined,
      respawnTicks: src.respawnTicks,
      kills: src.kills,
      deaths: src.deaths,
    };
  }
}

function sameTuning(a: Tuning, b: Tuning): boolean {
  for (const k of Object.keys(b) as (keyof Tuning)[]) if (a[k] !== b[k]) return false;
  return true;
}
