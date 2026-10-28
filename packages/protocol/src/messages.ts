/**
 * Wire messages (docs/05 §5–6) except snapshots, which live in snapshot.ts (delta-compressed,
 * per client). The input format matches the final design (redundant inputs, acks, render tick).
 */
import {
  CROUCHED_HITBOXES,
  EVENT_KINDS,
  MAX_LOOK_IDS,
  RIOT_SHIELD,
  SPAWN_POOLS,
  STANDING_HITBOXES,
  ZONE_KINDS,
  defaultTuning,
  grenades,
  maps,
  pickups,
  weapons,
} from '@military-forge/content';
import { POS_INV } from '@military-forge/shared';
import { createInput, type Input } from '@military-forge/sim';
import { BitReader, BitWriter, DecodeError } from './bitstream';
import { decodeMatchStateBody, type MatchStateMsg } from './matchState';
import { decodeFullSnapshot, type SnapshotMsg } from './snapshot';
import { MsgType, NO_PLAYER, pid, pos, unPid } from './wire';

export { MsgType } from './wire';

/**
 * v2: tick-aligned inputs, input buffer health and the local-player block in snapshots.
 * v3: delta snapshots against the acked baseline, AOI culling, SOUND events, regrouped local block.
 * v4: session tokens: WELCOME carries one, HELLO may present it to resume after a disconnect.
 * v5: INPUT carries each input's render-tick lag (lag compensation for batched inputs).
 * v6: the local-player block ends with a melee group: meleeTicks (arsenal: melee lunge + swing timer).
 * v7: INPUT's render lag is u8 (to 15.9 ticks: redundant copies at low frame rates) and inputs[0] has none;
 *     ROSTER entries carry `since`, the first server tick whose snapshots show that player (ids are reused).
 * v8 (mechanics + dash): event tag 6 MAP_EVENT · tag 7 = extended escape (u4 kind): 0 DASH · INPUT bit 13 Dash ·
 *     remote flag 128 DASHING (flags 8 bits) · local block 41–44 (dash group).
 *     Map events announce a map event's warning, start and end (docs/02 §20.7); map rules, zones and the schedule add
 *     nothing else (they come from the map and the seed). The dash group holds dashTicks, dashDir, dashCooldown and
 *     airDashUsed (docs/02 §21; v14 reworks it). Extended events carry no length, so each new ext kind is a version bump too.
 * v9 (riot shield + pickups): ext kinds 1 RICOCHET · 2 SHIELD_BREAK · 3 PICKUP · INPUT bit 14 Shield ·
 *     remote flags 256/512 = a 2-bit shield state (0 none, 1 slung, 2 raising, 3 up; flags 10 bits) ·
 *     local block 45–47 (shield group: shieldHp, shieldStowed, shieldTicks) · a pickups section after the grenades
 *     (items in view, only when changed) · a shot's `hit` may be 3 (a shield; docs/03 §9).
 * v10 (arsenal-b, grenade variety): local block 48–57, two groups after the shield group: the grenade belt (u3
 *     selected type · u3 count × 5 other types) and status (u8 blindTicks · u7 blindFade · u6 gasTicks · u8
 *     jetDisabledTicks) · grenade records + u3 type · u2 mine state · a clouds section after the pickups section
 *     (u5 n · u5 id · u3 type · x · y · u10 age) · EXPLOSION + u3 grenade type. No new event tags, ext kinds,
 *     remote flags or INPUT bits.
 * No bump (rooms by code, ui-playtest): MATCH_STATE 0x23, CMD kinds 4–10, close codes 4006 NoRoom and 4007
 *     TicketInvalid, and HELLO's optional trailing join ticket (old HELLOs decode with ticket '').
 * v11 (arsenal, the owner's "more guns"): local block 58–61, one group after the status group (spin0 u8 ·
 *     burst0 u2 · spin1 u8 · burst1 u2: a minigun's spin-up and a burst rifle's rounds left) · the pickups
 *     section's id and def u6 (48 items; weapon items are defs 7+) · the PICKUP ext event's item u6. Weapon
 *     pickups use Btn.Interact (bit 10, already there); the test armory is a server option, not on the wire.
 * v12 (arsenal, launchers and the flamethrower): projectiles ride the grenade records, whose type
 *     widens u3 → u4 (8–12: rocket, shell, blade, orb, flame) and fuse u8 → u9; EXPLOSION's grenade
 *     type u3 → u4; local block 62 burnTicks u7 (14 delta groups); remote flags 12 bits (1024 burning,
 *     2048 winding up: a minigun spinning or a charge weapon charging).
 * v13 (arsenal, the owner's admin page): OVERRIDES (0x28, a u16-length JSON of the admin's changed
 *     gameplay values) and WELCOME's trailing overridesJson (u16-length; `{}` when none), so every
 *     client's weapons and grenades match the server's. The admin page itself talks HTTP.
 * v14 (arsenal, the owner's fluid dash): INPUT + u3 dashStrength per input (0..7, 7 = full) · the
 *     dash group's 43 is dashGap u6 (was dashCooldown u8) and 44 dashChain u3 (was airDashUsed u1) ·
 *     local block 63–64, one group after the burn group (dashChainTicks u7 · dashPower u3; 15 delta
 *     groups) · the DASH ext event + u3 chain. No new tags, ext kinds, flags, INPUT bits or messages.
 * v16 (arsenal, remote melee swings): remote flags 13 bits (4096 = swinging); when set, the state group
 *     carries a trailing u6 meleeTicks (a remote swing that misses shows too). Nothing else changes.
 * v17 (ui-playtest, the host's bots): MATCH_STATE's rules gain bots u5 (fill target, 0 = none) and
 *     botLevel u2 (easy, normal, hard) after onNoRematch; the MatchSettings CMD's JSON takes bots and
 *     botLevel in any phase. (Claimed as v15; renumbered after v16 landed first.)
 * v18 (social, voice chat): VOICE_UP 0x29 (C→S, unreliable) · VOICE_DOWN 0x2A (S→C, unreliable) ·
 *     VOICE_STATE 0x2B (S→C) · CMD kind 11 Voice (JSON) (voice.ts). Nothing else changes, so a v17
 *     client still joins (MIN_PROTOCOL_VERSION) and simply never gets voice.
 * v19 (match presentation, looks on the wire): a look is u5 count + count × u16 cosmetic wire ids
 *     (content's cosmeticLoadoutWireIds order; 0 = none known). ROSTER gains a trailing looks section
 *     (u8 n, then one look per entry) that v17/v18 decoders never read, HELLO a trailing optional look
 *     after the ticket (the ticket is then always written), and CMD kind 12 SetLook (JSON array of the
 *     ids). The join ticket gains `look` and `lvl` (API → game server, not the wire). Nothing else changes,
 *     so v17 and v18 clients still join (MIN_PROTOCOL_VERSION); they never send a look.
 * v20 (spectating): HELLO + u8 flags after the look (bit 0: join as a spectator) · WELCOME + u8 flags
 *     (bit 0: a spectator, no player) and, for a spectator, u10 delayTicks · SPECTATE_ACK 0x2C (C→S,
 *     unreliable: u16 seq, a spectator's ack) · SPECTATE 0x2D (S→C: mode, follow, queue, delay, free
 *     slots, the room's spectators) · CMD kind 13 Spectate (JSON { follow?, play? }) · close code 4008
 *     SpectatorsFull. Spectators' voice ids are 32 + seat. Nothing else changes, so v17–v19 clients
 *     still join; they never spectate.
 * v21 (match presentation, team modes): MATCH_STATE gains a trailing teams section (u8 teams: 0 free-
 *     for-all, 2–4; then s12 × teams team scores, u3 per lobby entry and per standing, u3 winner team;
 *     7 = none) that v17–v20 decoders never read; the MatchSettings CMD's JSON takes `teams` (lobby
 *     only); CMD kind 14 SetTeam (host, lobby: JSON { id, team }); TUNING gains `friendlyFire`. No
 *     snapshot, INPUT, ROSTER or HELLO change. (v20 is spectating's.)
 */
