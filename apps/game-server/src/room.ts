/**
 * One authoritative room (docs/06 §5). Transport-agnostic: the uWS layer (or a test) hands it
 * bytes and a `ClientConn` to reply on.
 *
 * Pipe: clients tag each input with the server tick it is for (they run ahead, docs/05 §4) →
 * per-client tick-indexed buffer (repeat-last when a tick's input is missing) → Game.step at 60 Hz →
 * every 2nd tick (30 Hz) a snapshot per client: delta-compressed against the newest one it acked,
 * culled to what its camera can show (AOI), with its input buffer health and the exact state of
 * its own player for reconciliation (docs/05 §8, §9, §11). Hitscan is lag-compensated: each shot
 * tests targets where the shooter's screen showed them (docs/05 §7, LagCompensator).
 *
 * Sessions (docs/05 §13): a dropped connection leaves its player standing idle in the world for
 * `reconnectGraceMs`; a new connection presenting the WELCOME session token takes it back over
 * (full resync: fresh baselines), and also replaces a stale connection that hasn't noticed the drop.
 *
 * Match rooms (`RoomOptions.match`, the rooms by code): the sim's Match runs the lobby → countdown →
 * match → results → rematch lifecycle (docs/06 §5.2), the longest-present player is the host
 * (settings, start, back to lobby; docs/07 §5.3), and MATCH_STATE (0x23) keeps every client's
 * screens and input freeze in step.
 *
 * Bots (`RoomOptions.fillBots`, packages/bots, docs/08 §9) keep a room with humans in it at a
 * number of players: a human coming in takes the lowest-scoring bot's place (not its stats), one
 * leaving for good brings a bot in, and the last human out takes them all. They're players like any
 * other (roster, snapshots, standings, the `[BOT]` tag on their names), running in the room's sim.
 */
import { randomBytes } from 'node:crypto';
import { addBot, removeBot, type BotLevelId } from '@military-forge/bots';
import { createTuning, defaultTuning, limitTuning, maps, type Tuning } from '@military-forge/content';
import {
  CONTENT_HASH,
  CloseCode,
  CmdKind,
  DecodeError,
  HEALTH_UNKNOWN,
  MsgType,
  PROTOCOL_VERSION,
  SnapshotBaselines,
  SnapshotEncoder,
  createInputPacket,
  decodeInputInto,
  decodeMessage,
  encodePong,
  encodeRewindDebug,
  encodeRoster,
  type RosterEntry,
  encodeMatchState,
  encodeTuning,
  encodeWelcome,
  isUnreliableMessage,
  ROOM_SETTING_LIMITS,
  type ClientMessage,
  type MatchStandingWire,
  type RewindTarget,
  type ViewRect,
} from '@military-forge/protocol';
import {
  ConditionedLink,
  INTERP_DELAY_MS,
  InputBuffer,
  LOW_BANDWIDTH_INTERP_DELAY_MS,
  LagCompensator,
  TICK_MS,
  aoiRect,
  unwrapTick,
  type ConditionerSettings,
  type Scheduler,
} from '@military-forge/netcode';
import {
  Game,
  MAX_PLAYERS,
  Match,
  MatchPhase,
  createInput,
  type Input,
  type MatchRules,
  type MatchStanding,
  type PlayerState,
  type SimEvent,
} from '@military-forge/sim';

export interface ClientConn {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
  /** bytes queued but not yet written to the socket */
  bufferedAmount(): number;
}

export interface RoomOptions {
  seed?: number;
  mapId?: string;
  maxHumans?: number;
  dummies?: boolean;
  /** the map's pickup spawners (riot shields…) and drops on death (default on) */
  pickups?: boolean;
  /** the test armory: a rack of one of every gun near the spawns, back 2 s after it's taken (default off; the playtest turns it on) */
  armory?: boolean;
  /** send a snapshot every N ticks (2 → 30 Hz) */
  snapshotEvery?: number;
  /** allow dev commands (live tuning, respawn) */
  dev?: boolean;
  /**
   * The room's host may tune the game live (SetTuning, within the tuning panel's keys and ranges),
   * everyone else not: pnpm playtest --tune (HOST_TUNING=1). Off by default; dev rooms let anyone.
   */
  hostTuning?: boolean;
  /** server-side network conditioner on every connection (docs/05 §15.2; dev/testing only) */
  netSim?: { settings: ConditionerSettings; scheduler: Scheduler };
  /** lag compensation for hitscan (default on); `maxRewindMs` overrides the cap */
  lagComp?: boolean | { maxRewindMs?: number };
  /** send each client only what its camera can show (default on, docs/05 §9) */
  aoi?: boolean;
  /** how long a dropped player waits for its session to reconnect (rooms 20 s, BR 60 s; 0 = never) */
  reconnectGraceMs?: number;
  /** run a match (lobby, countdown, scoring, results, rematch) with these rules; absent = free play */
  match?: Partial<MatchRules>;
  /**
   * Bots keep the room at `target` players (humans + bots) while a human is in it, at `level`:
   * absent (or a target of 0) = no bots.
   */
  fillBots?: { target: number; level: BotLevelId };
  /** where a message handler's unexpected error goes (the client is kicked, the room keeps running) */
  log?: (msg: string) => void;
}

