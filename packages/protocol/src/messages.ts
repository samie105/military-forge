/**
 * Wire messages (docs/05 §5–6) except snapshots, which live in snapshot.ts (delta-compressed,
 * per client). The input format matches the final design (redundant inputs, acks, render tick).
 */
import {
  CROUCHED_HITBOXES,
  EVENT_KINDS,
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
import { MsgType, pid, pos, unPid } from './wire';

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
 */
export const PROTOCOL_VERSION = 18;
/**
 * The oldest client a server still admits. v18 only added messages a v17 client never receives
 * (the server sends voice only to clients that said v18 and asked for it), so v17 pages still play.
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
} as const;

export const MAX_INPUTS_PER_PACKET = 4;

/** `inputBufferHealth` value meaning "no input from this client yet". */
export const HEALTH_UNKNOWN = -128;

/**
 * Messages that may be lost, duplicated or reordered (docs/05 §2): the network conditioner only
 * drops these. Everything else is reliable and ordered.
 */
export function isUnreliableMessage(bytes: Uint8Array): boolean {
  const type = bytes[0];
  return type === MsgType.Input || type === MsgType.Ping || type === MsgType.Pong || type === MsgType.Snapshot || type === MsgType.Debug || type === MsgType.VoiceUp || type === MsgType.VoiceDown;
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

export type ServerMessage = WelcomeMsg | PongMsg | SnapshotMsg | RosterMsg | KickMsg | TuningMsg | OverridesMsg | RewindDebugMsg | MatchStateMsg;
export type ClientMessage = HelloMsg | PingMsg | InputMsg | CmdMsg;
export type Message = ServerMessage | ClientMessage;

// ---------- encoders ----------

const w = new BitWriter(4096);

/** Trailing fields are optional on decode: the join ticket (u16-length string) is sent only when there is one. */
export function encodeHello(name: string, resumeToken = '', ticket = ''): Uint8Array {
  w.reset().u8(MsgType.Hello).u16(PROTOCOL_VERSION).u32(CONTENT_HASH).string(name).string(resumeToken);
  if (ticket) w.string(ticket, 16);
  return w.finish().slice();
}

export function encodeWelcome(m: Omit<WelcomeMsg, 'type'>): Uint8Array {
  return w
    .reset()
    .u8(MsgType.Welcome)
    .unsigned(m.playerId, 5)
    .u32(m.seed)
    .u32(m.serverTick)
    .string(m.mapId)
    .string(m.tuningJson, 16)
    .string(m.sessionToken)
    .bool(m.resumed)
    .string(m.overridesJson, 16)
    .finish()
    .slice();
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

export function encodeRoster(entries: readonly RosterEntry[]): Uint8Array {
  w.reset().u8(MsgType.Roster).unsigned(entries.length, 6);
  for (const e of entries) w.unsigned(e.id, 5).bool(e.isBot).u32(e.since).string(e.name);
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
      return { type, protocolVersion, contentHash, name, resumeToken, ticket };
    }
    case MsgType.Welcome:
      return {
        type,
        playerId: r.bits(5),
        seed: r.u32(),
        serverTick: r.u32(),
        mapId: r.string(),
        tuningJson: r.string(16),
        sessionToken: r.string(),
        resumed: r.bool(),
        overridesJson: r.string(16),
      };
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
      for (let i = 0; i < n; i++) entries.push({ id: r.bits(5), isBot: r.bool(), since: r.u32(), name: r.string() });
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