export const PROTOCOL_VERSION = 21;
/**
 * The oldest client a server still admits. v18–v21 only added messages and trailing fields an
 * older client never reads or sends, so v17 pages still play (without voice, looks, spectating or teams).
 */
export const MIN_PROTOCOL_VERSION = 17;

/** A client's protocol version this server can serve. */
export function protocolSupported(version: number): boolean {
  return version >= MIN_PROTOCOL_VERSION && version <= PROTOCOL_VERSION;
}

/**
 * Everything the sim reads from packages/content: a client and server that disagree on any of it
 * would mispredict (or hit differently), so mismatched builds are refused at HELLO. New content
 * the sim reads (more grenades, cosmetics that change hitboxes, …) belongs in here.
 */
export const HASHED_CONTENT = {
  tuning: defaultTuning,
  weapons,
  grenades,
  hitboxes: { standing: STANDING_HITBOXES, crouched: CROUCHED_HITBOXES },
  maps,
  /** the effects a map zone or event gets from its kind when it leaves them out (docs/02 §20) */
  zoneDefaults: Object.fromEntries(Object.entries(ZONE_KINDS).map(([kind, info]) => [kind, info.defaults])),
  eventDefaults: Object.fromEntries(Object.entries(EVENT_KINDS).map(([kind, info]) => [kind, info.defaults])),
  /** the items, spawner pools and the riot shield (docs/03 §9, §12) */
  pickups: { items: pickups, pools: SPAWN_POOLS, shield: RIOT_SHIELD },
} as const;

/**
 * FNV-1a over a canonical JSON form (object keys sorted, undefined fields skipped): equal content,
 * equal hash. Throws on anything JSON can't carry faithfully (NaN, ±Infinity, Map/Set/class
 * instances, functions), so such content fails at load and in CI instead of hashing as null or {}.
 * -0 hashes as 0.
 */