/** A player's claim on the room; outlives its connection for the reconnect grace. */
export interface Session {
  token: string;
  playerId: number;
  /** the connection driving this player, null while waiting for a reconnect */
  client: Client | null;
  /** tick at which a detached session is given up */
  expiresAt: number;
  /** what the player does while detached: nothing, facing the same way */
  readonly idle: Input;
  /**
   * The token presented on the latest resume, kept valid until that connection proves it got the
   * new token (its first PING or INPUT): if the resumed WELCOME is lost, the retry still works.
   */
  prevToken: string | null;
  /** join order in this room (the host is the longest-present player) */
  readonly joinSeq: number;
  /** round-trip time its client last reported (CmdKind.ReportPing), ms; -1 = not yet */
  pingMs: number;
}

const newToken = () => randomBytes(18).toString('base64url');

const MAX_STRIKES = 3;
/** messages other than INPUT (PING, CMD, HELLO): an honest client sends a few a second */
const MAX_MESSAGES_PER_SECOND = 200;
/**
 * A stalled TCP stream (a proxy or tunnel hiccup) or a starved server process hands over seconds of
 * an honest client's messages at once, so unused allowance carries over, up to 3 s of it. A flood
 * still runs dry within seconds (a kick): the steady-state limit is unchanged.
 */
const MESSAGE_BURST = 3 * MAX_MESSAGES_PER_SECOND;
/**
 * docs/05 §14: INPUTs per connection, 70/s (60 + slack: the pacer runs up to 3 % fast), with up to
 * 3 s of unused allowance carried over. Over it they're dropped, not a kick: a stream that stalled
 * for 15 s hands over a backlog of them at once, all but the last few too late to use. The newest
 * one over the limit waits for the next tick, so the player still gets their latest input.
 */
const INPUTS_PER_SECOND = 70;
const INPUT_BURST = 3 * INPUTS_PER_SECOND;
/** over the INPUT limit in this many 1 s refills in a row: a flood, not a backlog (kicked) */
const INPUT_FLOOD_SECONDS = 10;
/**
 * docs/05 §14: a token bucket of CMDs per connection (20/s, bursts of 20). Over the limit they're
 * dropped, not strikes: a TCP stall can bunch up honest ones. A real flood still hits
 * MAX_MESSAGES_PER_SECOND.
 */
const CMDS_PER_SECOND = 20;
const CMD_BURST = 20;
/**
 * A low-bandwidth client gets its wider rewind cap and 4-tick pose spacing only after this long
 * in that mode (1 s: past its 150 ms interpolation window with slack). Off takes effect at once,
 * so toggling it around a shot earns nothing.
 */
const LOW_BW_WARMUP_TICKS = 60;
const BACKPRESSURE_LIMIT = 16 * 1024;
/** docs/05 §14: INPUT packets are tiny; anything bigger is malformed */
const MAX_INPUT_BYTES = 64;

export class Client {
  playerId = -1;
  name = '';
  closed = false;
  /** this client's inputs, by server tick */
  readonly inputs = new InputBuffer();
  /** what the sim uses: the input for the current tick, or the last one repeated */
  readonly lastInput: Input = createInput();
  /** lowest buffer health since the last snapshot */
  healthMin = Infinity;
  /** snapshots sent to this client recently: delta baselines (docs/05 §11) */
  readonly baselines = new SnapshotBaselines();
  /** this client's area of interest, recomputed every snapshot */
  readonly view: ViewRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** server tick low-bandwidth mode was switched on, -1 = off */
  lowBwSince = -1;
  /** server tick of the last snapshot sent to it */
  lastSnapshotTick = -1;
  strikes = 0;
  /** messages it may still send before the next refill (rate limit with carry-over, MESSAGE_BURST) */
  messageTokens = MESSAGE_BURST;
  /** INPUTs it may still send before the next refill (INPUT_BURST) */
  inputTokens = INPUT_BURST;
  /** INPUTs over the limit since the last refill, and how many refills in a row saw any */
  inputsOverLimit = 0;
  inputFloodSeconds = 0;
  /** INPUTs dropped for the rate limit, in all */
  inputsDropped = 0;
  /** the newest INPUT over the limit (validated), applied at the next tick; length 0 = none */
  readonly heldInput = new Uint8Array(MAX_INPUT_BYTES);
  heldInputLength = 0;
  /** CMD token bucket: tokens left, as of server tick `cmdTokensAt` */
  cmdTokens = CMD_BURST;
  cmdTokensAt = 0;
  snapshotsSkipped = 0;
  /** the player this connection drives (null before WELCOME) */
  session: Session | null = null;
  /** network conditioner links (only with RoomOptions.netSim) */
  up: ConditionedLink | null = null;
  down: ConditionedLink | null = null;

  /**
   * @param snapshotEvery ticks between this client's snapshots: the room's interval, doubled in
   *   low-bandwidth mode
   */
  constructor(
    readonly conn: ClientConn,
    public snapshotEvery: number,
  ) {}

