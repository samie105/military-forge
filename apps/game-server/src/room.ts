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
import { adminJson, adminValues, onAdminValues } from './adminState';
import { VoiceRelay } from './voice';
import { MatchRecorder, type ResultsSink } from './matchRecorder';
import { addBot, latestNavGraph, removeBot, requestNavGraph, type BotLevelId, type NavGraph } from '@military-forge/bots';
import {
  ADMIN_BOT_LEVELS,
  admitLook,
  adminTuning,
  adminValue,
  botLook,
  cosmeticLoadoutWireIds,
  createTuning,
  defaultTuning,
  limitTuning,
  lookSeed,
  maps,
  type AdminValues,
  type LookVouch,
  type Tuning,
} from '@military-forge/content';
import {
  BOT_LEVELS_WIRE,
  CONTENT_HASH,
  CloseCode,
  CmdKind,
  DecodeError,
  HEALTH_UNKNOWN,
  MAX_SPECTATORS,
  MsgType,
  SPECTATOR_VOICE_BASE,
  SnapshotBaselines,
  SnapshotEncoder,
  SpectateMode,
  SpectateQueue,
  encodeSpectate,
  parseSpectateCmd,
  spectatorRing,
  type SpectateModeId,
  type SpectateQueueId,
  createInputPacket,
  decodeInputInto,
  decodeMessage,
  encodePong,
  encodeRewindDebug,
  encodeRoster,
  type RosterEntry,
  encodeMatchState,
  encodeOverrides,
  encodeTuning,
  encodeWelcome,
  isUnreliableMessage,
  parseLookCmd,
  parseSetTeam,
  protocolSupported,
  ROOM_SETTING_LIMITS,
  type ClientMessage,
  type MatchStandingWire,
  type RewindTarget,
  type ViewRect,
  type VoiceSettingsCmd,
} from '@military-forge/protocol';
import {
  ConditionedLink,
  MAX_VIEW_DELAY_MS,
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
  TEAM_MODES,
  copyInput,
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
  /** the transport, for the room's connection log */
  kind?: 'ws' | 'wt' | 'lan';
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
  /**
   * lag compensation for hitscan (default on): `latencyCapMs` is the latency compensated on top of
   * the view delay (default LAG_COMP_LATENCY_CAP_MS, 250 ms), `maxRewindMs` a fixed total instead.
   * The admin page's net.lagCompMs outranks both while it's set.
   */
  lagComp?: boolean | { maxRewindMs?: number; latencyCapMs?: number };
  /** send each client only what its camera can show (default on, docs/05 §9) */
  aoi?: boolean;
  /** how long a dropped player waits for its session to reconnect (default RECONNECT_GRACE_MS, 60 s; 0 = never) */
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
  /** match rooms: each finished match's results go here (results.ts; the API records them) */
  results?: ResultsSink | null;
  /** the room's code, for the results ('' = the default room) */
  code?: string;
}

/** A player's claim on the room; outlives its connection for the reconnect grace. */
export interface Session {
  token: string;
  playerId: number;
  /** the connection driving this player, null while waiting for a reconnect */
  client: Client | null;
  /** tick at which a detached session is given up */
  expiresAt: number;
  /** the connection log: when this connection began, and when the last one dropped (−1: it didn't) */
  connectedTick: number;
  droppedTick: number;
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
  /** the player's party (the join ticket's `party`), kept across reconnects for party voice */
  party: string | null;
  /** v19: what the player may wear (the join ticket's level and look), kept across reconnects */
  vouch: LookVouch;
}

/** 18 random bytes, base64url (Web Crypto: a room runs in Node and, for a local room's host, in a browser) */
const newToken = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(18));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const utf8 = new TextEncoder();

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
/**
 * How long a dropped player keeps its place (RoomOptions.reconnectGraceMs): 60 s, the page's own
 * reconnect window. It was 20 s, shorter than a phone's app switch (24 Oct 2026: a player lost its
 * place twice in one match).
 */
export const RECONNECT_GRACE_MS = 60_000;
/**
 * The late-input catch-up (owner, 23 Oct 2026: on 4G the player "keeps returning"). When a client's
 * inputs stop coming (its uplink stalled: nothing newer has come either), its player is held still
 * for up to HOLD_TICKS instead of running on a guess; when they come, it catches up through them,
 * CATCH_UP_PER_TICK extra ticks a tick, and ends where the client predicted it: no correction. A
 * hold that runs out gives the missing ticks stand-ins (the last input, then no keys: docs/05 §13)
 * and runs them at once; the next stall may be held again. 1 s covers a phone's upload-queue spikes
 * (netfeel MTN: corrections 218 → 0.8 a minute, 2 m+ jumps 12.8 → 0.4; at 250 ms: 20 and 12.8;
 * at 500 ms: 7.6 and 9.2). Others see a stalled player stand still, then hurry on.
 */
export const HOLD_TICKS = 60;
export const CATCH_UP_PER_TICK = 2;
/**
 * A host gone this long (disconnected, or its connection silent: a stall the server can't see as a
 * close) hands the room to the longest-present player still here (docs/07 §5.3), so nobody waits
 * out the 60 s reconnect grace to start the match. 5 s: longer than a reconnect after a blip.
 */
export const HOST_AWAY_TICKS = 5 * 60;
const BACKPRESSURE_LIMIT = 16 * 1024;
/** docs/05 §14: INPUT packets are tiny; anything bigger is malformed */
const MAX_INPUT_BYTES = 64;