export function contentHashOf(value: unknown): number {
  const text = canonicalJson(value, '$');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function canonicalJson(v: unknown, path: string): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`content hash: ${path} is ${v}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x, i) => canonicalJson(x, `${path}[${i}]`)).join(',')}]`;
  if (typeof v === 'object') {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`content hash: ${path} is not plain data`);
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k], `${path}.${k}`)}`).join(',')}}`;
  }
  throw new Error(`content hash: ${path} is ${typeof v}`);
}

export const CONTENT_HASH = contentHashOf(HASHED_CONTENT);


export const CloseCode = {
  VersionMismatch: 4001,
  RoomFull: 4002,
  BadMessage: 4003,
  RateLimited: 4004,
  /** the same session was resumed from another connection */
  DuplicateSession: 4005,
  /** no room for this connection: a malformed room code, or the server can't open another room */
  NoRoom: 4006,
  /** a room by code needs a valid join ticket from the API (docs/06 §6): missing, forged, expired, used or for another room */
  TicketInvalid: 4007,
  /** v20: a spectator for a room that already has all the spectators it takes (the admin's spectate.cap) */
  SpectatorsFull: 4008,
  /**
   * The game server is restarting for an update (the standard WebSocket "service restart"): rejoin the
   * room with a fresh ticket once it's back (docs/net-trial.md §5). Clients before it reconnected and
   * met "ticket expired" (23 Oct 2026).
   */
  ServerUpdating: 1012,
} as const;

export const CmdKind = {
  /** dev only: replace the room's tuning (JSON payload) */
  SetTuning: 1,
  /** dev only: respawn yourself */
  Respawn: 2,
  /** payload '1'/'0': low-bandwidth mode (15 Hz snapshots for this client; docs/05 §2.2) */
  SetLowBandwidth: 3,
  // ---- match rooms (MATCH_STATE 0x23): allowed in every room that runs a match ----
  /** lobby: payload '1' ready / '0' not ready */
  Ready: 4,
  /** host, lobby: start the countdown without waiting for everyone to be ready */
  StartMatch: 5,
  /** results screen: vote for a rematch */
  Rematch: 6,
  /** host: everyone back to the lobby (abandons a running match) */
  ReturnToLobby: 7,
  /**
   * host: JSON `{ timeLimit?, killLimit?, mapId?, bots?, botLevel? }`. The limits and the map in the
   * lobby only (ROOM_SETTING_LIMITS; 0 = off); the bots (ROOM_BOT_CHOICES, 'easy' | 'normal' | 'hard')
   * in any phase, live (v17)
   */
  MatchSettings: 8,
  /** the client's round-trip time in whole ms, for everyone's scoreboard (every few seconds) */
  ReportPing: 9,
  /** leaving for good: the player goes now instead of waiting out the reconnect grace */
  Leave: 10,
  /** v18: voice chat settings (JSON VoiceSettingsCmd, voice.ts), the whole state each time */
  Voice: 11,
  /** v19: wear this look (a JSON array of cosmetic wire ids, encodeLookCmd); the room re-sends the ROSTER */
  SetLook: 12,
  /** v20: spectating (JSON SpectateCmd): whom a dead player's death cam follows, a spectator's wish to play */
  Spectate: 13,
  /** v21: host, lobby only: JSON `{ id, team }` moves that player to that team (team modes) */
  SetTeam: 14,
} as const;

/** v20: HELLO's flags (after the look). */
export const HelloFlag = {
  /** join as a spectator: no player slot, never sends INPUT */
  Spectate: 1,
} as const;

/** v20: WELCOME's flags (after overridesJson). */
export const WelcomeFlag = {
  /** this connection is a spectator: it has no player (playerId is NO_PLAYER) */
  Spectator: 1,
} as const;

/** v20: a client's spectating mode (SPECTATE). */
export const SpectateMode = {
  /** playing, alive (nothing to watch) */
  Playing: 0,
  /** dead: the death cam until the respawn */
  Dead: 1,
  /** a spectator: no player, the room's whole map, behind live by the delay */
  Spectator: 2,
} as const;
export type SpectateModeId = (typeof SpectateMode)[keyof typeof SpectateMode];

/** v20: a spectator's place in the queue for a player slot (SPECTATE). */
export const SpectateQueue = {
  /** watching, not asking to play */
  Watching: 0,
  /** plays the moment a slot is free (mid-match too) */
  Now: 1,
  /** plays at the next round: once the match isn't counting down or running, and a slot is free */
  Next: 2,
} as const;
export type SpectateQueueId = (typeof SpectateQueue)[keyof typeof SpectateQueue];

/** v20: spectators per room at most (the admin's spectate.cap goes up to this; SPECTATE's list is u4) */
export const MAX_SPECTATORS = 8;
/** v20: a spectator's voice id is this plus its seat (VOICE_DOWN / VOICE_STATE ids are u8) */
export const SPECTATOR_VOICE_BASE = 32;