  get joined(): boolean {
    return this.playerId >= 0;
  }
}

/** docs/07 §3: 16 characters (grapheme clusters), 48 UTF-8 bytes. Never cuts a character in half. */
const MAX_NAME_GRAPHEMES = 16;
const MAX_NAME_BYTES = 48;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The bots' tag (packages/bots BOT_TAG, "[BOT] "): a human's name doesn't start with it. */
const BOT_TAG_PREFIX = /^\s*\[\s*bot\s*\]\s*/i;

export function sanitizeName(raw: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '').trim();
  let name = '';
  let count = 0;
  for (const { segment } of graphemes.segment(clean.replace(BOT_TAG_PREFIX, ''))) {
    if (count === MAX_NAME_GRAPHEMES || Buffer.byteLength(name + segment) > MAX_NAME_BYTES) break;
    name += segment;
    count++;
  }
  return name.trim() || fallback;
}

/** How often MATCH_STATE is re-sent with nothing else changed (damage and ping columns). */
const MATCH_STATE_REFRESH_TICKS = 120;
/** Lobby commands and kills batch into at most one MATCH_STATE per this many ticks; phase changes go at once. */
const MATCH_STATE_MIN_TICKS = 6;

/** Host settings from a MatchSettings CMD: whole values inside ROOM_SETTING_LIMITS (0 = off), at least one limit on. */
export function parseMatchSettings(payload: string, current: Pick<MatchRules, 'timeLimit' | 'killLimit'>, mapId: string): { timeLimit: number; killLimit: number; mapId: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const limit = (v: unknown, fallback: number, { min, max }: { min: number; max: number }): number | null => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v)) return null;
    return v === 0 || (v >= min && v <= max) ? v : null;
  };
  const timeLimit = limit(o.timeLimit, current.timeLimit, ROOM_SETTING_LIMITS.timeLimit);
  const killLimit = limit(o.killLimit, current.killLimit, ROOM_SETTING_LIMITS.killLimit);
  const map = o.mapId === undefined ? mapId : o.mapId;
  if (timeLimit === null || killLimit === null || (timeLimit === 0 && killLimit === 0)) return null;
  if (typeof map !== 'string' || !Object.hasOwn(maps, map)) return null;
  return { timeLimit, killLimit, mapId: map };
}

function standingWire(s: MatchStanding): MatchStandingWire {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    isBot: s.isBot,
    left: s.left,
    mvp: s.mvp,
    score: s.score,
    kills: s.kills,
    deaths: s.deaths,
    suicides: s.suicides,
    assists: s.assists,
    damageDealt: s.damageDealt,
    damageTaken: s.damageTaken,
    headshots: s.headshots,
    bestStreak: s.bestStreak,
  };
}

export class Room {
  readonly game: Game;
  readonly clients = new Set<Client>();
  private pendingEvents: SimEvent[] = [];
  /** the previous snapshot interval's events, for clients that skipped it (low-bandwidth mode) */
  private previousEvents: SimEvent[] = [];
  private readonly inputs: (Input | undefined)[] = [];
  private readonly packet = createInputPacket();
  private readonly snapshots = new SnapshotEncoder();
  private snapshotSeq = 0;
  private readonly maxHumans: number;
  private readonly snapshotEvery: number;
  private readonly dev: boolean;
  private readonly hostTuning: boolean;
  private readonly aoi: boolean;
  private readonly graceTicks: number;
  /** every player's session by token, connected or waiting for a reconnect */
  readonly sessions = new Map<string, Session>();
  /** tokens presented on a resume whose new token isn't confirmed yet (aliases, not counted) */
  private readonly unconfirmed = new Map<string, Session>();
  private readonly netSim: RoomOptions['netSim'];
  private linkSeed = 1;
  /** null when lag compensation is off */
  readonly lagComp: LagCompensator | null;
  /** the match lifecycle (match rooms), null = free play */
  readonly match: Match | null;
  /** the player who holds host rights (match rooms): settings, start, back to lobby */
  private host: Session | null = null;
  private joins = 0;
  /** something visible changed: MATCH_STATE goes out within MATCH_STATE_MIN_TICKS */
  private matchDirty = false;
  /** the phase changed: MATCH_STATE goes out this tick */
  private matchUrgent = false;
  private matchSentAt = -Infinity;
  private readonly log: (msg: string) => void;
  /** RoomOptions.fillBots, null = no bots */
  private readonly fill: { target: number; level: BotLevelId } | null;
  /** the bots this room put in, oldest first */
  readonly bots: PlayerState[] = [];