export class Client {
  playerId = -1;
  /** the API account this connection's join ticket named (rooms.ts); null = a guest without one, or a dev room */
  accountId: string | null = null;
  /** why this page isn't on WebTransport, as it said (the connection log; '' unknown or on it) */
  noWebTransport = '';
  /** the player's saved gun pair from the join ticket (weapon indices, checked against content); null = the default pair */
  guns: [number, number] | null = null;
  /** the protocol version its HELLO said (v17 clients play on, without voice: MIN_PROTOCOL_VERSION) */
  protocolVersion = 0;
  /** the join ticket's party (invites/party on the API): party voice reaches party mates; null = none */
  party: string | null = null;
  /** voice chat (voice.ts): its settings (null: never asked for voice), its mutes, its frame budget, what it hears now */
  voice: VoiceSettingsCmd | null = null;
  voiceMutes?: Set<number>;
  voiceTokens?: number;
  voiceTokensAt?: number;
  voiceActive?: Map<number, [number, number]>;
  /** v19: what the join ticket says the player may wear (rooms.ts); no ticket: starter items only */
  lookVouch: LookVouch = { level: 0 };
  name = '';
  closed = false;
  /** this client's inputs, by server tick */
  readonly inputs = new InputBuffer();
  /** what the sim uses: the input for the current tick, or the last one repeated */
  readonly lastInput: Input = createInput();
  /** the late-input catch-up: the view each input was aimed at (lag compensation), the main one's and the extras' */
  mainView = Number.NaN;
  readonly catchUpViews: number[] = [];
  viewEvery = 2;
  viewDelayMs = 0;
  /** the late-input catch-up: this tick's first input (lastInput is the newest taken) */
  readonly mainInput: Input = createInput();
  /** the late-input catch-up: a hold ran out; none again until an input comes */
  holdSpent = false;
  /** the late-input catch-up's inputs for this tick (Game.catchUp) */
  readonly catchUp: Input[] = Array.from({ length: HOLD_TICKS + CATCH_UP_PER_TICK + 1 }, createInput);
  /** lowest buffer health since the last snapshot */
  healthMin = Infinity;
  /** snapshots sent to this client recently: delta baselines (docs/05 §11; a spectator's ring fits its delay) */
  baselines = new SnapshotBaselines();
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
  /** server tick of the last message from this connection (a host gone silent hands over: HOST_AWAY_TICKS) */
  lastHeardTick = 0;
  /** the player this connection drives (null before WELCOME) */
  session: Session | null = null;
  /** network conditioner links (only with RoomOptions.netSim) */
  up: ConditionedLink | null = null;
  down: ConditionedLink | null = null;

  // ---- v20: spectating ----
  /** a spectator (HELLO's flag): no player, never sends INPUT; gets the whole map, `delayTicks` behind */
  spectator = false;
  /** its seat among the room's spectators (voice id SPECTATOR_VOICE_BASE + seat), −1 = none */
  seat = -1;
  /** a spectator's feed runs this far behind the match (fixed when it came in: its baselines ring fits it) */
  delayTicks = 0;
  /** a spectator's wish to play (SpectateQueue) */
  queue: SpectateQueueId = SpectateQueue.Watching;
  /** a spectator's look from its HELLO, worn if it takes a slot */
  look: number[] | null = null;
  /** the death cam (a dead v20 player): whose view its snapshots follow, −1 = its own */
  follow = -1;
  /** who killed it last (the death cam starts there, and spectate.deathCam 1 keeps it there), −1 = nobody */
  killer = -1;
  /** a spectator's messages held back by the delay (snapshots may be skipped under backpressure, the rest not) */
  readonly delayed: { at: number; bytes: Uint8Array; snapshot: boolean }[] = [];
  /** the SPECTATE this client was last sent (a new one goes only when it differs) */
  spectateSent = '';

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

  /** in the room: a player, or a spectator (gets the room's messages) */
  get inRoom(): boolean {
    return this.playerId >= 0 || this.spectator;
  }

  /** its voice id (v20): its player id, or a spectator's 32 + seat; −1 = none yet */
  get voiceId(): number {
    return this.playerId >= 0 ? this.playerId : this.spectator && this.seat >= 0 ? SPECTATOR_VOICE_BASE + this.seat : -1;
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
    if (count === MAX_NAME_GRAPHEMES || utf8.encode(name + segment).length > MAX_NAME_BYTES) break;
    name += segment;
    count++;
  }
  return name.trim() || fallback;
}

/** How often MATCH_STATE is re-sent with nothing else changed (damage and ping columns). */
const MATCH_STATE_REFRESH_TICKS = 120;
/** Lobby commands and kills batch into at most one MATCH_STATE per this many ticks; phase changes go at once. */
const MATCH_STATE_MIN_TICKS = 6;
/** v19: look changes batch into at most one ROSTER per this many ticks (½ s) per room */
const LOOK_ROSTER_TICKS = 30;

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

/**
 * The host's bots from a MatchSettings CMD (v17): `{ bots?, botLevel? }`, the players bots keep the
 * room at (0 = none, at most MAX_PLAYERS) and their level. Undefined when the payload has neither
 * (a limits-only edit), null when it's malformed; a missing half keeps `current`'s.
 */
export function parseBotSettings(payload: string, current: { target: number; level: BotLevelId }): { target: number; level: BotLevelId } | null | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.bots === undefined && o.botLevel === undefined) return undefined;
  const target = o.bots === undefined ? current.target : o.bots;
  const level = o.botLevel === undefined ? current.level : o.botLevel;
  if (typeof target !== 'number' || !Number.isInteger(target) || target < 0 || target > MAX_PLAYERS) return null;
  if (typeof level !== 'string' || !(BOT_LEVELS_WIRE as readonly string[]).includes(level)) return null;
  return { target, level: level as BotLevelId };
}