/** v21: a SetTeam CMD's payload → `{ id, team }`; null when malformed. */
export function parseSetTeam(payload: string): { id: number; team: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { id, team } = raw as Record<string, unknown>;
  return Number.isInteger(id) && Number.isInteger(team) && (id as number) >= 0 && (id as number) < 32 && (team as number) >= 0 && (team as number) < 4 ? { id: id as number, team: team as number } : null;
}


export const MAX_INPUTS_PER_PACKET = 4;

/** `inputBufferHealth` value meaning "no input from this client yet". */
export const HEALTH_UNKNOWN = -128;

/**
 * Messages that may be lost, duplicated or reordered (docs/05 §2): the network conditioner only
 * drops these. Everything else is reliable and ordered.
 */
export function isUnreliableMessage(bytes: Uint8Array): boolean {
  const type = bytes[0];
  return (
    type === MsgType.Input ||
    type === MsgType.Ping ||
    type === MsgType.Pong ||
    type === MsgType.Snapshot ||
    type === MsgType.Debug ||
    type === MsgType.VoiceUp ||
    type === MsgType.VoiceDown ||
    type === MsgType.SpectateAck
  );
}

export const DebugKind = {
  /** a lag-compensated shot: the poses the server tested (docs/05 §15.3) */
  Rewind: 1,
} as const;

// ---------- message shapes ----------

export interface HelloMsg {
  type: typeof MsgType.Hello;
  protocolVersion: number;
  contentHash: number;
  name: string;
  /** WELCOME.sessionToken from an earlier connection: resume that player ('' = new) */
  resumeToken: string;
  /**
   * The API's join ticket for the room (docs/06 §6: a signed JWT, ~30 s): a new player in a room by
   * code needs one when the server checks tickets. '' = none (dev rooms, resumes).
   */
  ticket: string;
  /** v19: the look the player wants to wear (cosmetic wire ids); null = none sent (older clients) */
  look: number[] | null;
  /** v20: join as a spectator (HelloFlag.Spectate); false for older clients */
  spectate: boolean;
}

export interface WelcomeMsg {
  type: typeof MsgType.Welcome;
  playerId: number;
  seed: number;
  serverTick: number;
  mapId: string;
  tuningJson: string;
  /** present it in HELLO to get this player back after a disconnect (docs/05 §13) */
  sessionToken: string;
  /** this connection took over an existing player (reconnect) */
  resumed: boolean;
  /**
   * v13: the admin page's changed values on this server (JSON `{ key: number }`, content
   * `applyContentOverrides`), `{}` when nothing is changed: a late joiner or a reconnect predicts
   * with the same weapons and grenades as everyone else
   */
  overridesJson: string;
  /** v20: this connection is a spectator (WelcomeFlag.Spectator): no player, `playerId` is meaningless */
  spectator: boolean;
  /** v20: how far behind live a spectator's feed runs, ticks (0 otherwise) */
  delayTicks: number;
}

/** v20: a spectator's snapshot ack (C→S): it never sends INPUT, where players ack. */
export interface SpectateAckMsg {
  type: typeof MsgType.SpectateAck;
  seq: number;
}

/** v20: one of the room's spectators (SPECTATE): its voice id (32 + seat) and name. */
export interface SpectatorEntry {
  voiceId: number;
  name: string;
}

/** v20: spectating, as it stands for this client (S→C, reliable; on join and on every change). */
export interface SpectateMsg {
  type: typeof MsgType.Spectate;
  mode: SpectateModeId;
  /** whom the server centres a dead player's area of interest on; −1 = none */
  follow: number;
  queue: SpectateQueueId;
  /** how far behind live the feed runs, ticks (a spectator's; 0 for the dead) */
  delayTicks: number;
  /** player slots free now (a spectator's "Jump in now") */
  slots: number;
  /** the room's spectators */
  spectators: SpectatorEntry[];
}

/** v20: the Spectate CMD (JSON): whom the death cam follows; a spectator's wish to play. */
export interface SpectateCmd {
  follow?: number;
  play?: 'now' | 'next' | false;
}

export interface PingMsg {
  type: typeof MsgType.Ping;
  clientTime: number;
}

export interface PongMsg {
  type: typeof MsgType.Pong;
  clientTime: number;
  serverTick: number;
}

export interface InputMsg {
  type: typeof MsgType.Input;
  /**
   * Server tick that inputs[0] is for (the client runs ahead of the server, docs/05 §4);
   * inputs[i] belongs to newestTick − i. 16-bit wrapping.
   */
  newestTick: number;
  ackSnapshotSeq: number;
  /** the server tick remote players were drawn at when inputs[0] was sampled (lag compensation) */
  renderTick: number;
  renderFrac: number;
  /** newest first, 1..4 */
  inputs: Input[];
  /**
   * per input: how many ticks earlier than renderTick the frame that sampled it was drawn
   * (1/16 tick resolution, 0–15.94; [0] is 0 by definition and not sent). Encoding defaults to i
   * (one tick per input).
   */
  renderLags?: number[];
}

/** Render lags travel as u8 in 1/16 tick, for inputs[1..] (inputs[0]'s is 0). */
const RENDER_LAG_STEPS = 16;
const RENDER_LAG_BITS = 8;
const MAX_RENDER_LAG = (1 << RENDER_LAG_BITS) - 1;