  constructor(options: RoomOptions = {}) {
    this.log = options.log ?? ((msg) => console.error(msg));
    this.game = new Game({ seed: options.seed ?? 1, mapId: options.mapId ?? 'movement-test', dummies: options.dummies ?? true, pickups: options.pickups ?? true, armory: options.armory ?? false });
    this.maxHumans = options.maxHumans ?? 8;
    this.snapshotEvery = options.snapshotEvery ?? 2;
    this.dev = options.dev ?? true;
    this.hostTuning = options.hostTuning ?? false;
    this.aoi = options.aoi ?? true;
    this.graceTicks = Math.round(((options.reconnectGraceMs ?? 20_000) / 1000) * 60);
    this.netSim = options.netSim;
    const lc = options.lagComp ?? true;
    this.lagComp = lc === false ? null : new LagCompensator({ snapshotEvery: this.snapshotEvery, log: this.dev, ...(lc === true ? {} : lc) });
    this.game.rewind = this.lagComp;
    this.lagComp?.record(this.game.tick, this.game.players);
    this.match = options.match ? new Match(this.game, options.match) : null;
    const fill = options.fillBots;
    this.fill = fill && fill.target > 0 ? { target: Math.min(fill.target, MAX_PLAYERS), level: fill.level } : null;
  }

  /** player id of the host, -1 = none (or not a match room) */
  get hostId(): number {
    return this.host?.playerId ?? -1;
  }

  /** nobody connected and no session waiting for a reconnect: the registry may close it */
  get empty(): boolean {
    return this.clients.size === 0 && this.sessions.size === 0;
  }

  /** humans in the room, including those waiting to reconnect (they keep their slot) */
  get humanCount(): number {
    return this.sessions.size;
  }

  /** a HELLO presenting `token` would resume a player here (rooms.ts admits those without a ticket) */
  hasSession(token: string): boolean {
    return this.sessions.has(token) || this.unconfirmed.has(token);
  }

  connect(conn: ClientConn): Client {
    const sim = this.netSim;
    if (!sim) {
      const client = new Client(conn, this.snapshotEvery);
      this.clients.add(client);
      return client;
    }
    // conditioned: S→C goes through `down`, C→S through `up` (see receive)
    const enabled = () => sim.settings.enabled;
    const down = new ConditionedLink(sim.settings.down, enabled, sim.scheduler, (b) => conn.send(b), isUnreliableMessage, this.linkSeed++);
    const client = new Client(
      { send: (b) => down.send(b), close: (code, reason) => conn.close(code, reason), bufferedAmount: () => conn.bufferedAmount() },
      this.snapshotEvery,
    );
    client.down = down;
    client.up = new ConditionedLink(sim.settings.up, enabled, sim.scheduler, (b) => this.handleSafely(client, b), isUnreliableMessage, this.linkSeed++);
    this.clients.add(client);
    return client;
  }

  /**
   * The connection is gone. Its player waits `reconnectGraceMs` for the session to come back
   * (`resumable`), or leaves now (kicked, or grace disabled).
   */
  disconnect(client: Client, resumable = true): void {
    client.closed = true;
    client.up?.dispose();
    client.down?.dispose();
    this.clients.delete(client);
    const s = client.session;
    client.session = null;
    client.playerId = -1;
    if (!s) return;
    if (resumable && this.graceTicks > 0) {
      s.client = null;
      s.expiresAt = this.game.tick + this.graceTicks;
      s.idle.aim = client.lastInput.aim;
      return;
    }
    this.endSession(s);
  }

  private endSession(s: Session): void {
    this.sessions.delete(s.token);
    if (s.prevToken) this.unconfirmed.delete(s.prevToken);
    this.game.removePlayer(s.playerId);
    if (this.host === s) this.host = this.longestPresent();
    this.matchDirty = true;
    this.broadcastRoster();
  }