/** The host's mode from a MatchSettings CMD (v21): `teams` 0, 2, 3 or 4; undefined when absent or not one of those. */
export function parseTeamsSetting(payload: string): number | undefined {
  try {
    const o = JSON.parse(payload) as Record<string, unknown> | null;
    const t = o && typeof o === 'object' ? o.teams : undefined;
    return typeof t === 'number' && (TEAM_MODES as readonly number[]).includes(t) ? t : undefined;
  } catch {
    return undefined;
  }
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
    team: s.team,
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
  private readonly armory: boolean;
  private readonly hostTuning: boolean;
  private readonly aoi: boolean;
  private readonly graceTicks: number;
  /** the room's code, for its log lines ('' for the dev room) */
  private readonly code: string;
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
  /** the bots this room keeps: the admin page's, else RoomOptions.fillBots; null = no bots */
  private fill: { target: number; level: BotLevelId } | null;
  /**
   * The room's host's choice (MatchSettings `bots` / `botLevel`, the lobby's rules and Tune the
   * game; target 0 = no bots), which outranks `fill` for this room from then on; undefined until the
   * host picks.
   */
  private hostFill: { target: number; level: BotLevelId } | undefined = undefined;
  /** RoomOptions.fillBots, and the match limits it was made with: what the admin page's reset goes back to */
  private readonly baseFill: { target: number; level: BotLevelId } | null;
  /** the room's own limits: its defaults, then whatever its host set in the lobby */
  private baseLimits: { timeLimit: number; killLimit: number } | null;
  /**
   * The admin page's match limits as last applied (undefined: not set), and limits it changed that
   * wait for the match to be between games (a running match keeps the limits it started with).
   */
  private adminLimits: { timeLimit?: number; killLimit?: number } = {};
  private pendingLimits: { timeLimit?: number; killLimit?: number } | null = null;
  private readonly offAdmin: () => void;
  /** the bots this room put in, oldest first */
  readonly bots: PlayerState[] = [];
  /** reports each finished match (match rooms with a results sink) */
  private readonly recorder: MatchRecorder | null;
  /** voice chat's relay (v18): who hears whom, frame by frame */
  readonly voice: VoiceRelay;

  constructor(options: RoomOptions = {}) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const room = this;
    this.log = options.log ?? ((msg) => console.error(msg));
    this.game = new Game({ seed: options.seed ?? 1, mapId: options.mapId ?? 'movement-test', dummies: options.dummies ?? true, pickups: options.pickups ?? true, armory: options.armory ?? false });
    this.maxHumans = options.maxHumans ?? 8;
    this.snapshotEvery = options.snapshotEvery ?? 2;
    this.dev = options.dev ?? true;
    this.armory = options.armory ?? false;
    this.hostTuning = options.hostTuning ?? false;
    this.aoi = options.aoi ?? true;
    this.code = options.code ?? '';
    this.graceTicks = Math.round(((options.reconnectGraceMs ?? RECONNECT_GRACE_MS) / 1000) * 60);
    this.netSim = options.netSim;
    const lc = options.lagComp ?? true;
    this.lagComp = lc === false ? null : new LagCompensator({ snapshotEvery: this.snapshotEvery, log: this.dev, ...(lc === true ? {} : lc) });
    this.game.rewind = this.lagComp;
    // a catch-up tick's shots test targets as that input's frame showed them (the late-input catch-up)
    this.game.beforeCatchUp = (p, k) => {
      if (!this.lagComp) return;
      for (const c of this.clients) {
        if (c.playerId !== p.id) continue;
        this.lagComp.setView(p.id, c.catchUpViews[k] ?? Number.NaN, c.viewEvery, c.viewDelayMs);
        return;
      }
    };
    this.lagComp?.record(this.game.tick, this.game.players);
    this.match = options.match ? new Match(this.game, options.match) : null;
    // team modes: party mates (the join ticket's party, social) are dealt onto one team
    if (this.match) this.match.groupOf = (id) => this.partyOf(id);
    this.recorder = this.match && options.results ? new MatchRecorder(options.results, options.code ?? '') : null;
    const fill = options.fillBots;
    this.fill = this.baseFill = fill && fill.target > 0 ? { target: Math.min(fill.target, MAX_PLAYERS), level: fill.level } : null;
    this.baseLimits = this.match ? { timeLimit: this.match.rules.timeLimit, killLimit: this.match.rules.killLimit } : null;
    this.voice = new VoiceRelay({
      get tick() {
        return room.game.tick;
      },
      clients: () => this.clients,
      // free play (dev rooms) is always play; a match only while counting down or running
      inPlay: () => !this.match || this.match.phase === MatchPhase.Countdown || this.match.phase === MatchPhase.InProgress,
      player: (id) => this.game.players[id] ?? null,
      // team modes (v21): the sim's team; free-for-all has none
      teamOf: (id) => {
        const t = this.game.players[id]?.team ?? -1;
        return t >= 0 ? t : null;
      },
    });
    // the owner's admin page (admin.ts): its values now, and whenever they change
    this.applyAdmin(adminValues(), false);
    this.offAdmin = onAdminValues((values) => this.applyAdmin(values, true));
  }

  /**
   * The admin page's values (admin.ts): the room's tuning is the defaults with the admin's tuning
   * keys (a host's own edits give way), the crates draw with the admin's weights, the bots and the
   * match limits are the admin's where set (else the room's own). `broadcast`: tell the clients
   * (TUNING, then OVERRIDES: the content numbers their prediction needs, and the HUD's tag).
   */
  private applyAdmin(values: AdminValues, broadcast: boolean): void {
    this.game.tuning = createTuning({ ...defaultTuning, ...adminTuning(values) });
    for (const s of this.game.spawners) s.refreshWeights();
    // lag compensation's latency cap: the admin's while set, else the room's own (RoomOptions.lagComp)
    this.lagComp?.setLatencyCap('net.lagCompMs' in values ? adminValue(values, 'net.lagCompMs') : null);
    if ('bots.count' in values || 'bots.level' in values) {
      const target = Math.min(adminValue(values, 'bots.count'), MAX_PLAYERS);
      this.fill = target > 0 ? { target, level: ADMIN_BOT_LEVELS[adminValue(values, 'bots.level')] ?? 'normal' } : null;
    } else this.fill = this.baseFill;
    this.prepareBotGraph();
    if (this.match && this.baseLimits) {
      // only the limits the admin changed (set, edited or cleared), and never under a running match:
      // an admin edit to jet fuel mustn't reset the host's 1-minute match to the server's defaults
      const next = { timeLimit: values['match.timeLimit'], killLimit: values['match.killLimit'] };
      for (const key of ['timeLimit', 'killLimit'] as const) {
        if (next[key] === this.adminLimits[key]) continue;
        (this.pendingLimits ??= {})[key] = next[key] ?? this.baseLimits[key];
      }
      this.adminLimits = next;
      this.applyPendingLimits();
    }
    if (!broadcast) return;
    const tuning = encodeTuning(JSON.stringify(this.game.tuning));
    const overrides = encodeOverrides(adminJson());
    // OVERRIDES first: a client hearing the TUNING after it knows the admin's values, so it can
    // tell the admin's change from a host's ("Tuned by admin", not "<host> changed…")
    for (const c of this.clients) {
      if (!c.inRoom) continue;
      c.conn.send(overrides);
      c.conn.send(tuning);
    }
  }

  /** The admin's changed limits, once the match is in the lobby or counting down to a new one. */
  private applyPendingLimits(): void {
    const m = this.match;
    if (!m || !this.pendingLimits) return;
    if (m.phase !== MatchPhase.Waiting && m.phase !== MatchPhase.Countdown) return;
    const p = this.pendingLimits;
    if (p.timeLimit !== undefined) m.rules.timeLimit = p.timeLimit;
    if (p.killLimit !== undefined) m.rules.killLimit = p.killLimit;
    this.pendingLimits = null;
    this.matchDirty = true;
  }

  /** The party of the player with this id (its session's), null = none. */
  private partyOf(id: number): string | null {
    for (const s of this.sessions.values()) if (s.playerId === id) return s.party;
    return null;
  }

  /** player id of the host, -1 = none (or not a match room) */
  get hostId(): number {
    return this.host?.playerId ?? -1;
  }

  /**
   * Nobody playing and no session waiting for a reconnect: the registry may close it. Spectators
   * don't keep a room open (v20): with nobody left to watch they go when it closes.
   */
  get empty(): boolean {
    if (this.sessions.size > 0) return false;
    for (const c of this.clients) if (!c.spectator) return false;
    return true;
  }

  /** the room's spectators now (v20) */
  get spectatorCount(): number {
    let n = 0;
    for (const c of this.clients) if (c.spectator) n++;
    return n;
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
      client.lastHeardTick = this.game.tick;
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
    client.lastHeardTick = this.game.tick;
    client.up = new ConditionedLink(sim.settings.up, enabled, sim.scheduler, (b) => this.handleSafely(client, b), isUnreliableMessage, this.linkSeed++);
    this.clients.add(client);
    return client;
  }

  /**
   * The connection is gone. Its player waits `reconnectGraceMs` for the session to come back
   * (`resumable`), or leaves now (kicked, or grace disabled).
   */
  disconnect(client: Client, resumable = true, why = ''): void {
    client.closed = true;
    client.up?.dispose();
    client.down?.dispose();
    this.clients.delete(client);
    if (client.spectator) this.unseat(client);
    const s = client.session;
    client.session = null;
    client.playerId = -1;
    if (!s) return;
    this.voice.changed();
    // the connection log (owner, 23 Oct 2026: phones "keep returning"; the box couldn't say why)
    const p = this.game.players[s.playerId];
    const held = ((this.game.tick - s.connectedTick) / 60).toFixed(0);
    const net = s.pingMs >= 0 ? `, ping ${s.pingMs} ms` : '';
    this.log(`[room ${this.code}] ${p?.name ?? '?'}'s ${client.conn.kind ?? ''} connection closed (${why || 'no code'}) after ${held} s${net}${resumable && this.graceTicks > 0 ? `; its place is kept ${Math.round(this.graceTicks / 60)} s` : ''}`);
    s.droppedTick = this.game.tick;
    if (resumable && this.graceTicks > 0) {
      s.client = null;
      s.expiresAt = this.game.tick + this.graceTicks;
      s.idle.aim = client.lastInput.aim;
      return;
    }
    this.endSession(s);
  }

  private endSession(s: Session): void {
    this.voice.remove(s.playerId);
    this.sessions.delete(s.token);
    if (s.prevToken) this.unconfirmed.delete(s.prevToken);
    this.game.removePlayer(s.playerId);
    if (this.host === s) this.host = this.longestPresent();
    this.matchDirty = true;
    this.broadcastRoster();
  }

  /** The host is gone or silent for HOST_AWAY_TICKS: the longest-present player still here takes over. */
  private checkHost(): void {
    const h = this.host;
    if (!this.match || !h) return;
    const now = this.game.tick;
    const awaySince = h.client ? h.client.lastHeardTick : h.expiresAt - this.graceTicks;
    if (now - awaySince < HOST_AWAY_TICKS) return;
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s === h || !s.client || now - s.client.lastHeardTick >= HOST_AWAY_TICKS) continue;
      if (!best || s.joinSeq < best.joinSeq) best = s;
    }
    if (!best) return;
    this.host = best;
    this.matchDirty = this.matchUrgent = true;
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
    client.lastHeardTick = this.game.tick;
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
    // voice frames (v18): their own budget in the relay (up to 60 a second), never the message one
    if (bytes[0] === MsgType.VoiceUp) {
      if (client.voiceId >= 0) this.voice.onFrame(client, bytes);
      return;
    }
    if (--client.messageTokens < 0) {
      this.kick(client, CloseCode.RateLimited, 'rate limited');
      return;
    }
    let msg: ClientMessage;
    try {
      const decoded = decodeMessage(bytes);
      if (decoded.type !== MsgType.Hello && decoded.type !== MsgType.Ping && decoded.type !== MsgType.Cmd && decoded.type !== MsgType.SpectateAck) {
        throw new DecodeError('server-only message type from client');
      }
      msg = decoded;
    } catch (e) {
      this.strike(client, e);
      return;
    }

    switch (msg.type) {
      case MsgType.Hello:
        this.onHello(client, msg.protocolVersion, msg.contentHash, msg.name, msg.resumeToken, msg.look, msg.spectate);
        break;
      case MsgType.SpectateAck:
        // v20: spectators ack here (they never send INPUT); a player's ack rides its INPUT
        if (client.spectator) client.baselines.ack(msg.seq);
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

  private onHello(client: Client, version: number, contentHash: number, rawName: string, resumeToken: string, look: number[] | null = null, spectate = false): void {
    if (client.joined || client.spectator) return;
    // v17 and v18 pages still play (no looks, no voice): MIN_PROTOCOL_VERSION
    if (!protocolSupported(version) || contentHash !== CONTENT_HASH) {
      this.kick(client, CloseCode.VersionMismatch, 'version mismatch: refresh to update');
      return;
    }
    client.protocolVersion ||= version; // rooms.ts already set the page's own (its HELLO may be re-encoded)
    const resumed = resumeToken ? (this.sessions.get(resumeToken) ?? this.unconfirmed.get(resumeToken)) : undefined;
    if (resumed) {
      this.resume(client, resumed, resumeToken);
      // the page's look may have changed while it was away (v19)
      if (look) this.wear(resumed, look);
      return;
    }
    // v20: a spectator takes a seat, not a slot
    if (spectate && client.protocolVersion >= 20) {
      this.seatSpectator(client, rawName, look);
      return;
    }
    if (this.humanCount >= this.maxHumans) {
      this.kick(client, CloseCode.RoomFull, 'room full');
      return;
    }
    this.addHuman(client, sanitizeName(rawName, `Player ${this.humanCount + 1}`), look);
  }

  /** A new player for this connection: its soldier, its session, its look; everyone hears of it. */
  private addHuman(client: Client, name: string, look: number[] | null): void {
    const p = this.game.addPlayer(name);
    if (client.accountId) this.recorder?.setAccount(p, client.accountId);
    // the guns they chose (their account's loadout): every spawn until a death keeps others (#125)
    if (client.guns) this.game.setLoadout(p, client.guns);
    const session: Session = { token: newToken(), playerId: p.id, client: null, expiresAt: Infinity, idle: createInput(), prevToken: null, joinSeq: this.joins++, pingMs: -1, party: client.party, vouch: client.lookVouch, connectedTick: this.game.tick, droppedTick: -1 };
    // v19: the look the page asked for, else the one the API vouched for (the ticket's), held to what the player owns
    const worn = admitLook(look, session.vouch) ?? admitLook(session.vouch.ids, session.vouch);
    if (worn) this.looks.set(p, cosmeticLoadoutWireIds(worn));
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
    const away = resumed && s.droppedTick >= 0 ? ` after ${((this.game.tick - s.droppedTick) / 60).toFixed(1)} s away` : '';
    this.log(`[room ${this.code}] ${this.game.players[s.playerId]?.name ?? '?'} ${resumed ? 'resumed' : 'joined'} over ${client.conn.kind ?? '?'}${client.noWebTransport ? ` (not WebTransport: ${client.noWebTransport})` : ''}${away}`);
    s.connectedTick = this.game.tick;
    s.droppedTick = -1;
    s.client = client;
    s.expiresAt = Infinity;
    client.session = s;
    client.playerId = s.playerId;
    // a reconnect carries no ticket: the party stays with the session
    client.party = s.party;
    this.voice.changed();
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
        overridesJson: adminJson(),
      }),
    );
  }

  private onCmd(client: Client, kind: number, payload: string): void {
    if (client.spectator) {
      this.onSpectatorCmd(client, kind, payload);
      return;
    }
    if (!client.joined) return;
    if (kind === CmdKind.Voice) {
      this.voice.onSettings(client, payload);
      return;
    }
    if (kind === CmdKind.Spectate) {
      // v20: a dead player's death cam (whom it follows)
      const cmd = parseSpectateCmd(payload);
      if (!cmd) client.strikes++;
      else if (cmd.follow !== undefined && client.protocolVersion >= 20) this.setFollow(client, cmd.follow);
      return;
    }
    if (kind >= CmdKind.Ready && kind <= CmdKind.Leave) {
      this.onMatchCmd(client, kind, payload);
      return;
    }
    if (kind === CmdKind.SetTeam) {
      // v21, host only, lobby only: a player onto a team (the lobby's team columns)
      const move = parseSetTeam(payload);
      if (!move) client.strikes++;
      else if (this.match && this.host === client.session && this.match.setTeam(move.id, move.team)) this.matchDirty = true;
      return;
    }
    if (kind === CmdKind.SetLook) {
      // v19, any room and phase: a malformed list is a strike, a look with things they don't own is fixed up
      const ids = parseLookCmd(payload);
      if (ids && client.session) this.wear(client.session, ids);
      else client.strikes++;
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
      this.setLowBandwidth(client, on);
    } else if (kind === CmdKind.Respawn) {
      const p = this.game.players[client.playerId];
      if (p?.alive) p.spawn(p.x, p.y + 0.5, this.game.tuning);
    }
  }

  private setLowBandwidth(client: Client, on: boolean): void {
    client.snapshotEvery = on ? this.snapshotEvery * 2 : this.snapshotEvery;
    if (!on) client.lowBwSince = -1;
    else if (client.lowBwSince < 0) client.lowBwSince = this.game.tick;
  }

  // ---------- v20: spectating ----------

  /** The admin's spectating numbers (content admin.ts, group "Spectating"). */
  private get spectateCap(): number {
    return Math.max(0, Math.min(MAX_SPECTATORS, Math.round(adminValue(adminValues(), 'spectate.cap'))));
  }

  private get spectateDelayTicks(): number {
    return Math.max(0, Math.min(1023, Math.round(adminValue(adminValues(), 'spectate.delay') * 60)));
  }

  /** 0 off, 1 the killer only, 2 the killer then anyone */
  private get deathCam(): number {
    return Math.round(adminValue(adminValues(), 'spectate.deathCam'));
  }

  /** something a SPECTATE carries changed for everyone (the list, free slots): checked this tick */
  private spectateDirty = false;

  /**
   * A spectator comes in (HELLO's flag): a seat under the cap (spectate.cap; 0 = off), a feed delayed
   * by spectate.delay with a baselines ring that fits it, the room's state now (WELCOME, ROSTER,
   * SPECTATE; MATCH_STATE rides the delay with the snapshots).
   */
  private seatSpectator(client: Client, rawName: string, look: number[] | null): void {
    const cap = this.spectateCap;
    if (cap === 0 || this.spectatorCount >= cap) {
      this.kick(client, CloseCode.SpectatorsFull, cap === 0 ? 'spectating is off on this server' : 'this room has all the spectators it takes');
      return;
    }
    const taken = new Set<number>();
    for (const c of this.clients) if (c.spectator) taken.add(c.seat);
    let seat = 0;
    while (taken.has(seat)) seat++;
    client.spectator = true;
    client.seat = seat;
    client.name = sanitizeName(rawName, `Spectator ${seat + 1}`);
    client.look = look;
    client.delayTicks = this.spectateDelayTicks;
    client.baselines = new SnapshotBaselines(spectatorRing(client.delayTicks, this.snapshotEvery));
    client.lastSnapshotTick = -1;
    client.queue = SpectateQueue.Watching;
    this.welcomeSpectator(client);
    client.conn.send(encodeRoster(this.rosterEntries()));
    if (this.match) this.sendDelayed(client, this.encodeMatchState(), false);
    this.spectateDirty = true;
    this.voice.changed();
    this.log(`[room] ${client.name} is watching (${this.spectatorCount}/${cap}, ${(client.delayTicks / 60).toFixed(1)} s behind)`);
  }

  private welcomeSpectator(client: Client): void {
    client.conn.send(
      encodeWelcome({
        playerId: -1,
        seed: this.game.seed,
        serverTick: this.game.tick,
        mapId: this.game.map.id,
        tuningJson: JSON.stringify(this.game.tuning),
        sessionToken: '',
        resumed: false,
        overridesJson: adminJson(),
        spectator: true,
        delayTicks: client.delayTicks,
      }),
    );
  }

  /** A spectator's seat is free again (it left, or took a slot). */
  private unseat(client: Client): void {
    this.voice.remove(client.voiceId);
    client.spectator = false;
    client.seat = -1;
    client.delayed.length = 0;
    client.queue = SpectateQueue.Watching;
    this.spectateDirty = true;
    this.voice.changed();
  }

  /** A message for a spectator, held back by its delay (in order with its snapshots). */
  private sendDelayed(client: Client, bytes: Uint8Array, snapshot: boolean): void {
    if (client.delayTicks === 0) {
      if (!snapshot || client.conn.bufferedAmount() <= BACKPRESSURE_LIMIT) client.conn.send(bytes);
      else client.snapshotsSkipped++;
      return;
    }
    client.delayed.push({ at: this.game.tick + client.delayTicks, bytes, snapshot });
  }

  /** Each tick: what a spectator's delay has held long enough goes out (a stale snapshot skipped on a backed-up socket). */
  private flushDelayed(): void {
    const now = this.game.tick;
    for (const c of this.clients) {
      if (!c.spectator || c.delayed.length === 0) continue;
      let i = 0;
      for (; i < c.delayed.length && c.delayed[i]!.at <= now; i++) {
        const d = c.delayed[i]!;
        if (d.snapshot && c.conn.bufferedAmount() > BACKPRESSURE_LIMIT) c.snapshotsSkipped++;
        else c.conn.send(d.bytes);
      }
      if (i > 0) c.delayed.splice(0, i);
    }
  }

  /** The Spectate CMD from a spectator: whom it follows (its own camera's business), its wish to play. */
  private onSpectatorCmd(client: Client, kind: number, payload: string): void {
    if (kind === CmdKind.Voice) this.voice.onSettings(client, payload);
    else if (kind === CmdKind.Leave) this.kick(client, 1000, 'left the room');
    else if (kind === CmdKind.SetLowBandwidth) this.setLowBandwidth(client, payload === '1');
    else if (kind === CmdKind.Spectate) {
      const cmd = parseSpectateCmd(payload);
      if (!cmd) {
        client.strikes++;
        return;
      }
      if (cmd.follow !== undefined) client.follow = cmd.follow;
      if (cmd.play !== undefined) {
        client.queue = cmd.play === 'now' ? SpectateQueue.Now : cmd.play === 'next' ? SpectateQueue.Next : SpectateQueue.Watching;
        this.spectateDirty = true;
      }
    }
  }

  /** A dead v20 player's death cam follows `id`, as far as spectate.deathCam allows. */
  private setFollow(client: Client, id: number): void {
    const me = this.game.players[client.playerId];
    if (!me || me.alive) return;
    const cam = this.deathCam;
    const target = this.game.players[id];
    if (cam === 0 || !target || id === client.playerId) return;
    if (cam === 1 && id !== client.killer) return;
    client.follow = id;
    this.spectateDirty = true;
  }

  /** Free player slots now. */
  private get freeSlots(): number {
    return Math.max(0, this.maxHumans - this.humanCount);
  }

  /** Spectators who asked to play take the free slots: "now" at once, "next" once the match is between rounds. */
  private seatPlayers(): void {
    if (this.freeSlots === 0) return;
    const phase = this.match?.phase;
    const betweenRounds = !this.match || (phase !== MatchPhase.Countdown && phase !== MatchPhase.InProgress);
    // the longest-waiting first (the lowest seat came in first among equals)
    const waiting = [...this.clients].filter((c) => c.spectator && (c.queue === SpectateQueue.Now || (c.queue === SpectateQueue.Next && betweenRounds))).sort((a, b) => a.seat - b.seat);
    for (const c of waiting) {
      if (this.freeSlots === 0) break;
      const name = c.name;
      const look = c.look;
      this.unseat(c);
      // a fresh join on the same connection: live snapshots from now, a player's ring
      c.baselines = new SnapshotBaselines();
      c.lastSnapshotTick = -1;
      c.snapshotEvery = c.lowBwSince >= 0 ? this.snapshotEvery * 2 : this.snapshotEvery;
      this.addHuman(c, name, look);
      if (this.match) c.conn.send(this.encodeMatchState());
      this.log(`[room] ${name} stopped watching and plays`);
    }
  }

  /** The death cam: who just died (their killer first) and who came back. */
  private trackDeaths(): void {
    for (const e of this.game.events) {
      if (e.type !== 'death') continue;
      for (const c of this.clients) {
        if (c.playerId !== e.victim || c.protocolVersion < 20) continue;
        c.killer = e.killer !== e.victim ? e.killer : -1;
        c.follow = this.deathCam > 0 && c.killer >= 0 && this.game.players[c.killer] ? c.killer : -1;
        this.spectateDirty = true;
      }
    }
    for (const c of this.clients) {
      if (c.follow < 0 || c.spectator) continue;
      const me = this.game.players[c.playerId];
      // back in play (or gone): the death cam ends; a followed player who left leaves it on our body
      if (!me || me.alive || !this.game.players[c.follow]) c.follow = -1;
    }
  }

  /** SPECTATE to every v20 client whose view of it changed (the room's spectators, its mode, follow, queue). */
  private sendSpectateStates(): void {
    const list = [...this.clients]
      .filter((c) => c.spectator)
      .sort((a, b) => a.seat - b.seat)
      .map((c) => ({ voiceId: c.voiceId, name: c.name }));
    const slots = this.freeSlots;
    for (const c of this.clients) {
      if (!c.inRoom || c.protocolVersion < 20) continue;
      const me = c.joined ? this.game.players[c.playerId] : null;
      const mode: SpectateModeId = c.spectator ? SpectateMode.Spectator : me && !me.alive ? SpectateMode.Dead : SpectateMode.Playing;
      const msg = { mode, follow: c.spectator ? -1 : c.follow, queue: c.spectator ? c.queue : SpectateQueue.Watching, delayTicks: c.spectator ? c.delayTicks : 0, slots, spectators: list };
      const key = JSON.stringify(msg);
      if (key === c.spectateSent) continue;
      c.spectateSent = key;
      c.conn.send(encodeSpectate(msg));
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
      this.prepareBotGraph();
      // every client predicts with the room's tuning: keep them in step. The sender too when the
      // room took something else than it asked for (a host's value clamped to the limits): its
      // prediction and its open Tune panel must show what the room really runs
      const bytes = encodeTuning(JSON.stringify(this.game.tuning));
      const t = this.game.tuning as unknown as Record<string, number>;
      const asked = Object.keys(parsed).some((k) => k in t && parsed[k] !== t[k]);
      for (const c of this.clients) if (c.inRoom && (c !== client || asked)) c.conn.send(bytes);
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
        if (!isHost) break;
        // the bots: in any phase, live (the next tick's fill adds or removes them)
        const bots = parseBotSettings(payload, this.hostFill ?? { target: this.fill?.target ?? 0, level: this.fill?.level ?? 'normal' });
        if (bots === null) break;
        if (bots) {
          this.hostFill = bots;
          this.prepareBotGraph();
          this.log(`[room] host sets bots: ${bots.target > 0 ? `fill to ${bots.target} (${bots.level})` : 'off'}`);
        }
        if (m.phase !== MatchPhase.Waiting) break;
        // v21: the mode (free-for-all or 2–4 teams); the kill limit follows it unless this CMD names one
        const teams = parseTeamsSetting(payload);
        if (teams !== undefined && teams !== m.teams && m.setTeams(teams)) {
          const limit = teams > 0 ? adminValue(adminValues(), `teams.killLimit${teams}`) : (this.baseLimits?.killLimit ?? m.rules.killLimit);
          if (!/"killLimit"/.test(payload)) m.rules.killLimit = Math.min(255, limit);
          this.log(`[room] host sets the mode: ${teams > 0 ? `${teams} teams` : 'free-for-all'}`);
        }
        const next = parseMatchSettings(payload, m.rules, this.game.map.id);
        if (!next) break;
        m.rules.timeLimit = next.timeLimit;
        m.rules.killLimit = next.killLimit;
        this.baseLimits = { timeLimit: next.timeLimit, killLimit: next.killLimit };
        if (next.mapId !== this.game.map.id) {
          // the bots know the old map (its nav graph and mechanics): they go, and the fill brings
          // them back on the new map's graph (built between ticks if it isn't ready)
          for (const bot of this.bots.splice(0)) removeBot(this.game, bot);
          this.matchDirty = true;
          this.game.changeMap(next.mapId, this.armory);
          this.prepareBotGraph();
          this.lagComp?.reset();
          this.lagComp?.record(this.game.tick, this.game.players);
          this.pendingEvents.length = 0;
          this.previousEvents.length = 0;
          for (const c of this.clients) {
            if (c.spectator) {
              // a spectator's feed starts again on the new map (what it held back was the old one's)
              c.baselines.reset();
              c.lastSnapshotTick = -1;
              c.delayed.length = 0;
              this.welcomeSpectator(c);
              c.conn.send(encodeRoster(this.rosterEntries()));
              continue;
            }
            if (!c.joined || !c.session) continue;
            c.baselines.reset();
            c.lastSnapshotTick = -1;
            c.conn.send(encodeWelcome({
              playerId: c.playerId,
              seed: this.game.seed,
              serverTick: this.game.tick,
              mapId: next.mapId,
              tuningJson: JSON.stringify(this.game.tuning),
              sessionToken: c.session.token,
              resumed: false,
              overridesJson: adminJson(),
            }));
            c.conn.send(encodeRoster(this.rosterEntries()));
          }
          this.log(`[room] host switched map to ${next.mapId}`);
        }
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
      rules: { ...m.rules, bots: this.botFill?.target ?? 0, botLevel: (this.hostFill ?? this.fill)?.level ?? 'normal' },
      mapId: this.game.map.id,
      hostId: this.hostId,
      lobby: m.players.flatMap((p) => (p ? [{ id: p.id, ready: p.ready, rematch: p.rematch, pingMs: pings.get(p.id) ?? -1, team: p.state.team }] : [])),
      standings: (ended && r ? r.standings : m.standings()).map(standingWire),
      results: r ? { number: r.number, reason: r.reason, durationTicks: r.durationTicks, winnerKey: r.winnerKey, mvpKey: r.mvpKey } : null,
      // v21 team modes: the mode, the team scores (the final ones once ended), the winner
      teams: m.teams,
      teamScores: ended && r ? r.teamScores : m.teamScores,
      winnerTeam: r ? r.winnerTeam : -1,
    });
  }

  private sendMatchState(): void {
    this.matchDirty = this.matchUrgent = false;
    this.matchSentAt = this.game.tick;
    const bytes = this.encodeMatchState();
    for (const c of this.clients) {
      if (c.joined) c.conn.send(bytes);
      // spectators: with the snapshots it describes (the scoreboard mustn't run ahead of the feed)
      else if (c.spectator) this.sendDelayed(c, bytes, false);
    }
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
    this.offAdmin();
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
  /** v19: each player's look as the room lets them wear it (cosmetic wire ids); absent = none known */
  private readonly looks = new WeakMap<PlayerState, number[]>();
  /** a look changed: the ROSTER goes out again (look changes: at most one ROSTER every LOOK_ROSTER_TICKS) */
  private lookRosterDirty = false;
  private lookRosterAt = -Infinity;

  /** v19: a session's player puts on a look (held to what it may wear); everyone hears of it in the ROSTER */
  private wear(s: Session, ids: readonly number[]): void {
    const p = this.game.players[s.playerId];
    const worn = p ? admitLook(ids, s.vouch) : null;
    if (!p || !worn) return;
    const next = cosmeticLoadoutWireIds(worn);
    const now = this.looks.get(p);
    if (now && now.length === next.length && now.every((id, i) => id === next[i])) return;
    this.looks.set(p, next);
    this.lookRosterDirty = true;
  }

  /** A player's look (v19 ROSTER), for the room's own uses (tests, results); null = none known. */
  lookOf(playerId: number): readonly number[] | null {
    const p = this.game.players[playerId];
    return (p && this.looks.get(p)) ?? null;
  }

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
        return { id: p.id, name: p.name, isBot: p.isBot, since, look: this.looks.get(p) ?? null };
      });
  }

  private broadcastRoster(): void {
    const bytes = encodeRoster(this.rosterEntries());
    for (const c of this.clients) if (c.inRoom) c.conn.send(bytes);
    this.spectateDirty = true; // the free slots
    // a ROSTER carries every look: a look change waiting for its own goes with this one
    this.lookRosterDirty = false;
  }

  /**
   * Bots keep the room at fillBots.target players while a human is in it (those waiting to
   * reconnect included): one goes when a human comes in, the lowest scorer (a joiner takes a bot's
   * place, not its stats; a leaver keeps its standing), one comes in when a human leaves for good,
   * and they all go with the last human. Before the tick's step, as a replay puts them back
   * (packages/bots botReplaySetup).
   */
  /** The bots this room keeps now: the host's choice, else the admin page's or RoomOptions'; null = none. */
  get botFill(): { target: number; level: BotLevelId } | null {
    if (this.hostFill === undefined) return this.fill;
    return this.hostFill.target > 0 ? this.hostFill : null;
  }

  private fillWithBots(): void {
    const fill = this.botFill;
    // no bots wanted (the admin page turned them off too): the ones in go
    if (!fill && this.bots.length === 0) return;
    const humans = this.humanCount;
    const want = fill && humans > 0 ? Math.max(0, fill.target - humans) : 0;
    let changed = false;
    while (this.bots.length > want) {
      removeBot(this.game, this.botToDrop());
      changed = true;
    }
    while (fill && this.bots.length < want && this.game.players.some((p) => !p)) {
      const graph = this.botGraph();
      if (!graph) break; // being built between ticks: the bot comes in when it's ready
      const bot = addBot(this.game, { level: fill.level, graph });
      // v19: a seeded look of its own (both bodies, earnable items), the same for this bot all room long
      this.looks.set(bot, cosmeticLoadoutWireIds(botLook(lookSeed(this.game.seed, bot.name))));
      this.bots.push(bot);
      changed = true;
    }
    if (!changed) return;
    this.broadcastRoster();
    this.matchDirty = true;
  }

  /**
   * A new bot's nav graph: the one for the room's map and tuning if it's built, else the map's
   * newest meanwhile (null: none yet). Never built here, on the tick: one build (90–330 ms) froze
   * every room on the server. The build is queued for the time between ticks (bots/nav/cache.ts,
   * the tick loop's idle work); bots already in keep the graph they came with.
   */
  private botGraph(): NavGraph | null {
    return requestNavGraph(this.game.map, this.game.world, this.game.tuning) ?? latestNavGraph(this.game.map);
  }

  /** A new map or tuning: its bots' graph starts building now (between ticks), ready for the next bot. */
  private prepareBotGraph(): void {
    if (this.botFill) requestNavGraph(this.game.map, this.game.world, this.game.tuning);
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
      const me = this.game.players[c.playerId];
      let applied = current;
      // the main input lands in its own object: lastInput is the newest taken (the repeat's base)
      const main = c.mainInput;
      let took = c.inputs.takeNext(current, main);
      const hold = !took && !!me?.alive && !c.holdSpent && (!this.match || this.match.live) && c.inputs.stalled && current - c.inputs.next < HOLD_TICKS;
      if (!took && !hold) {
        // waiting no longer (lost on the way, the hold ran out, or the player can't be held): the
        // missing ticks get stand-ins (the last input, no keys after MAX_REPEAT_TICKS: docs/05 §13)
        // and run now, in order; the real ones count as late
        if (c.inputs.stalled) c.holdSpent = true;
        c.inputs.fillMissing(current + 1, c.lastInput);
        took = c.inputs.takeNext(current, main);
      }
      if (took) {
        // the next input in its own order: this tick's, or (after a hold) an older one
        c.holdSpent = false;
        applied = c.inputs.next - 1;
        this.inputs[c.playerId] = c.inputs.forSim(applied, main);
        copyInput(c.lastInput, main);
        const mainView = c.inputs.renderTickFor(applied);
        // behind after a hold: catch up through the inputs that have come, a few a tick; stand-ins
        // (a hold given up) all at once, as the old way ran those ticks in real time (spread out,
        // they cost the player more corrections on MTN: 162/min against 125)
        const extra = (this.game.catchUp[c.playerId] ??= []);
        extra.length = 0;
        let real = 0;
        while (c.inputs.next <= current && c.inputs.has(c.inputs.next) && (c.inputs.standIn(c.inputs.next) || real++ < CATCH_UP_PER_TICK)) {
          const input = c.catchUp[extra.length]!;
          c.inputs.takeNext(current, input);
          c.catchUpViews[extra.length] = c.inputs.renderTickFor(c.inputs.next - 1);
          extra.push(c.inputs.forSim(c.inputs.next - 1, input) as Input);
          copyInput(c.lastInput, input);
        }
        c.mainView = mainView;
      } else if (hold) {
        // not here yet, and nothing newer either (the client's inputs are held up on the way, not
        // lost): hold the player (it doesn't move, shoot or regenerate this tick) until they come
        me!.held = true;
        this.inputs[c.playerId] = undefined;
        applied = c.inputs.next - 1;
      }
      // the rewind cap allows for this client's view delay: interpolation (+ input batching when
      // slim, once it has been slim for LOW_BW_WARMUP_TICKS)
      const lowBandwidth = c.lowBwSince >= 0 && current - c.lowBwSince >= LOW_BW_WARMUP_TICKS;
      const viewDelayMs = lowBandwidth ? Math.max(LOW_BANDWIDTH_INTERP_DELAY_MS, MAX_VIEW_DELAY_MS) + TICK_MS : MAX_VIEW_DELAY_MS;
      c.viewEvery = lowBandwidth ? c.snapshotEvery : this.snapshotEvery;
      c.viewDelayMs = viewDelayMs;
      lagComp?.setView(c.playerId, c.inputs.renderTickFor(applied), c.viewEvery, viewDelayMs);
    }
    this.checkHost();
    // players waiting for a reconnect stand idle; give up on them after the grace
    for (const s of this.sessions.values()) {
      if (s.client) continue;
      if (current >= s.expiresAt) {
        this.log(`[room ${this.code}] ${this.game.players[s.playerId]?.name ?? '?'} didn't come back in time; its place is given up`);
        this.endSession(s);
      }
      else this.inputs[s.playerId] = s.idle;
    }
    this.seatPlayers();
    this.fillWithBots();
    if (this.match) {
      this.match.step(this.inputs);
      this.recorder?.onMatchEvents(this.match, this.game.map.id);
      for (const e of this.match.events) {
        this.matchDirty = true;
        if (e.type === 'phase') {
          this.matchUrgent = true;
          this.applyPendingLimits();
        }
      }
    } else this.game.step(this.inputs);
    for (const p of this.game.players) if (p) p.held = false;
    this.trackDeaths();
    lagComp?.record(this.game.tick, this.game.players);
    if (lagComp && lagComp.log.length > 0) this.sendRewindDebug(lagComp, current);
    for (const e of this.game.events) this.pendingEvents.push(e);

    if (this.game.tick % this.snapshotEvery === 0) {
      // 1..65535: 0 means "nothing acked" in INPUT
      this.snapshotSeq = (this.snapshotSeq % 0xffff) + 1;
      this.snapshots.begin(this.game, this.snapshotSeq, this.pendingEvents);
      for (const c of this.clients) {
        if (!c.inRoom || c.closed || this.game.tick % c.snapshotEvery !== 0) continue;
        // skipped the previous interval (low-bandwidth mode): its events come with this one
        const skipped = c.lastSnapshotTick >= 0 && this.game.tick - c.lastSnapshotTick > this.snapshotEvery;
        if (c.spectator) {
          // v20: no player, the whole map (the free camera goes anywhere), held back by its delay
          c.lastSnapshotTick = this.game.tick;
          const bytes = this.snapshots.encodeFor({
            baselines: c.baselines,
            ackInputTick: 0,
            inputBufferHealth: HEALTH_UNKNOWN,
            local: null,
            view: null,
            ...(skipped ? { extraEvents: this.previousEvents } : {}),
          });
          this.sendDelayed(c, bytes, true);
          continue;
        }
        // on TCP a stale snapshot is worse than a missing one (docs/05 §2.2)
        if (c.conn.bufferedAmount() > BACKPRESSURE_LIMIT) {
          c.snapshotsSkipped++;
          continue;
        }
        const health = c.healthMin === Infinity ? HEALTH_UNKNOWN : Math.max(-127, Math.min(127, c.healthMin));
        c.healthMin = Infinity;
        const me = this.game.players[c.playerId] ?? null;
        // v20: a dead player's death cam sees what the player it follows sees (its view, its eyes)
        const followed = c.follow >= 0 && me && !me.alive ? (this.game.players[c.follow] ?? null) : null;
        const eye = followed ?? me;
        c.lastSnapshotTick = this.game.tick;
        c.conn.send(
          this.snapshots.encodeFor({
            baselines: c.baselines,
            // the input the player's state stands at (behind this tick while held: the catch-up)
            ackInputTick: (c.inputs.next >= 0 ? c.inputs.next - 1 : current) & 0xffff,
            inputBufferHealth: health,
            local: me,
            view: this.aoi && eye ? aoiRect(eye, this.game.map, c.view) : null,
            ...(followed ? { eyes: followed.id } : {}),
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
    this.flushDelayed();
    if (this.spectateDirty || this.game.tick % 10 === 0) {
      this.spectateDirty = false;
      this.sendSpectateStates();
    }
    this.voice.tick();
    if (this.lookRosterDirty && this.game.tick - this.lookRosterAt >= LOOK_ROSTER_TICKS) {
      this.lookRosterAt = this.game.tick;
      this.broadcastRoster();
    }
  }
}