export interface CmdMsg {
  type: typeof MsgType.Cmd;
  kind: number;
  payload: string;
}

export interface RosterEntry {
  id: number;
  name: string;
  isBot: boolean;
  /**
   * The first server tick whose snapshots show this player. Ids are reused: snapshots older than
   * this show whoever had the id before (clients don't draw them as this player).
   */
  since: number;
  /**
   * v19: the look the room lets this player wear (cosmetic wire ids, content's
   * cosmeticLoadoutWireIds order; decode with cosmeticLoadoutFromWireIds). null / absent: none known
   * (a v17/v18 client, or a ROSTER from before v19): draw a placeholder.
   */
  look?: readonly number[] | null;
}

export interface RosterMsg {
  type: typeof MsgType.Roster;
  entries: RosterEntry[];
}

export interface KickMsg {
  type: typeof MsgType.Kick;
  code: number;
  reason: string;
}

export interface TuningMsg {
  type: typeof MsgType.Tuning;
  tuningJson: string;
}

/** v13: the admin page changed gameplay numbers (JSON `{ key: number }`, the whole set, not a diff). */
export interface OverridesMsg {
  type: typeof MsgType.Overrides;
  overridesJson: string;
}

export interface RewindTarget {
  id: number;
  /** the pose the hit test used (what the shooter saw) */
  x: number;
  y: number;
  crouched: boolean;
  /** where the target really was on the server at that moment */
  nowX: number;
  nowY: number;
  /** a shot from this tick hit this target */
  hit: boolean;
}

/** One lag-compensated shot, sent to the shooter (dev rooms only). */
export interface RewindDebugMsg {
  type: typeof MsgType.Debug;
  kind: typeof DebugKind.Rewind;
  /** server tick the shot was simulated on */
  tick: number;
  shooter: number;
  /** how far back the server looked (ticks, ¼-tick resolution), and what the client asked for */
  rewindTicks: number;
  requestedTicks: number;
  /** the request was beyond the rewind cap */
  clamped: boolean;
  targets: RewindTarget[];
}

export type ServerMessage = WelcomeMsg | PongMsg | SnapshotMsg | RosterMsg | KickMsg | TuningMsg | OverridesMsg | RewindDebugMsg | MatchStateMsg | SpectateMsg;
export type ClientMessage = HelloMsg | PingMsg | InputMsg | CmdMsg | SpectateAckMsg;
export type Message = ServerMessage | ClientMessage;

// ---------- encoders ----------

const w = new BitWriter(4096);

/**
 * Trailing fields are optional on decode: the join ticket (u16-length string) is sent when there is one
 * or a look follows it; the look (v19) when there is one or flags follow it (count 0 = none); the
 * flags (v20, HelloFlag) when any is set.
 */
export function encodeHello(name: string, resumeToken = '', ticket = '', look: readonly number[] | null = null, flags = 0): Uint8Array {
  w.reset().u8(MsgType.Hello).u16(PROTOCOL_VERSION).u32(CONTENT_HASH).string(name).string(resumeToken);
  const withLook = look !== null && look.length > 0;
  const withFlags = (flags & 0xff) !== 0;
  if (ticket || withLook || withFlags) w.string(ticket, 16);
  if (withLook || withFlags) writeLook(w, look);
  if (withFlags) w.u8(flags & 0xff);
  return w.finish().slice();
}

/** v19: a look on the wire: u5 count + count × u16 cosmetic wire ids (count 0 = none). The count grows with
 *  content, not with the protocol: 15 ids with `hair`, 16 with the K-47 skin slot (28 Oct, docs/17 §3.7). An
 *  older peer reads every id, keeps the ones it knows by position and draws the rest as their defaults. */
function writeLook(writer: BitWriter, look: readonly number[] | null | undefined): void {
  const n = Math.min(MAX_LOOK_IDS, look?.length ?? 0);
  writer.unsigned(n, 5);
  for (let i = 0; i < n; i++) writer.u16(look![i]! & 0xffff);
}

function readLook(r: BitReader): number[] | null {
  const n = r.bits(5);
  if (n === 0) return null;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(r.u16());
  return ids;
}

/** v19: the SetLook CMD (C→S): the look to wear, as a JSON array of cosmetic wire ids. */
export function encodeLookCmd(look: readonly number[]): Uint8Array {
  return encodeCmd(CmdKind.SetLook, JSON.stringify(look.slice(0, MAX_LOOK_IDS)));
}

/** A SetLook CMD's payload → its wire ids; null when it isn't a list of 1..31 whole numbers in u16 range. */
export function parseLookCmd(payload: string): number[] | null {
  if (payload.length > 512) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LOOK_IDS) return null;
  return raw.every((v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff) ? (raw as number[]) : null;
}

/** Longest spectator delay WELCOME and SPECTATE carry (u10 ticks, ~17 s). */
export const MAX_SPECTATE_DELAY_TICKS = 1023;