  /** docs/07 §5.3 host migration: the session that joined first among those left. */
  private longestPresent(): Session | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) if (!best || s.joinSeq < best.joinSeq) best = s;
    return best;
  }

  /** Called once per second: refills every client's message allowance; kicks INPUT floods. */
  resetRateLimits(): void {
    for (const c of this.clients) {
      c.messageTokens = Math.min(MESSAGE_BURST, c.messageTokens + MAX_MESSAGES_PER_SECOND);
      c.inputTokens = Math.min(INPUT_BURST, c.inputTokens + INPUTS_PER_SECOND);
      c.inputFloodSeconds = c.inputsOverLimit > 0 ? c.inputFloodSeconds + 1 : 0;
      c.inputsOverLimit = 0;
      if (c.inputFloodSeconds >= INPUT_FLOOD_SECONDS) this.kick(c, CloseCode.RateLimited, 'rate limited');
    }
  }

  /** Bytes from the transport. Must not be retained by the caller's buffer pool when netSim is on (they are queued). */
  receive(client: Client, bytes: Uint8Array): void {
    if (client.up) client.up.send(bytes);
    else this.handleSafely(client, bytes);
  }

  /**
   * One message, isolated: a malformed one is a strike (DecodeError), anything else that throws is
   * a bug, logged, and costs only the client that sent it (kicked, 1011); the room and server go on.
   */
  private handleSafely(client: Client, bytes: Uint8Array): void {
    try {
      this.handle(client, bytes);
    } catch (e) {
      this.log(`[room] a message from player ${client.playerId} (${bytes.length} B, type 0x${(bytes[0] ?? 0).toString(16)}) threw; kicking that client: ${(e as Error).stack ?? e}`);
      try {
        this.kick(client, 1011, 'server error');
      } catch (again) {
        this.log(`[room] …and kicking it threw too: ${(again as Error).stack ?? again}`);
      }
    }
  }

  private handle(client: Client, bytes: Uint8Array): void {
    if (client.closed) return;
    if (bytes[0] === MsgType.Input) {
      // hot path (60/s per client): pooled decode, no allocation
      try {
        if (bytes.length > MAX_INPUT_BYTES) throw new DecodeError('oversized INPUT');
        decodeInputInto(bytes, this.packet);
      } catch (e) {
        this.strike(client, e);
        return;
      }
      if (client.heldInputLength > 0) {
        // older than this one, and its inputs are in this one's redundant copies
        client.inputsDropped++;
        client.heldInputLength = 0;
      }
      if (client.inputTokens <= 0) {
        client.inputsOverLimit++;
        client.heldInput.set(bytes);
        client.heldInputLength = bytes.length;
        return;
      }
      client.inputTokens--;
      this.onInput(client);
      return;
    }
    if (--client.messageTokens < 0) {
      this.kick(client, CloseCode.RateLimited, 'rate limited');
      return;
    }
    let msg: ClientMessage;
    try {
      const decoded = decodeMessage(bytes);
      if (decoded.type !== MsgType.Hello && decoded.type !== MsgType.Ping && decoded.type !== MsgType.Cmd) {
        throw new DecodeError('server-only message type from client');
      }
      msg = decoded;
    } catch (e) {
      this.strike(client, e);
      return;
    }

    switch (msg.type) {
      case MsgType.Hello:
        this.onHello(client, msg.protocolVersion, msg.contentHash, msg.name, msg.resumeToken);
        break;
      case MsgType.Ping:
        this.confirmToken(client);
        client.conn.send(encodePong(msg.clientTime, this.game.tick));
        break;
      case MsgType.Cmd:
        // SetLowBandwidth is state, not an action: dropping one would leave this client and the
        // server in different modes, and its one perk waits out a warm-up anyway
        if (msg.kind === CmdKind.SetLowBandwidth || this.takeCmdToken(client)) this.onCmd(client, msg.kind, msg.payload);
        break;
    }
  }

  private takeCmdToken(client: Client): boolean {
    const now = this.game.tick;
    const elapsed = Math.max(0, now - client.cmdTokensAt);
    client.cmdTokens = Math.min(CMD_BURST, client.cmdTokens + (elapsed * TICK_MS * CMDS_PER_SECOND) / 1000);
    client.cmdTokensAt = now;
    if (client.cmdTokens < 1) return false;
    client.cmdTokens--;
    return true;
  }

  /** A malformed message counts against the client; anything else is a bug for handleSafely (it kicks). */
  private strike(client: Client, e: unknown): void {
    if (!(e instanceof DecodeError)) throw e;
    if (++client.strikes >= MAX_STRIKES) this.kick(client, CloseCode.BadMessage, 'malformed messages');
  }

  private onInput(client: Client): void {
    if (!client.joined) return;
    this.confirmToken(client);
    const m = this.packet;
    const current = this.game.tick;
    const newest = unwrapTick(m.newestTick, current);
    client.inputs.notePacket(newest);
    client.baselines.ack(m.ackSnapshotSeq);
    // where the client was drawing remote players when it sampled the newest input (lag comp)
    const renderTick = unwrapTick(m.renderTick, current) + m.renderFrac / 256;
    // inputs[i] is for newest − i, sampled when the client showed renderTick − renderLags[i];
    // copies of ticks already simulated are ignored
    for (let i = 0; i < m.count; i++) client.inputs.push(newest - i, m.inputs[i]!, current, renderTick - m.renderLags[i]!);
  }

  private onHello(client: Client, version: number, contentHash: number, rawName: string, resumeToken: string): void {
    if (client.joined) return;
    if (version !== PROTOCOL_VERSION || contentHash !== CONTENT_HASH) {
      this.kick(client, CloseCode.VersionMismatch, 'version mismatch: refresh to update');
      return;
    }
    const resumed = resumeToken ? (this.sessions.get(resumeToken) ?? this.unconfirmed.get(resumeToken)) : undefined;
    if (resumed) {
      this.resume(client, resumed, resumeToken);
      return;
    }
    if (this.humanCount >= this.maxHumans) {
      this.kick(client, CloseCode.RoomFull, 'room full');
      return;
    }
    const p = this.game.addPlayer(sanitizeName(rawName, `Player ${this.humanCount + 1}`));
    const session: Session = { token: newToken(), playerId: p.id, client: null, expiresAt: Infinity, idle: createInput(), prevToken: null, joinSeq: this.joins++, pingMs: -1 };
    this.sessions.set(session.token, session);
    if (this.match && !this.host) this.host = session;
    this.attach(client, session, false);
    this.broadcastRoster();
    this.matchDirty = true;
  }

  /** Reconnect: this connection takes the session's player over (replacing a stale connection). */
  private resume(client: Client, s: Session, presented: string): void {
    const stale = s.client;
    if (stale) {
      // the old socket hasn't noticed the drop yet (or the session moved tabs): retire it quietly
      stale.session = null;
      stale.playerId = -1;
      stale.conn.close(CloseCode.DuplicateSession, 'resumed from another connection');
      this.disconnect(stale);
    }
    // rotate the token (a leaked old one becomes useless), but keep the presented one valid until
    // this connection confirms it got the new one: the client may lose this WELCOME and retry
    this.sessions.delete(s.token);
    if (s.prevToken) this.unconfirmed.delete(s.prevToken);
    s.prevToken = presented;
    this.unconfirmed.set(presented, s);
    s.token = newToken();
    this.sessions.set(s.token, s);
    this.attach(client, s, true);
    // only this client missed anything: it gets a full snapshot (fresh baselines), the roster and the match
    client.conn.send(encodeRoster(this.rosterEntries()));
    if (this.match) client.conn.send(this.encodeMatchState());
  }

  private attach(client: Client, s: Session, resumed: boolean): void {
    s.client = client;
    s.expiresAt = Infinity;
    client.session = s;
    client.playerId = s.playerId;
    const p = this.game.players[s.playerId]!;
    client.name = p.name;
    client.lastInput.aim = s.idle.aim;
    client.conn.send(
      encodeWelcome({
        playerId: p.id,
        seed: this.game.seed,
        serverTick: this.game.tick,
        mapId: this.game.map.id,
        tuningJson: JSON.stringify(this.game.tuning),
        sessionToken: s.token,
        resumed,
      }),
    );
  }

  private onCmd(client: Client, kind: number, payload: string): void {
    if (!client.joined) return;
    if (kind >= CmdKind.Ready && kind <= CmdKind.Leave) {
      this.onMatchCmd(client, kind, payload);
      return;
    }
    if (kind === CmdKind.SetTuning) {
      // dev rooms: anyone, any tuning value; a host-tuning room (pnpm playtest --tune): its host
      // only, within the tuning panel's keys and ranges; anywhere else: nobody
      if (this.dev) this.setTuning(client, payload, false);
      else if (this.hostTuning && this.host !== null && client.session === this.host) this.setTuning(client, payload, true);
      // not (or no longer) the host: its prediction goes back to the room's tuning
      else if (this.hostTuning) client.conn.send(encodeTuning(JSON.stringify(this.game.tuning)));
      return;
    }
    if (!this.dev && kind !== CmdKind.SetLowBandwidth) return;
    if (kind === CmdKind.SetLowBandwidth) {
      // half the snapshot rate for this client (docs/05 §2.2); allowed outside dev rooms too
      const on = payload === '1';
      client.snapshotEvery = on ? this.snapshotEvery * 2 : this.snapshotEvery;
      if (!on) client.lowBwSince = -1;
      else if (client.lowBwSince < 0) client.lowBwSince = this.game.tick;
    } else if (kind === CmdKind.Respawn) {
      const p = this.game.players[client.playerId];
      if (p?.alive) p.spawn(p.x, p.y + 0.5, this.game.tuning);
    }
  }

  /** A live tuning edit (JSON): `limited` keeps it to the tuning panel's keys and ranges (a host's). */
  private setTuning(client: Client, payload: string, limited: boolean): void {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      let next: Partial<Tuning> = {};
      if (limited) next = limitTuning(parsed);
      else {
        for (const key of Object.keys(defaultTuning) as (keyof Tuning)[]) {
          const v = parsed[key];
          if (typeof v === 'number' && Number.isFinite(v)) next[key] = v;
        }
      }
      this.game.tuning = createTuning({ ...this.game.tuning, ...next });
      // every client predicts with the room's tuning: keep them in step
      const bytes = encodeTuning(JSON.stringify(this.game.tuning));
      for (const c of this.clients) if (c.joined && c !== client) c.conn.send(bytes);
    } catch {
      client.strikes++;
    }
  }

  /** Lobby and results commands (any room for Leave and ReportPing; the rest need a match). */
  private onMatchCmd(client: Client, kind: number, payload: string): void {
    const s = client.session!;
    if (kind === CmdKind.Leave) {
      this.kick(client, 1000, 'left the room');
      return;
    }
    if (kind === CmdKind.ReportPing) {
      const ms = Number(payload);
      if (Number.isInteger(ms) && ms >= 0) s.pingMs = Math.min(ms, 9999);
      return;
    }
    const m = this.match;
    if (!m) return;
    const isHost = this.host === s;
    switch (kind) {
      case CmdKind.Ready:
        m.setReady(s.playerId, payload === '1');
        break;
      case CmdKind.StartMatch:
        if (isHost) m.start();
        break;
      case CmdKind.Rematch:
        m.voteRematch(s.playerId);
        break;
      case CmdKind.ReturnToLobby:
        if (isHost) m.returnToLobby();
        break;
      case CmdKind.MatchSettings: {
        if (!isHost || m.phase !== MatchPhase.Waiting) break;
        const next = parseMatchSettings(payload, m.rules, this.game.map.id);
        if (!next) break;
        m.rules.timeLimit = next.timeLimit;
        m.rules.killLimit = next.killLimit;
        // other maps: the room would need a new Game; until then only the current map is accepted
        break;
      }
      default:
        return;
    }
    this.matchDirty = true;
  }

  /** The room's match as MATCH_STATE (match rooms only). */
  encodeMatchState(): Uint8Array {
    const m = this.match!;
    const ended = m.phase === MatchPhase.Ending || m.phase === MatchPhase.Postgame || m.phase === MatchPhase.Closed;
    const pings = new Map<number, number>();
    for (const s of this.sessions.values()) pings.set(s.playerId, s.pingMs);
    const r = m.results;
    return encodeMatchState({
      phase: m.phase,
      phaseStartTick: this.game.tick - m.phaseTick,
      number: m.number,
      endReason: m.endReason,
      rules: m.rules,
      mapId: this.game.map.id,
      hostId: this.hostId,
      lobby: m.players.flatMap((p) => (p ? [{ id: p.id, ready: p.ready, rematch: p.rematch, pingMs: pings.get(p.id) ?? -1 }] : [])),
      standings: (ended && r ? r.standings : m.standings()).map(standingWire),
      results: r ? { number: r.number, reason: r.reason, durationTicks: r.durationTicks, winnerKey: r.winnerKey, mvpKey: r.mvpKey } : null,
    });
  }

  private sendMatchState(): void {
    this.matchDirty = this.matchUrgent = false;
    this.matchSentAt = this.game.tick;
    const bytes = this.encodeMatchState();
    for (const c of this.clients) if (c.joined) c.conn.send(bytes);
  }

  /** Dev rooms: show each shooter the poses its shots were tested against (rewind visualiser). */
  private sendRewindDebug(lagComp: LagCompensator, tick: number): void {
    for (const c of this.clients) {
      if (!c.joined) continue;
      let targets: RewindTarget[] | null = null;
      let first = null;
      for (const r of lagComp.log) {
        if (r.shooter !== c.playerId) continue;
        first ??= r;
        // pellets and melee rays test the same target several times per shot: draw it once
        if (targets?.some((t) => t.id === r.target)) continue;
        let hit = false;
        for (const e of this.game.events) if (e.type === 'shot' && e.shooter === r.shooter && e.target === r.target) hit = true;
        (targets ??= []).push({ id: r.target, x: r.x, y: r.y, crouched: r.crouched, nowX: r.nowX, nowY: r.nowY, hit });
      }
      if (!first || !targets) continue;
      c.conn.send(
        encodeRewindDebug({
          tick,
          shooter: c.playerId,
          rewindTicks: Math.max(0, Math.min(255, tick - first.usedTick)),
          requestedTicks: Math.max(0, Math.min(255, tick - first.viewTick)),
          clamped: first.clamped,
          targets,
        }),
      );
    }
  }

  /** The client has the token from its latest WELCOME: retire the one it resumed with. */
  private confirmToken(client: Client): void {
    const s = client.session;
    if (!s?.prevToken) return;
    this.unconfirmed.delete(s.prevToken);
    s.prevToken = null;
  }

  /** Everyone out, sessions ended (the registry closing the room). */
  closeAll(code: number, reason: string): void {
    for (const c of [...this.clients]) this.kick(c, code, reason);
    for (const s of [...this.sessions.values()]) this.endSession(s);
  }

  /** Kicked players leave at once (no reconnect grace). */
  private kick(client: Client, code: number, reason: string): void {
    if (client.closed) return;
    // uWS runs the socket's close handler (→ a resumable disconnect) inside conn.close, so the
    // session must end first, or the kicked player would idle on with a token that still works
    const s = client.session;
    client.session = null;
    client.playerId = -1;
    if (s) this.endSession(s);
    client.conn.close(code, reason);
    this.disconnect(client, false);
  }

  /** When each player first shows in snapshots (ROSTER `since`: ids are reused). */
  private readonly shownSince = new WeakMap<PlayerState, number>();

  private rosterEntries(): RosterEntry[] {
    return this.game.players
      .filter((p) => p !== null)
      .map((p) => {
        let since = this.shownSince.get(p);
        if (since === undefined) {
          // a roster goes out as soon as a player is added (between ticks): it shows from the next one
          since = this.game.tick + 1;
          this.shownSince.set(p, since);
        }
        return { id: p.id, name: p.name, isBot: p.isBot, since };
      });
  }

  private broadcastRoster(): void {
    const bytes = encodeRoster(this.rosterEntries());
    for (const c of this.clients) if (c.joined) c.conn.send(bytes);
  }

  /**
   * Bots keep the room at fillBots.target players while a human is in it (those waiting to
   * reconnect included): one goes when a human comes in, the lowest scorer (a joiner takes a bot's
   * place, not its stats; a leaver keeps its standing), one comes in when a human leaves for good,
   * and they all go with the last human. Before the tick's step, as a replay puts them back
   * (packages/bots botReplaySetup).
   */
  private fillWithBots(): void {
    const fill = this.fill;
    if (!fill) return;
    const humans = this.humanCount;
    const want = humans > 0 ? Math.max(0, fill.target - humans) : 0;
    let changed = false;
    while (this.bots.length > want) {
      removeBot(this.game, this.botToDrop());
      changed = true;
    }
    while (this.bots.length < want && this.game.players.some((p) => !p)) {
      this.bots.push(addBot(this.game, { level: fill.level }));
      changed = true;
    }
    if (!changed) return;
    this.broadcastRoster();
    this.matchDirty = true;
  }

  /** The bot to make room with: the lowest score in the match, the newest on a tie (out of `bots`). */
  private botToDrop(): PlayerState {
    let pick = this.bots.length - 1;
    const score = (p: PlayerState) => this.match?.players[p.id]?.score ?? 0;
    for (let i = this.bots.length - 2; i >= 0; i--) if (score(this.bots[i]!) < score(this.bots[pick]!)) pick = i;
    return this.bots.splice(pick, 1)[0]!;
  }

  /** Advances the room by one 60 Hz tick. */
  tick(): void {
    const current = this.game.tick;
    const lagComp = this.lagComp;
    lagComp?.begin(current);
    this.inputs.length = 0;
    for (const c of this.clients) {
      if (!c.joined) continue;
      if (c.heldInputLength > 0) {
        // the newest INPUT that came over the rate limit (validated when it arrived)
        decodeInputInto(c.heldInput.subarray(0, c.heldInputLength), this.packet);
        c.heldInputLength = 0;
        this.onInput(c);
      }
      const health = c.inputs.health(current);
      if (health !== HEALTH_UNKNOWN && health < c.healthMin) c.healthMin = health;
      // this tick's input, or the last one repeated (docs/05 §13)
      c.inputs.take(current, c.lastInput);
      this.inputs[c.playerId] = c.lastInput;
      // the rewind cap allows for this client's view delay: interpolation (+ input batching when
      // slim, once it has been slim for LOW_BW_WARMUP_TICKS)
      const lowBandwidth = c.lowBwSince >= 0 && current - c.lowBwSince >= LOW_BW_WARMUP_TICKS;
      const viewDelayMs = lowBandwidth ? LOW_BANDWIDTH_INTERP_DELAY_MS + TICK_MS : INTERP_DELAY_MS;
      lagComp?.setView(c.playerId, c.inputs.renderTickFor(current), lowBandwidth ? c.snapshotEvery : this.snapshotEvery, viewDelayMs);
    }
    // players waiting for a reconnect stand idle; give up on them after the grace
    for (const s of this.sessions.values()) {
      if (s.client) continue;
      if (current >= s.expiresAt) this.endSession(s);
      else this.inputs[s.playerId] = s.idle;
    }
    this.fillWithBots();
    if (this.match) {
      this.match.step(this.inputs);
      for (const e of this.match.events) {
        this.matchDirty = true;
        if (e.type === 'phase') this.matchUrgent = true;
      }
    } else this.game.step(this.inputs);
    lagComp?.record(this.game.tick, this.game.players);
    if (lagComp && lagComp.log.length > 0) this.sendRewindDebug(lagComp, current);
    for (const e of this.game.events) this.pendingEvents.push(e);

    if (this.game.tick % this.snapshotEvery === 0) {
      // 1..65535: 0 means "nothing acked" in INPUT
      this.snapshotSeq = (this.snapshotSeq % 0xffff) + 1;
      this.snapshots.begin(this.game, this.snapshotSeq, this.pendingEvents);
      for (const c of this.clients) {
        if (!c.joined || c.closed || this.game.tick % c.snapshotEvery !== 0) continue;
        // on TCP a stale snapshot is worse than a missing one (docs/05 §2.2)
        if (c.conn.bufferedAmount() > BACKPRESSURE_LIMIT) {
          c.snapshotsSkipped++;
          continue;
        }
        const health = c.healthMin === Infinity ? HEALTH_UNKNOWN : Math.max(-127, Math.min(127, c.healthMin));
        c.healthMin = Infinity;
        const me = this.game.players[c.playerId] ?? null;
        // skipped the previous interval (low-bandwidth mode): its events come with this one
        const skipped = c.lastSnapshotTick >= 0 && this.game.tick - c.lastSnapshotTick > this.snapshotEvery;
        c.lastSnapshotTick = this.game.tick;
        c.conn.send(
          this.snapshots.encodeFor({
            baselines: c.baselines,
            ackInputTick: current & 0xffff,
            inputBufferHealth: health,
            local: me,
            view: this.aoi && me ? aoiRect(me, this.game.map, c.view) : null,
            ...(skipped ? { extraEvents: this.previousEvents } : {}),
          }),
        );
      }
      const spent = this.previousEvents;
      this.previousEvents = this.pendingEvents;
      this.pendingEvents = spent;
      this.pendingEvents.length = 0;
    }
    if (this.match) {
      const since = this.game.tick - this.matchSentAt;
      if (this.matchUrgent || (this.matchDirty && since >= MATCH_STATE_MIN_TICKS) || since >= MATCH_STATE_REFRESH_TICKS) this.sendMatchState();
    }
  }
}