/** v20: the flags byte always goes out (a v17–v19 decoder stops before it); a spectator's delay follows it. */
export function encodeWelcome(m: Omit<WelcomeMsg, 'type' | 'spectator' | 'delayTicks'> & Partial<Pick<WelcomeMsg, 'spectator' | 'delayTicks'>>): Uint8Array {
  w.reset()
    .u8(MsgType.Welcome)
    .unsigned(m.spectator ? 31 : m.playerId, 5)
    .u32(m.seed)
    .u32(m.serverTick)
    .string(m.mapId)
    .string(m.tuningJson, 16)
    .string(m.sessionToken)
    .bool(m.resumed)
    .string(m.overridesJson, 16)
    .u8(m.spectator ? WelcomeFlag.Spectator : 0);
  if (m.spectator) w.unsigned(Math.max(0, Math.min(MAX_SPECTATE_DELAY_TICKS, Math.round(m.delayTicks ?? 0))), 10);
  return w.finish().slice();
}

/** v20: a spectator's ack of the newest snapshot it decoded. */
export function encodeSpectateAck(seq: number): Uint8Array {
  return w.reset().u8(MsgType.SpectateAck).u16(seq & 0xffff).finish().slice();
}

/** v20: SPECTATE (see SpectateMsg). */
export function encodeSpectate(m: Omit<SpectateMsg, 'type'>): Uint8Array {
  const n = Math.min(MAX_SPECTATORS, m.spectators.length);
  w.reset()
    .u8(MsgType.Spectate)
    .unsigned(m.mode, 2)
    .unsigned(pid(m.follow), 5)
    .unsigned(m.queue, 2)
    .unsigned(Math.max(0, Math.min(MAX_SPECTATE_DELAY_TICKS, Math.round(m.delayTicks))), 10)
    .unsigned(Math.max(0, Math.min(31, m.slots)), 5)
    .unsigned(n, 4);
  for (let i = 0; i < n; i++) w.u8(m.spectators[i]!.voiceId).string(m.spectators[i]!.name);
  return w.finish().slice();
}

/** v20: the Spectate CMD (C→S). */
export function encodeSpectateCmd(cmd: SpectateCmd): Uint8Array {
  return encodeCmd(CmdKind.Spectate, JSON.stringify(cmd));
}

/**
 * A Spectate CMD's payload, held to its shape: `follow` a player id (0..30), `play` "now", "next" or
 * false; null when it's malformed or names neither.
 */
export function parseSpectateCmd(payload: string): SpectateCmd | null {
  if (payload.length > 128) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: SpectateCmd = {};
  if (o.follow !== undefined) {
    if (!Number.isInteger(o.follow) || (o.follow as number) < 0 || (o.follow as number) >= NO_PLAYER) return null;
    out.follow = o.follow as number;
  }
  if (o.play !== undefined) {
    if (o.play !== 'now' && o.play !== 'next' && o.play !== false) return null;
    out.play = o.play;
  }
  return out.follow === undefined && out.play === undefined ? null : out;
}

export function encodePing(clientTime: number): Uint8Array {
  return w.reset().u8(MsgType.Ping).f64(clientTime).finish().slice();
}

export function encodePong(clientTime: number, serverTick: number): Uint8Array {
  return w.reset().u8(MsgType.Pong).f64(clientTime).u32(serverTick).finish().slice();
}

/**
 * Writes an INPUT into `writer` and returns a view of it (valid until the writer is reused).
 * `count` (default inputs.length) lets callers keep a fixed pool of Input objects.
 */
export function encodeInputInto(writer: BitWriter, m: Omit<InputMsg, 'type'>, count = m.inputs.length): Uint8Array {
  const n = Math.max(1, Math.min(MAX_INPUTS_PER_PACKET, count, m.inputs.length));
  writer.reset().u8(MsgType.Input).u16(m.newestTick).u16(m.ackSnapshotSeq).u16(m.renderTick).u8(m.renderFrac).bits(n - 1, 2);
  for (let i = 0; i < n; i++) {
    const input = m.inputs[i]!;
    writer.u16(input.buttons).u16(input.aim).unsigned(input.weaponSelect, 3).unsigned(input.throwStrength, 3).unsigned(input.dashStrength, 3);
    if (i > 0) writer.unsigned(Math.min(MAX_RENDER_LAG, Math.round((m.renderLags?.[i] ?? i) * RENDER_LAG_STEPS)), RENDER_LAG_BITS);
  }
  return writer.finish();
}

export function encodeInput(m: Omit<InputMsg, 'type'>): Uint8Array {
  return encodeInputInto(w, m).slice();
}

export function encodeCmd(kind: number, payload: string): Uint8Array {
  return w.reset().u8(MsgType.Cmd).u8(kind).string(payload, 16).finish().slice();
}

/**
 * v19: the entries, then a looks section (u8 n, one look per entry in order). A v17/v18 decoder stops
 * after the entries, so every client gets the same ROSTER.
 */
export function encodeRoster(entries: readonly RosterEntry[]): Uint8Array {
  w.reset().u8(MsgType.Roster).unsigned(entries.length, 6);
  for (const e of entries) w.unsigned(e.id, 5).bool(e.isBot).u32(e.since).string(e.name);
  w.u8(entries.length);
  for (const e of entries) writeLook(w, e.look);
  return w.finish().slice();
}

export function encodeKick(code: number, reason: string): Uint8Array {
  return w.reset().u8(MsgType.Kick).u16(code).string(reason).finish().slice();
}

export function encodeTuning(tuningJson: string): Uint8Array {
  return w.reset().u8(MsgType.Tuning).string(tuningJson, 16).finish().slice();
}

/** v13: the admin page's gameplay overrides, the whole set (JSON `{ key: number }`). */
export function encodeOverrides(overridesJson: string): Uint8Array {
  return w.reset().u8(MsgType.Overrides).string(overridesJson, 16).finish().slice();
}

const MAX_REWIND_TARGETS = 31;

export function encodeRewindDebug(m: Omit<RewindDebugMsg, 'type' | 'kind'>): Uint8Array {
  const n = Math.min(MAX_REWIND_TARGETS, m.targets.length);
  w.reset()
    .u8(MsgType.Debug)
    .u8(DebugKind.Rewind)
    .u32(m.tick)
    .unsigned(pid(m.shooter), 5)
    .unsigned(m.rewindTicks * 4, 10)
    .unsigned(m.requestedTicks * 4, 10)
    .bool(m.clamped)
    .unsigned(n, 5);
  for (let i = 0; i < n; i++) {
    const t = m.targets[i]!;
    w.unsigned(pid(t.id), 5)
      .signed(pos(t.x), 24)
      .signed(pos(t.y), 24)
      .bool(t.crouched)
      .signed(pos(t.nowX), 24)
      .signed(pos(t.nowY), 24)
      .bool(t.hit);
  }
  return w.finish().slice();
}

// ---------- decoder ----------

/** Decodes any message. Throws DecodeError for anything malformed. */
export function decodeMessage(bytes: Uint8Array): Message {
  if (bytes.length === 0) throw new DecodeError('empty message');
  const r = new BitReader(bytes);
  const type = r.u8();
  switch (type) {
    case MsgType.Hello: {
      const protocolVersion = r.u16();
      const contentHash = r.u32();
      const name = r.string();
      const resumeToken = r.remainingBits >= 8 ? r.string() : '';
      const ticket = r.remainingBits >= 16 ? r.string(16) : '';
      // v19: a look after the ticket (5 bits at least: anything shorter is the last byte's padding)
      const look = r.remainingBits >= 8 ? readLook(r) : null;
      // v20: flags after the look (written only when one is set)
      const flags = r.remainingBits >= 8 ? r.u8() : 0;
      return { type, protocolVersion, contentHash, name, resumeToken, ticket, look, spectate: (flags & HelloFlag.Spectate) !== 0 };
    }
    case MsgType.Welcome: {
      const playerId = r.bits(5);
      const seed = r.u32();
      const serverTick = r.u32();
      const mapId = r.string();
      const tuningJson = r.string(16);
      const sessionToken = r.string();
      const resumed = r.bool();
      const overridesJson = r.string(16);
      // v20: flags, and a spectator's delay (a v19 server's WELCOME ends before them)
      const flags = r.remainingBits >= 8 ? r.u8() : 0;
      const spectator = (flags & WelcomeFlag.Spectator) !== 0;
      const delayTicks = spectator ? r.bits(10) : 0;
      return { type, playerId: spectator ? -1 : playerId, seed, serverTick, mapId, tuningJson, sessionToken, resumed, overridesJson, spectator, delayTicks };
    }
    case MsgType.SpectateAck: {
      const seq = r.u16();
      if (r.remainingBits >= 8) throw new DecodeError('trailing bytes after SPECTATE_ACK');
      return { type, seq };
    }
    case MsgType.Spectate: {
      const mode = r.bits(2);
      if (mode > SpectateMode.Spectator) throw new DecodeError(`unknown spectate mode ${mode}`);
      const follow = unPid(r.bits(5));
      const queue = r.bits(2);
      if (queue > SpectateQueue.Next) throw new DecodeError(`unknown spectate queue ${queue}`);
      const delayTicks = r.bits(10);
      const slots = r.bits(5);
      const n = r.bits(4);
      if (n > MAX_SPECTATORS) throw new DecodeError(`${n} spectators`);
      const spectators: SpectatorEntry[] = [];
      for (let i = 0; i < n; i++) spectators.push({ voiceId: r.u8(), name: r.string() });
      return { type, mode: mode as SpectateModeId, follow, queue: queue as SpectateQueueId, delayTicks, slots, spectators };
    }
    case MsgType.Ping:
      return { type, clientTime: r.f64() };
    case MsgType.Pong:
      return { type, clientTime: r.f64(), serverTick: r.u32() };
    case MsgType.Input: {
      const newestTick = r.u16();
      const ackSnapshotSeq = r.u16();
      const renderTick = r.u16();
      const renderFrac = r.u8();
      const count = r.bits(2) + 1;
      const inputs: Input[] = [];
      const renderLags: number[] = [];
      for (let i = 0; i < count; i++) {
        const buttons = r.u16();
        const aim = r.u16();
        const weaponSelect = r.bits(3);
        const throwStrength = r.bits(3);
        const dashStrength = r.bits(3);
        renderLags.push(i > 0 ? r.bits(RENDER_LAG_BITS) / RENDER_LAG_STEPS : 0);
        inputs.push({ buttons, aim, weaponSelect, throwStrength, dashStrength });
      }
      endOfInput(r);
      return { type, newestTick, ackSnapshotSeq, renderTick, renderFrac, inputs, renderLags };
    }
    case MsgType.Cmd:
      return { type, kind: r.u8(), payload: r.string(16) };
    case MsgType.Snapshot:
      // stateless: full snapshots only (clients decode deltas with a SnapshotDecoder)
      return decodeFullSnapshot(bytes);
    case MsgType.Roster: {
      const n = r.bits(6);
      const entries: RosterMsg['entries'] = [];
      for (let i = 0; i < n; i++) entries.push({ id: r.bits(5), isBot: r.bool(), since: r.u32(), name: r.string(), look: null });
      // v19's looks section; a ROSTER from an older server ends here (its padding is < 8 bits)
      if (r.remainingBits >= 8) {
        const looks = r.u8();
        for (let i = 0; i < looks; i++) {
          const look = readLook(r);
          if (i < n) entries[i]!.look = look;
        }
      }
      return { type, entries };
    }
    case MsgType.Kick:
      return { type, code: r.u16(), reason: r.string() };
    case MsgType.MatchState:
      return decodeMatchStateBody(r);
    case MsgType.Tuning:
      return { type, tuningJson: r.string(16) };
    case MsgType.Overrides:
      return { type, overridesJson: r.string(16) };
    case MsgType.Debug: {
      const kind = r.u8();
      if (kind !== DebugKind.Rewind) throw new DecodeError(`unknown debug kind ${kind}`);
      const tick = r.u32();
      const shooter = unPid(r.bits(5));
      const rewindTicks = r.bits(10) / 4;
      const requestedTicks = r.bits(10) / 4;
      const clamped = r.bool();
      const n = r.bits(5);
      const targets: RewindTarget[] = [];
      for (let i = 0; i < n; i++) {
        targets.push({
          id: unPid(r.bits(5)),
          x: r.signed(24) / POS_INV,
          y: r.signed(24) / POS_INV,
          crouched: r.bool(),
          nowX: r.signed(24) / POS_INV,
          nowY: r.signed(24) / POS_INV,
          hit: r.bool(),
        });
      }
      return { type, kind, tick, shooter, rewindTicks, requestedTicks, clamped, targets };
    }
    default:
      throw new DecodeError(`unknown message type 0x${type.toString(16)}`);
  }
}


// ---------- pooled INPUT decode (server hot path: 60 packets/s per client, no allocation) ----------

/** A reusable INPUT: `inputs` always holds MAX_INPUTS_PER_PACKET objects, the first `count` are valid. */
export interface InputPacket extends Omit<InputMsg, 'type' | 'inputs' | 'renderLags'> {
  count: number;
  readonly inputs: Input[];
  /** per input, in ticks (see InputMsg.renderLags) */
  readonly renderLags: Float64Array;
}

export function createInputPacket(): InputPacket {
  return {
    newestTick: 0,
    ackSnapshotSeq: 0,
    renderTick: 0,
    renderFrac: 0,
    count: 0,
    inputs: Array.from({ length: MAX_INPUTS_PER_PACKET }, createInput),
    renderLags: new Float64Array(MAX_INPUTS_PER_PACKET),
  };
}

const inputReader = new BitReader(new Uint8Array(0));

/** Decodes an INPUT into `out` without allocating. Throws DecodeError for anything malformed. */
export function decodeInputInto(bytes: Uint8Array, out: InputPacket): InputPacket {
  const r = inputReader.reset(bytes);
  if (r.remainingBits < 8 || r.u8() !== MsgType.Input) throw new DecodeError('not an INPUT');
  out.newestTick = r.u16();
  out.ackSnapshotSeq = r.u16();
  out.renderTick = r.u16();
  out.renderFrac = r.u8();
  out.count = r.bits(2) + 1;
  for (let i = 0; i < out.count; i++) {
    const input = out.inputs[i]!;
    input.buttons = r.u16();
    input.aim = r.u16();
    input.weaponSelect = r.bits(3);
    input.throwStrength = r.bits(3);
    input.dashStrength = r.bits(3);
    out.renderLags[i] = i > 0 ? r.bits(RENDER_LAG_BITS) / RENDER_LAG_STEPS : 0;
  }
  endOfInput(r);
  return out;
}

/** Nothing may follow the last input but the final byte's padding (docs/05 §14: length checks). */
function endOfInput(r: BitReader): void {
  if (r.remainingBits >= 8) throw new DecodeError('trailing bytes after INPUT');
}
