/**
 * Snapshots (docs/05 §6.2, §9, §11), encoded per client:
 *
 *   u8 type · u16 seq · u32 serverTick · u16 ackInputTick · i8 inputBufferHealth
 *   u16 baselineSeq (0 = full) · u1 hasLocal · [local block, full or changed groups]
 *   u5 changed · { u5 id · u8 groupMask · groups }   players new or changed since the baseline
 *   u5 removed · { u5 id }                           in the baseline, now gone or out of view
 *   u7 grenades · { … }                              in view, full
 *   u1 pickups changed · [u6 n · { u6 id · u6 def · i24 x · i24 y }]   items in view, when changed (v9; u6 id/def v11)
 *   u5 clouds · { u5 id · u3 type · x · y · u10 age } in view, full (smoke and gas, v10)
 *   u8 events · { u3 tag · … }                       in view; gunfire/blasts outside it → SOUND;
 *                                                    map events (v8) always; tag 7 = extended, u4 kind
 *                                                    (v8 dash; v9 ricochet, shield break, pickup)
 *
 * The baseline is the newest snapshot the client acked (INPUT.ackSnapshotSeq). The server keeps
 * the last 32 it sent to each client (SnapshotBaselines), the client the last 64 it decoded
 * (SnapshotDecoder). Without a usable baseline (join, long loss) the snapshot is full. Everything
 * compared is a quantised integer, so "unchanged" is exact and costs nothing.
 *
 * AOI (docs/05 §9): players and grenades outside the client's view rect aren't sent, so zoom hacks
 * and off-screen ESP get nothing. Shots and explosions outside it arrive as SOUND events with 4 m
 * positions (enough for direction, useless for aiming). Players and grenades smoke hides from a
 * client (inside a cloud the client's eyes are outside of, behind smoke from its eyes, or across
 * the cloud it's in: sim SmokeSight) aren't sent to it either, and tracers vanish where they enter
 * smoke, so a wallhack can't see into or through it.
 */
import { CROUCHED_HITBOXES, STANDING_HITBOXES } from '@military-forge/content';
import { POS_INV, TAU, VEL_INV, simAtan2, simCosSin } from '@military-forge/shared';
import { MAX_PICKUPS, MAX_PLAYERS, SmokeSight, blindIntensity, cloudDef, shieldRaised, type Game, type PlayerState, type SimEvent } from '@military-forge/sim';
import { BitReader, BitWriter, DecodeError } from './bitstream';
import {
  captureLocalState,
  createLocalState,
  readLocalState,
  readLocalStateDelta,
  writeLocalState,
  writeLocalStateDelta,
  type LocalState,
} from './localState';
import { MsgType, pid, pos, unPid } from './wire';

// ---------- message shapes ----------

/** Another player as the client sees it (its own exact state is the local block). */
export interface SnapshotPlayer {
  id: number;
  alive: boolean;
  isBot: boolean;
  grounded: boolean;
  crouched: boolean;
  jetting: boolean;
  dual: boolean;
  reloading: boolean;
  /** in a dash burst (v8, docs/02 §21): the animation and the streak */
  dashing: boolean;
  /** metres, exact (1/1024) */
  x: number;
  y: number;
  /** m/s, 1/64 resolution (animation and extrapolation only) */
  vx: number;
  vy: number;
  /** u16 angle, 1/1024 of a turn resolution */
  aim: number;
  /** whole HP, rounded up */
  hp: number;
  active: number;
  /** weapon defs per slot (63 = empty); ammo is private to the local block */
  weapons: { def: number }[];
  respawnTicks: number;
  kills: number;
  deaths: number;
  /**
   * Riot shield (v9; its HP is private to the local block): slung on the back (guarding it), on its way
   * up (guarding neither side), or up in front (guarding it).
   */
  shield: SnapshotShield;
}

export type SnapshotShield = 'none' | 'slung' | 'raising' | 'up';
const SHIELD_STATES: readonly SnapshotShield[] = ['none', 'slung', 'raising', 'up'];

/** An item lying on the map (pickups.ts): `def` is its PickupDef.index. */
export interface SnapshotPickup {
  id: number;
  def: number;
  x: number;
  y: number;
}

export interface SnapshotGrenade {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
  /** grenade type (packages/content grenades), v10 */
  type: number;
  /** a mine's state (sim MineState), 0 for the other types, v10 */
  state: number;
}

/**
 * A smoke or gas cloud (v10). Its radius and density follow from type and age through the sim's
 * own functions (cloudRadius, cloudDensity), so they aren't sent.
 */
export interface SnapshotCloud {
  id: number;
  type: number;
  x: number;
  y: number;
  /** ticks since it popped, at the snapshot's server tick */
  age: number;
}

/** Gunfire or a blast outside the view rect: kind and a 4 m-coarse position (docs/05 §9). */
export interface SoundEvent {
  type: 'sound';
  kind: 'shot' | 'explosion';
  /** weapon index, or 62 for a grenade */
  source: number;
  x: number;
  y: number;
}

export type SnapshotEvent = SimEvent | SoundEvent;

export interface SnapshotMsg {
  type: typeof MsgType.Snapshot;
  seq: number;
  serverTick: number;
  /** the tick whose result `local` is: the last tick the server simulated (16-bit wrapping) */
  ackInputTick: number;
  /**
   * How many ticks early this client's inputs arrive (min over the snapshot interval): the input
   * for the tick being simulated plus this many more were queued. HEALTH_UNKNOWN before any input.
   */
  inputBufferHealth: number;
  /** the snapshot this one was encoded against, 0 when full */
  baselineSeq: number;
  /** the receiving client's own player, exact (null if it has none) */
  local: LocalState | null;
  /** players in this client's view, by id */
  players: SnapshotPlayer[];
  grenades: SnapshotGrenade[];
  /** every item on the map (not culled: items are static and give nobody away) */
  pickups: SnapshotPickup[];
  clouds: SnapshotCloud[];
  events: SnapshotEvent[];
}

/** World-space rectangle a client may see (AOI). */
export interface ViewRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---------- remote player records ----------

const F_FLAGS = 0;
const F_X = 1;
const F_Y = 2;
const F_VX = 3;
const F_VY = 4;
const F_AIM = 5;
const F_HP = 6;
const F_ACTIVE = 7;
const F_W0 = 8;
const F_W1 = 9;
const F_KILLS = 10;
const F_DEATHS = 11;
const F_RESPAWN = 12;
const FIELDS = 13;

const FLAG_ALIVE = 1;
const FLAG_BOT = 2;
const FLAG_GROUNDED = 4;
const FLAG_CROUCHED = 8;
const FLAG_JETTING = 16;
const FLAG_DUAL = 32;
const FLAG_RELOADING = 64;
const FLAG_DASHING = 128;
/**
 * Riot shield (v9): a 2-bit state in flag bits 8–9 (the registry's 256 and 512), an index into
 * SHIELD_STATES: 0 none, 1 slung (guards the back), 2 raising (guards neither side), 3 up.
 */
const SHIELD_SHIFT = 8;
/** remote flags on the wire (v8: 8, with dashing; v9: 10, with the shield state) */
const FLAG_BITS = 10;

function shieldState(p: PlayerState): number {
  if (p.shieldHp <= 0) return 0;
  return shieldRaised(p) ? 3 : p.shieldTicks > 0 ? 2 : 1;
}

const G_POS = 1;
const G_VEL = 2;
const G_AIM = 4;
const G_STATE = 8;
const G_HP = 16;
const G_WEAPON = 32;
const G_SCORE = 64;
const G_RESPAWN = 128;
const G_ALL = 255;

/** position deltas below ±4 m (1/1024) travel in 13 bits instead of 24 */
const SMALL_POS_BITS = 13;
const SMALL_POS_MAX = (1 << (SMALL_POS_BITS - 1)) - 1;
/** remote velocity resolution (1/64 m/s) */
const REMOTE_VEL_INV = 64;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function captureRemote(p: PlayerState, out: Int32Array, o: number): void {
  out[o + F_FLAGS] =
    (p.alive ? FLAG_ALIVE : 0) |
    (p.isBot ? FLAG_BOT : 0) |
    (p.grounded ? FLAG_GROUNDED : 0) |
    (p.crouched ? FLAG_CROUCHED : 0) |
    (p.jetting ? FLAG_JETTING : 0) |
    (p.dual ? FLAG_DUAL : 0) |
    (p.weapons[0].reloadTicks > 0 || p.weapons[1].reloadTicks > 0 ? FLAG_RELOADING : 0) |
    (p.dashTicks > 0 ? FLAG_DASHING : 0) |
    (shieldState(p) << SHIELD_SHIFT);
  out[o + F_X] = clamp(pos(p.x), -(1 << 23), (1 << 23) - 1);
  out[o + F_Y] = clamp(pos(p.y), -(1 << 23), (1 << 23) - 1);
  out[o + F_VX] = clamp(Math.round(p.vx * REMOTE_VEL_INV), -2048, 2047);
  out[o + F_VY] = clamp(Math.round(p.vy * REMOTE_VEL_INV), -2048, 2047);
  out[o + F_AIM] = (p.input.aim >>> 6) & 1023;
  out[o + F_HP] = clamp(Math.ceil(p.hp), 0, 255);
  out[o + F_ACTIVE] = p.active & 1;
  out[o + F_W0] = p.weapons[0].def & 63;
  out[o + F_W1] = p.weapons[1].def & 63;
  out[o + F_KILLS] = clamp(p.kills, -32768, 32767);
  out[o + F_DEATHS] = clamp(p.deaths, 0, 65535);
  out[o + F_RESPAWN] = clamp(p.respawnTicks, 0, 255);
}

function changedGroups(cur: Int32Array, c: number, base: Int32Array, b: number): number {
  let m = 0;
  if (cur[c + F_X] !== base[b + F_X] || cur[c + F_Y] !== base[b + F_Y]) m |= G_POS;
  if (cur[c + F_VX] !== base[b + F_VX] || cur[c + F_VY] !== base[b + F_VY]) m |= G_VEL;
  if (cur[c + F_AIM] !== base[b + F_AIM]) m |= G_AIM;
  if (cur[c + F_FLAGS] !== base[b + F_FLAGS]) m |= G_STATE;
  if (cur[c + F_HP] !== base[b + F_HP]) m |= G_HP;
  if (cur[c + F_ACTIVE] !== base[b + F_ACTIVE] || cur[c + F_W0] !== base[b + F_W0] || cur[c + F_W1] !== base[b + F_W1]) m |= G_WEAPON;
  if (cur[c + F_KILLS] !== base[b + F_KILLS] || cur[c + F_DEATHS] !== base[b + F_DEATHS]) m |= G_SCORE;
  if (cur[c + F_RESPAWN] !== base[b + F_RESPAWN]) m |= G_RESPAWN;
  return m;
}

/** `base`/`b` hold the baseline record for small position deltas (null for new entities). */
function writeRemote(w: BitWriter, cur: Int32Array, c: number, mask: number, base: Int32Array | null, b: number): void {
  if (mask & G_POS) {
    const dx = base ? cur[c + F_X]! - base[b + F_X]! : Infinity;
    const dy = base ? cur[c + F_Y]! - base[b + F_Y]! : Infinity;
    if (Math.abs(dx) <= SMALL_POS_MAX && Math.abs(dy) <= SMALL_POS_MAX) w.bool(true).signed(dx, SMALL_POS_BITS).signed(dy, SMALL_POS_BITS);
    else w.bool(false).signed(cur[c + F_X]!, 24).signed(cur[c + F_Y]!, 24);
  }
  if (mask & G_VEL) w.signed(cur[c + F_VX]!, 12).signed(cur[c + F_VY]!, 12);
  if (mask & G_AIM) w.bits(cur[c + F_AIM]!, 10);
  if (mask & G_STATE) w.bits(cur[c + F_FLAGS]!, FLAG_BITS);
  if (mask & G_HP) w.bits(cur[c + F_HP]!, 8);
  if (mask & G_WEAPON) w.bits(cur[c + F_ACTIVE]!, 1).bits(cur[c + F_W0]!, 6).bits(cur[c + F_W1]!, 6);
  if (mask & G_SCORE) w.signed(cur[c + F_KILLS]!, 16).bits(cur[c + F_DEATHS]!, 16);
  if (mask & G_RESPAWN) w.bits(cur[c + F_RESPAWN]!, 8);
}

/** Reads the groups in `mask` into out[o…], which already holds the baseline record. */
function readRemote(r: BitReader, out: Int32Array, o: number, mask: number): void {
  if (mask & G_POS) {
    if (r.bool()) {
      out[o + F_X]! += r.signed(SMALL_POS_BITS);
      out[o + F_Y]! += r.signed(SMALL_POS_BITS);
    } else {
      out[o + F_X] = r.signed(24);
      out[o + F_Y] = r.signed(24);
    }
  }
  if (mask & G_VEL) {
    out[o + F_VX] = r.signed(12);
    out[o + F_VY] = r.signed(12);
  }
  if (mask & G_AIM) out[o + F_AIM] = r.bits(10);
  if (mask & G_STATE) out[o + F_FLAGS] = r.bits(FLAG_BITS);
  if (mask & G_HP) out[o + F_HP] = r.bits(8);
  if (mask & G_WEAPON) {
    out[o + F_ACTIVE] = r.bits(1);
    out[o + F_W0] = r.bits(6);
    out[o + F_W1] = r.bits(6);
  }
  if (mask & G_SCORE) {
    out[o + F_KILLS] = r.signed(16);
    out[o + F_DEATHS] = r.bits(16);
  }
  if (mask & G_RESPAWN) out[o + F_RESPAWN] = r.bits(8);
}

function toSnapshotPlayer(id: number, s: Int32Array, o: number): SnapshotPlayer {
  const flags = s[o + F_FLAGS]!;
  return {
    id,
    alive: (flags & FLAG_ALIVE) !== 0,
    isBot: (flags & FLAG_BOT) !== 0,
    grounded: (flags & FLAG_GROUNDED) !== 0,
    crouched: (flags & FLAG_CROUCHED) !== 0,
    jetting: (flags & FLAG_JETTING) !== 0,
    dual: (flags & FLAG_DUAL) !== 0,
    reloading: (flags & FLAG_RELOADING) !== 0,
    dashing: (flags & FLAG_DASHING) !== 0,
    x: s[o + F_X]! / POS_INV,
    y: s[o + F_Y]! / POS_INV,
    vx: s[o + F_VX]! / REMOTE_VEL_INV,
    vy: s[o + F_VY]! / REMOTE_VEL_INV,
    aim: (s[o + F_AIM]! << 6) | 32,
    hp: s[o + F_HP]!,
    active: s[o + F_ACTIVE]!,
    weapons: [{ def: s[o + F_W0]! }, { def: s[o + F_W1]! }],
    respawnTicks: s[o + F_RESPAWN]!,
    kills: s[o + F_KILLS]!,
    deaths: s[o + F_DEATHS]!,
    shield: SHIELD_STATES[(flags >> SHIELD_SHIFT) & 3]!,
  };
}

// ---------- pickups ----------

/** One snapshot's items, as integers: count, then (id, def, x, y) each. */
const PICKUP_FIELDS = 4;
const PICKUP_LIST = 1 + MAX_PICKUPS * PICKUP_FIELDS;

function capturePickups(game: Game, out: Int32Array): void {
  let n = 0;
  for (const k of game.pickups) {
    if (!k.alive) continue;
    const o = 1 + n * PICKUP_FIELDS;
    out[o] = k.id;
    out[o + 1] = k.def;
    out[o + 2] = pos(k.x);
    out[o + 3] = pos(k.y);
    n++;
  }
  out[0] = n;
}

/** The items in `view` (all of them without one), from a captured list into `out`. */
function pickupsInView(all: Int32Array, view: ViewRect | null, out: Int32Array): Int32Array {
  if (view === null) return all;
  let n = 0;
  for (let i = 0; i < all[0]!; i++) {
    const o = 1 + i * PICKUP_FIELDS;
    if (!inRect(view, all[o + 2]! / POS_INV, all[o + 3]! / POS_INV)) continue;
    out.set(all.subarray(o, o + PICKUP_FIELDS), 1 + n * PICKUP_FIELDS);
    n++;
  }
  out[0] = n;
  return out;
}

function samePickups(a: Int32Array, ao: number, b: Int32Array, bo: number): boolean {
  const len = 1 + a[ao]! * PICKUP_FIELDS;
  for (let i = 0; i < len; i++) if (a[ao + i] !== b[bo + i]) return false;
  return true;
}

function toPickups(list: Int32Array): SnapshotPickup[] {
  const out: SnapshotPickup[] = [];
  for (let i = 0; i < list[0]!; i++) {
    const o = 1 + i * PICKUP_FIELDS;
    out.push({ id: list[o]!, def: list[o + 1]!, x: list[o + 2]! / POS_INV, y: list[o + 3]! / POS_INV });
  }
  return out;
}

// ---------- events ----------

const EVENT_SHOT = 0;
const EVENT_EXPLOSION = 1;
const EVENT_DEATH = 2;
const EVENT_HIT = 3;
const EVENT_SPAWN = 4;
const EVENT_SOUND = 5;
/**
 * A map event's warning, start or end (v8, docs/02 §20.7): u5 event · u2 phase · u16 occurrence
 * (low bits) · u8 zone (255 = all) · u1 flip · u16 ticks left.
 */
const EVENT_MAP = 6;
const NO_ZONE = 255;
/**
 * Tag 7 (v8) is the escape to extended events, so the 3-bit tag never runs out: u4 kind, then the
 * kind's fields. New event kinds take the next ext kind. There is no length prefix: a client can't
 * skip a kind it doesn't know, so every new ext kind is a PROTOCOL_VERSION bump (claim it in the
 * protocol registry first).
 */
const EVENT_EXT = 7;
const EXT_BITS = 4;
/** a dash started (docs/02 §21): u5 player · i24 x · i24 y · u3 direction (8-way, 0 = right, CCW) */
const EXT_DASH = 0;
/**
 * A bullet glanced off a riot shield (v9): u5 shooter · u5 owner · u6 weapon · i24 x · i24 y (the
 * bounce) · u8 normal (angle) · i24 ex · i24 ey · u2 hit · u5 target · u2 zone.
 */
const EXT_RICOCHET = 1;
/** a riot shield broke (v9): u5 owner · u5 attacker · i24 x · i24 y */
const EXT_SHIELD_BREAK = 2;
/** someone took an item (v9): u5 player · u4 item · i24 x · i24 y */
const EXT_PICKUP = 3;
/** a ricochet's shield normal travels as a u8 angle */
const NORMAL_STEPS = 256;
/** SOUND positions: 4 m grid */
const SOUND_CELL = 4;
const GRENADE_SOURCE = 62;
/**
 * How far a player's hitboxes reach from its feet, any direction. Culling tests the feet, so a
 * culled player's body can poke this far into the AOI rect.
 */
const BODY_REACH =
  Math.max(...[STANDING_HITBOXES, CROUCHED_HITBOXES].flatMap((h) => [h.head.y + h.head.r, h.torso.y1 + h.torso.r, h.legs.r - h.legs.y0])) + 0.05;

function inRect(v: ViewRect, x: number, y: number): boolean {
  return x >= v.minX && x <= v.maxX && y >= v.minY && y <= v.maxY;
}

/** Any part of a cloud (at its full radius) inside the view. */
function cloudInView(v: ViewRect | null, type: number, x: number, y: number): boolean {
  if (v === null) return true;
  const r = cloudDef(type)?.radius ?? 0;
  return x + r >= v.minX && x - r <= v.maxX && y + r >= v.minY && y - r <= v.maxY;
}

/** Liang–Barsky clip state (module scratch: no closure per call). */
const lb = { t0: 0, t1: 1 };
/**
 * The line a client gets for the shot or ricochet being encoded (module scratch, set by eventKind):
 * its end, and `hit` when it was carried on past a player smoke hides from that client (a miss's
 * 0 or 1 then).
 */
const tracer = { ex: 0, ey: 0, carried: false, hit: 0 };

function clipEdge(p: number, q: number): boolean {
  if (p === 0) return q >= 0;
  const r = q / p;
  if (p < 0) {
    if (r > lb.t1) return false;
    if (r > lb.t0) lb.t0 = r;
  } else {
    if (r < lb.t0) return false;
    if (r < lb.t1) lb.t1 = r;
  }
  return true;
}

/** Does the segment touch the rect? (Liang–Barsky) */
function segmentInRect(v: ViewRect, x0: number, y0: number, x1: number, y1: number): boolean {
  lb.t0 = 0;
  lb.t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  return clipEdge(-dx, x0 - v.minX) && clipEdge(dx, v.maxX - x0) && clipEdge(-dy, y0 - v.minY) && clipEdge(dy, v.maxY - y0);
}

function writeSound(w: BitWriter, kind: 'shot' | 'explosion', source: number, x: number, y: number): void {
  w.bits(EVENT_SOUND, 3)
    .bits(kind === 'shot' ? 0 : 1, 1)
    .unsigned(source, 6)
    .signed(Math.round(x / SOUND_CELL), 8)
    .signed(Math.round(y / SOUND_CELL), 8);
}

function writeShot(
  w: BitWriter,
  shooter: number,
  weapon: number,
  ox: number,
  oy: number,
  ex: number,
  ey: number,
  hit: number,
  target: number,
  zone: number,
): void {
  w.bits(EVENT_SHOT, 3)
    .unsigned(pid(shooter), 5)
    .unsigned(weapon, 6)
    .signed(pos(ox), 24)
    .signed(pos(oy), 24)
    .signed(pos(ex), 24)
    .signed(pos(ey), 24)
    .unsigned(hit, 2)
    .unsigned(pid(target), 5)
    .unsigned(zone, 2);
}

function writeHit(w: BitWriter, attacker: number, target: number, damage: number, zone: number, source: number): void {
  w.bits(EVENT_HIT, 3)
    .unsigned(pid(attacker), 5)
    .unsigned(pid(target), 5)
    .unsigned(damage * 16, 12)
    .unsigned(zone, 2)
    .unsigned(source, 6);
}

/** v10: `grenade` (u3) says what went off: a blast, a flashbang, an EMP… */
function writeExplosion(w: BitWriter, x: number, y: number, radius: number, owner: number, grenade: number): void {
  w.bits(EVENT_EXPLOSION, 3).signed(pos(x), 24).signed(pos(y), 24).unsigned(radius * 16, 8).unsigned(pid(owner), 5).unsigned(grenade, 3);
}

function writeRicochet(w: BitWriter, e: Extract<SimEvent, { type: 'ricochet' }>, shooter: number, ex: number, ey: number, hit: number, target: number, zone: number): void {
  const normal = Math.round((simAtan2(e.ny, e.nx) / TAU) * NORMAL_STEPS) & (NORMAL_STEPS - 1);
  w.bits(EVENT_EXT, 3)
    .bits(EXT_RICOCHET, EXT_BITS)
    .unsigned(pid(shooter), 5)
    .unsigned(pid(e.owner), 5)
    .unsigned(e.weapon, 6)
    .signed(pos(e.x), 24)
    .signed(pos(e.y), 24)
    .unsigned(normal, 8)
    .signed(pos(ex), 24)
    .signed(pos(ey), 24)
    .unsigned(hit, 2)
    .unsigned(pid(target), 5)
    .unsigned(zone, 2);
}

function writeShieldBreak(w: BitWriter, owner: number, attacker: number, x: number, y: number): void {
  w.bits(EVENT_EXT, 3).bits(EXT_SHIELD_BREAK, EXT_BITS).unsigned(pid(owner), 5).unsigned(pid(attacker), 5).signed(pos(x), 24).signed(pos(y), 24);
}

const normalScratch = { x: 0, y: 0 };

function readExtEvent(r: BitReader): SnapshotEvent {
  const kind = r.bits(EXT_BITS);
  switch (kind) {
    case EXT_DASH:
      return { type: 'dash', player: unPid(r.bits(5)), x: r.signed(24) / POS_INV, y: r.signed(24) / POS_INV, dir: r.bits(3) };
    case EXT_RICOCHET: {
      const shooter = unPid(r.bits(5));
      const owner = unPid(r.bits(5));
      const weapon = r.bits(6);
      const x = r.signed(24) / POS_INV;
      const y = r.signed(24) / POS_INV;
      simCosSin((r.bits(8) / NORMAL_STEPS) * TAU, normalScratch);
      const ex = r.signed(24) / POS_INV;
      const ey = r.signed(24) / POS_INV;
      const hit = r.bits(2) as 0 | 1 | 2 | 3;
      const target = unPid(r.bits(5));
      const zone = r.bits(2);
      // tidy an axis-aligned normal (a vertical shield's ±x) back to exact values
      const nx = Math.abs(normalScratch.x) < 1e-9 ? 0 : normalScratch.x;
      const ny = Math.abs(normalScratch.y) < 1e-9 ? 0 : normalScratch.y;
      return { type: 'ricochet', shooter, owner, weapon, x, y, nx, ny, ex, ey, hit, target, zone };
    }
    case EXT_SHIELD_BREAK:
      return { type: 'shieldBreak', owner: unPid(r.bits(5)), attacker: unPid(r.bits(5)), x: r.signed(24) / POS_INV, y: r.signed(24) / POS_INV };
    case EXT_PICKUP:
      return { type: 'pickup', player: unPid(r.bits(5)), item: r.bits(6), x: r.signed(24) / POS_INV, y: r.signed(24) / POS_INV };
    default:
      throw new DecodeError(`unknown extended event kind ${kind}`);
  }
}

function writeEvent(w: BitWriter, e: SimEvent): void {
  switch (e.type) {
    case 'shot':
      writeShot(w, e.shooter, e.weapon, e.ox, e.oy, e.ex, e.ey, e.hit, e.target, e.zone);
      break;
    case 'explosion':
      writeExplosion(w, e.x, e.y, e.radius, e.owner, e.grenade ?? 0);
      break;
    case 'death':
      w.bits(EVENT_DEATH, 3).unsigned(pid(e.victim), 5).unsigned(pid(e.killer), 5).unsigned(e.source, 6);
      break;
    case 'hit':
      writeHit(w, e.attacker, e.target, e.damage, e.zone, e.source);
      break;
    case 'spawn':
      w.bits(EVENT_SPAWN, 3).unsigned(pid(e.player), 5);
      break;
    case 'dash':
      w.bits(EVENT_EXT, 3).bits(EXT_DASH, EXT_BITS).unsigned(pid(e.player), 5).signed(pos(e.x), 24).signed(pos(e.y), 24).unsigned(e.dir, 3);
      break;
    case 'mapEvent':
      w.bits(EVENT_MAP, 3)
        .unsigned(e.event, 5)
        .unsigned(e.phase, 2)
        .bits(e.occurrence & 0xffff, 16)
        .unsigned(e.zone < 0 ? NO_ZONE : e.zone, 8)
        .bool(e.flip)
        .unsigned(e.ticks, 16);
      break;
    case 'ricochet':
      writeRicochet(w, e, e.shooter, e.ex, e.ey, e.hit, e.target, e.zone);
      break;
    case 'shieldBreak':
      writeShieldBreak(w, e.owner, e.attacker, e.x, e.y);
      break;
    case 'pickup':
      w.bits(EVENT_EXT, 3).bits(EXT_PICKUP, EXT_BITS).unsigned(pid(e.player), 5).unsigned(e.item, 6).signed(pos(e.x), 24).signed(pos(e.y), 24);
      break;
    case 'throw':
      break;
  }
}

function readEvent(r: BitReader): SnapshotEvent {
  const kind = r.bits(3);
  switch (kind) {
    case EVENT_SHOT: {
      const shooter = unPid(r.bits(5));
      const weapon = r.bits(6);
      const ox = r.signed(24) / POS_INV;
      const oy = r.signed(24) / POS_INV;
      const ex = r.signed(24) / POS_INV;
      const ey = r.signed(24) / POS_INV;
      const hit = r.bits(2) as 0 | 1 | 2 | 3;
      const target = unPid(r.bits(5));
      const zone = r.bits(2);
      return { type: 'shot', shooter, weapon, ox, oy, ex, ey, hit, target, zone };
    }
    case EVENT_EXPLOSION:
      return { type: 'explosion', x: r.signed(24) / POS_INV, y: r.signed(24) / POS_INV, radius: r.u8() / 16, owner: unPid(r.bits(5)), grenade: r.bits(3) };
    case EVENT_DEATH:
      return { type: 'death', victim: unPid(r.bits(5)), killer: unPid(r.bits(5)), source: r.bits(6) };
    case EVENT_HIT:
      return { type: 'hit', attacker: unPid(r.bits(5)), target: unPid(r.bits(5)), damage: r.bits(12) / 16, zone: r.bits(2), source: r.bits(6) };
    case EVENT_SPAWN:
      return { type: 'spawn', player: unPid(r.bits(5)) };
    case EVENT_SOUND:
      return { type: 'sound', kind: r.bits(1) === 0 ? 'shot' : 'explosion', source: r.bits(6), x: r.signed(8) * SOUND_CELL, y: r.signed(8) * SOUND_CELL };
    case EVENT_EXT:
      return readExtEvent(r);
    case EVENT_MAP: {
      const event = r.bits(5);
      const phase = r.bits(2);
      if (phase > 2) throw new DecodeError(`map event phase ${phase}`);
      const occurrence = r.bits(16);
      const zone = r.bits(8);
      return { type: 'mapEvent', event, phase: phase as 0 | 1 | 2, occurrence, zone: zone === NO_ZONE ? -1 : zone, flip: r.bool(), ticks: r.bits(16) };
    }
    default:
      throw new DecodeError(`unknown event kind ${kind}`);
  }
}

// ---------- server side ----------

/** a newer than b in 16-bit sequence space */
function seqNewer(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/** What the server sent one client recently: the baselines its next snapshots can delta against. */
export class SnapshotBaselines {
  static readonly SIZE = 32;
  /** newest snapshot this client says it decoded (INPUT.ackSnapshotSeq), 0 = none */
  acked = 0;
  readonly seqs = new Int32Array(SnapshotBaselines.SIZE).fill(-1);
  readonly present = new Uint8Array(SnapshotBaselines.SIZE * MAX_PLAYERS);
  readonly states = new Int32Array(SnapshotBaselines.SIZE * MAX_PLAYERS * FIELDS);
  readonly locals: LocalState[] = Array.from({ length: SnapshotBaselines.SIZE }, createLocalState);
  readonly hasLocal = new Uint8Array(SnapshotBaselines.SIZE);
  /** the item list each snapshot left the client with */
  readonly pickups = new Int32Array(SnapshotBaselines.SIZE * PICKUP_LIST);

  ack(seq: number): void {
    if (seq !== 0 && (this.acked === 0 || seqNewer(seq, this.acked))) this.acked = seq;
  }

  /** ring slot holding `seq`, or −1 */
  slotOf(seq: number): number {
    if (seq === 0) return -1;
    const slot = seq & (SnapshotBaselines.SIZE - 1);
    return this.seqs[slot] === seq ? slot : -1;
  }

  /** Forget everything (e.g. the client reconnected): the next snapshot is full. */
  reset(): void {
    this.acked = 0;
    this.seqs.fill(-1);
  }
}

/** One client's view of this snapshot. */
export interface SnapshotTarget {
  /** null: always full, nothing remembered (tools, tests) */
  baselines: SnapshotBaselines | null;
  ackInputTick: number;
  inputBufferHealth: number;
  /** the client's own player (local block; always in view) */
  local: PlayerState | null;
  /** AOI rect, null = everything */
  view: ViewRect | null;
  /** events from snapshot intervals this client skipped (low-bandwidth mode), sent before this one's */
  extraEvents?: readonly SimEvent[];
}

/**
 * Captures the room once per snapshot tick (begin), then encodes each client's snapshot against
 * its own baseline and view (encodeFor). One encoder per room.
 */
export class SnapshotEncoder {
  private readonly w = new BitWriter(4096);
  private readonly cur = new Int32Array(MAX_PLAYERS * FIELDS);
  private readonly present = new Uint8Array(MAX_PLAYERS);
  private readonly xs = new Float64Array(MAX_PLAYERS);
  private readonly ys = new Float64Array(MAX_PLAYERS);
  private readonly inView = new Uint8Array(MAX_PLAYERS);
  /** this client is in a flashbang's full white (encodeFor): it's sent no one else */
  private blind = false;
  /** who smoke hides from whom this snapshot (sim clouds.ts) */
  private readonly sight = new SmokeSight();
  private readonly masks = new Uint8Array(MAX_PLAYERS);
  /** the view shrunk by BODY_REACH (clipping tracers that end on a culled player) */
  private readonly inset: ViewRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly local = createLocalState();
  private readonly pickups = new Int32Array(PICKUP_LIST);
  /** this client's share of `pickups` (the ones in its view) */
  private readonly viewPickups = new Int32Array(PICKUP_LIST);
  private game: Game | null = null;
  private events: readonly SimEvent[] = [];
  private seq = 0;

  begin(game: Game, seq: number, events: readonly SimEvent[]): void {
    this.game = game;
    this.seq = seq;
    this.events = events;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const p = game.players[id];
      this.present[id] = p ? 1 : 0;
      if (!p) continue;
      captureRemote(p, this.cur, id * FIELDS);
      this.xs[id] = p.x;
      this.ys[id] = p.y;
    }
    capturePickups(game, this.pickups);
    this.sight.gather(game);
  }

  encodeFor(t: SnapshotTarget): Uint8Array {
    const game = this.game!;
    const w = this.w.reset();
    const bl = t.baselines;
    const bslot = bl ? bl.slotOf(bl.acked) : -1;
    const viewer = t.local ? t.local.id : -1;
    const view = t.view;
    // a flashbang's full white is the server's word too: while it lasts the client gets nobody else,
    // so a client that hides the white-out still sees nothing (the fade is the client's to draw)
    this.blind = view !== null && t.local !== null && t.local.alive && blindIntensity(t.local) >= 1;
    w.u8(MsgType.Snapshot)
      .u16(this.seq)
      .u32(game.tick)
      .u16(t.ackInputTick)
      .signed(t.inputBufferHealth, 8)
      .u16(bslot >= 0 ? bl!.acked : 0)
      .bool(t.local !== null);
    if (t.local) {
      captureLocalState(t.local, this.local);
      if (bslot >= 0 && bl!.hasLocal[bslot]) writeLocalStateDelta(w, this.local, bl!.locals[bslot]!);
      else writeLocalState(w, this.local);
    }

    // players: new or changed since the baseline, then those that left the view
    let changed = 0;
    let removed = 0;
    const bp = bslot * MAX_PLAYERS;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const visible =
        this.present[id] === 1 && (view === null || id === viewer || (!this.blind && inRect(view, this.xs[id]!, this.ys[id]!) && !this.sight.hides(viewer, id)));
      this.inView[id] = visible ? 1 : 0;
      const inBase = bslot >= 0 && bl!.present[bp + id] === 1;
      if (visible) {
        const mask = inBase ? changedGroups(this.cur, id * FIELDS, bl!.states, (bp + id) * FIELDS) : G_ALL;
        this.masks[id] = mask;
        if (mask !== 0) changed++;
      } else if (inBase) removed++;
    }
    w.bits(changed, 5);
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const mask = this.masks[id]!;
      if (!this.inView[id] || mask === 0) continue;
      const inBase = bslot >= 0 && bl!.present[bp + id] === 1;
      w.bits(id, 5).bits(mask, 8);
      writeRemote(w, this.cur, id * FIELDS, mask, inBase ? bl!.states : null, (bp + id) * FIELDS);
    }
    w.bits(removed, 5);
    for (let id = 0; id < MAX_PLAYERS; id++) if (!this.inView[id] && bslot >= 0 && bl!.present[bp + id] === 1) w.bits(id, 5);

    // grenades in view (few, short-lived: always full), but not in smoke the client can't see into
    let grenades = 0;
    for (const g of game.grenades) if (this.sendsGrenade(g, view, viewer)) grenades++;
    w.bits(Math.min(grenades, 127), 7);
    let written = 0;
    for (const g of game.grenades) {
      if (!this.sendsGrenade(g, view, viewer) || written++ >= 127) continue;
      // the thrower, only if this client can see it: an exact arc and fuse work back to its hand
      w.unsigned(g.id, 6)
        .unsigned(pid(view === null || g.owner === viewer || this.seen(g.owner) ? g.owner : -1), 5)
        .signed(pos(g.x), 24)
        .signed(pos(g.y), 24)
        .signed(Math.round(g.vx * VEL_INV), 20)
        .signed(Math.round(g.vy * VEL_INV), 20)
        .unsigned(g.fuse, 8)
        .unsigned(g.type, 3)
        .unsigned(g.state, 2);
    }

    // items on the map in view, only when they changed: one that vanished or appeared out of view
    // would give away a hidden player taking it, or dying with a shield
    const items = pickupsInView(this.pickups, view, this.viewPickups);
    const pickupsChanged = bslot < 0 || !samePickups(items, 0, bl!.pickups, bslot * PICKUP_LIST);
    w.bool(pickupsChanged);
    if (pickupsChanged) {
      const n = items[0]!;
      w.bits(n, 6);
      for (let i = 0; i < n; i++) {
        const o = 1 + i * PICKUP_FIELDS;
        w.bits(items[o]!, 6).bits(items[o + 1]!, 6).signed(items[o + 2]!, 24).signed(items[o + 3]!, 24);
      }
    }

    // clouds in view (few, long-lived but tiny: always full)
    let clouds = 0;
    for (const c of game.clouds) if (c.alive && cloudInView(view, c.type, c.x, c.y)) clouds++;
    w.bits(Math.min(clouds, 31), 5);
    written = 0;
    for (const c of game.clouds) {
      if (!c.alive || !cloudInView(view, c.type, c.x, c.y) || written++ >= 31) continue;
      w.unsigned(c.id, 5).unsigned(c.type, 3).signed(pos(c.x), 24).signed(pos(c.y), 24).unsigned(c.age, 10);
    }

    // events: in view in full, gunfire/blasts outside as SOUND; own shots are drawn from prediction
    const extra = t.extraEvents ?? NO_EVENTS;
    let events = 0;
    for (const e of extra) if (this.eventKind(e, view, viewer) !== 0) events++;
    for (const e of this.events) if (this.eventKind(e, view, viewer) !== 0) events++;
    w.u8(Math.min(events, 255));
    written = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const e of pass === 0 ? extra : this.events) {
        const k = this.eventKind(e, view, viewer);
        if (k === 0 || written++ >= 255) continue;
        if (k === 3 && e.type === 'shot') this.writeClippedShot(w, e);
        else if (e.type === 'ricochet') this.writeRicochetFor(w, e, k, view, viewer);
        // a hidden attacker stays unnamed (as in HIT)
        else if (e.type === 'shieldBreak') writeShieldBreak(w, e.owner, view === null || this.showsAttacker(e, viewer) ? e.attacker : -1, e.x, e.y);
        // either side hidden from this client (off its view or in smoke): whole HP, since 1/16 HP and the
        // weapon's falloff give the range to centimetres; a hidden attacker also goes without its id
        else if (k === 1 && e.type === 'hit' && view !== null && !(this.sees(e.attacker, viewer) && this.sees(e.target, viewer)))
          writeHit(w, this.showsAttacker(e, viewer) ? e.attacker : -1, e.target, Math.round(e.damage), e.zone, e.source);
        // an item taken by a player this client can't see: no name (the item's still gone)
        else if (k === 1 && e.type === 'pickup' && view !== null && !this.sees(e.player, viewer)) writeEvent(w, { ...e, player: -1 });
        else if (k === 1 && e.type === 'explosion' && view !== null && e.owner !== viewer && !this.seen(e.owner)) writeExplosion(w, e.x, e.y, e.radius, -1, e.grenade ?? 0);
        else if (k === 1) writeEvent(w, e);
        else if (e.type === 'shot') writeSound(w, 'shot', e.weapon, e.ox, e.oy);
        else if (e.type === 'explosion') writeSound(w, 'explosion', GRENADE_SOURCE, e.x, e.y);
      }
    }

    // remember what this client now has
    if (bl) {
      const slot = this.seq & (SnapshotBaselines.SIZE - 1);
      bl.seqs[slot] = this.seq;
      const sp = slot * MAX_PLAYERS;
      for (let id = 0; id < MAX_PLAYERS; id++) {
        bl.present[sp + id] = this.inView[id]!;
        if (!this.inView[id]) continue;
        const from = id * FIELDS;
        const to = (sp + id) * FIELDS;
        for (let f = 0; f < FIELDS; f++) bl.states[to + f] = this.cur[from + f]!;
      }
      bl.hasLocal[slot] = t.local ? 1 : 0;
      if (t.local) bl.locals[slot]!.set(this.local);
      bl.pickups.set(items.subarray(0, 1 + items[0]! * PICKUP_FIELDS), slot * PICKUP_LIST);
    }
    return w.finish().slice();
  }

  /**
   * A visible player's shot that leaves the view, ends on a culled player or runs into smoke: only
   * the part inside the view (stopped BODY_REACH short of its edge when it ends on a player off the
   * view, so a hitbox poking into the rect isn't marked) and short of the smoke, with a culled
   * target's id blanked. A tracer cut short of its real end, or aimed at a culled player (lag comp
   * hits a pose up to 300 ms old), is sent as a miss with no target; one that hit a player smoke
   * hides goes on as if it had missed (`tracer`, carryOn). `lb` still holds this segment's clip
   * from the eventKind call just before.
   */
  private writeClippedShot(w: BitWriter, e: Extract<SimEvent, { type: 'shot' }>): void {
    const dx = tracer.ex - e.ox;
    const dy = tracer.ey - e.oy;
    const { t0, t1 } = lb;
    const cut = t1 < 1 || tracer.carried || (e.target >= 0 && !this.seen(e.target)); // cut short (the view's edge, smoke) or into the unseen: a miss
    writeShot(
      w,
      e.shooter,
      e.weapon,
      e.ox + t0 * dx,
      e.oy + t0 * dy,
      t1 < 1 ? e.ox + t1 * dx : tracer.ex,
      t1 < 1 ? e.oy + t1 * dy : tracer.ey,
      t1 < 1 ? 0 : tracer.carried ? tracer.hit : cut ? 0 : e.hit,
      cut ? -1 : e.target,
      cut ? 0 : e.zone,
    );
  }

  /** A shot or ricochet into a player smoke hides from this client: on as if it had missed (SmokeSight.carryOn). */
  private carryOn(ox: number, oy: number, ex: number, ey: number, weapon: number): void {
    this.sight.carryOn(ox, oy, ex, ey, weapon);
    tracer.ex = this.sight.missed.x;
    tracer.ey = this.sight.missed.y;
    tracer.hit = this.sight.missed.hit;
    tracer.carried = true;
  }

  /** Is `id` a player in view that smoke hides from this client (as opposed to one off its view)? */
  private smokeHidden(id: number, view: ViewRect): boolean {
    return id >= 0 && id < MAX_PLAYERS && this.present[id] === 1 && this.inView[id] === 0 && inRect(view, this.xs[id]!, this.ys[id]!);
  }

  /**
   * A ricochet off a shield in view (kind 1, or 3 when it ends on a culled player or leaves the
   * view: clipped like a shot, the culled target blanked). Its shooter is named only as in HIT.
   * A culled shooter's ricochet is the spark only (its point and normal, no line): mirrored, each
   * line points back at the shooter, and two of them cross where it stands. What it hit stays
   * blank unless that was you. `lb` holds this segment's clip from the eventKind call just before.
   */
  private writeRicochetFor(w: BitWriter, e: Extract<SimEvent, { type: 'ricochet' }>, kind: number, view: ViewRect | null, viewer: number): void {
    const shooter = view === null || e.shooter === viewer || e.owner === viewer || e.target === viewer || this.seen(e.shooter) ? e.shooter : -1;
    if (view !== null && e.shooter !== viewer && !this.seen(e.shooter)) {
      const toMe = viewer >= 0 && e.target === viewer;
      writeRicochet(w, e, shooter, e.x, e.y, toMe ? e.hit : 0, toMe ? e.target : -1, toMe ? e.zone : 0);
      return;
    }
    if (kind !== 3) {
      writeRicochet(w, e, shooter, e.ex, e.ey, e.hit, e.target, e.zone);
      return;
    }
    const t1 = lb.t1;
    const cut = t1 < 1 || tracer.carried || (e.target >= 0 && !this.seen(e.target));
    writeRicochet(
      w,
      e,
      shooter,
      t1 < 1 ? e.x + t1 * (tracer.ex - e.x) : tracer.ex,
      t1 < 1 ? e.y + t1 * (tracer.ey - e.y) : tracer.ey,
      t1 < 1 ? 0 : tracer.carried ? tracer.hit : cut ? 0 : e.hit,
      cut ? -1 : e.target,
      cut ? 0 : e.zone,
    );
  }

  private seen(id: number): boolean {
    return id >= 0 && id < MAX_PLAYERS && this.inView[id] === 1;
  }

  /** Nobody (the world), the client itself, or a player it's sent. */
  private sees(id: number, viewer: number): boolean {
    return id < 0 || id === viewer || this.seen(id);
  }

  /**
   * A grenade goes to a client when it's in view and not in smoke the client can't see into: a
   * grenade thrown from inside a cloud would give its thrower away from the first tick (its exact
   * position, velocity and fuse work back to the hand). The client's own always go.
   */
  private sendsGrenade(g: Game['grenades'][number], view: ViewRect | null, viewer: number): boolean {
    if (!g.alive) return false;
    if (view === null) return true;
    if (!inRect(view, g.x, g.y) || (this.blind && g.owner !== viewer)) return false;
    return (viewer >= 0 && g.owner === viewer) || !this.sight.pointHidden(viewer, g.x, g.y);
  }

  /** A HIT names its attacker to the attacker, the victim, and clients that can see the attacker. */
  private showsAttacker(e: { attacker: number; target?: number; owner?: number }, viewer: number): boolean {
    return e.attacker < 0 || e.attacker === viewer || (e.target ?? e.owner) === viewer || this.seen(e.attacker);
  }

  /**
   * Smoke (anti-wallhack): a line from (ox, oy) to `tracer`'s end vanishes where it enters smoke the
   * viewer can't see into, as a miss with no target, whatever it hit in there (`lb` holds its clip;
   * cut it shorter). The cut doesn't tell a hit from a miss: both stop at the same place.
   */
  private smokeCut(ox: number, oy: number, viewer: number, kind: number): number {
    const t = this.sight.tracerCut(viewer, ox, oy, tracer.ex, tracer.ey);
    if (t >= lb.t1) return kind;
    lb.t1 = Math.max(lb.t0, t);
    return 3;
  }

  /** 0 = not sent to this client, 1 = in full, 2 = as a SOUND event, 3 = clipped (writeClippedShot) */
  private eventKind(e: SimEvent, view: ViewRect | null, viewer: number): number {
    switch (e.type) {
      case 'throw':
        return 0;
      case 'pickup':
        return view === null || e.player === viewer || inRect(view, e.x, e.y) ? 1 : 0;
      case 'shieldBreak':
        return view === null || e.owner === viewer || this.seen(e.owner) ? 1 : 0;
      case 'ricochet': {
        // the spark and its line, from a shield in view; sent to the shooter too (its own shots aren't
        // echoed, but it can't predict other players' shields). One ending on a culled player, or
        // leaving the view, is clipped like a shot (3)
        if (view === null) return 1;
        if (!inRect(view, e.x, e.y)) return 0;
        // off the shield of a player smoke hides: the spark would mark it
        if (e.owner !== viewer && this.smokeHidden(e.owner, view)) return 0;
        tracer.ex = e.ex;
        tracer.ey = e.ey;
        tracer.carried = false;
        if ((e.hit === 2 || e.hit === 3) && this.smokeHidden(e.target, view)) {
          // into a player smoke hides: on past it as a miss, then cut like any other line
          this.carryOn(e.x, e.y, e.ex, e.ey, e.weapon);
          segmentInRect(view, e.x, e.y, tracer.ex, tracer.ey);
          return this.smokeCut(e.x, e.y, viewer, 3);
        }
        if ((e.hit === 2 || e.hit === 3) && e.target >= 0 && !this.seen(e.target)) {
          const v = this.inset;
          v.minX = view.minX + BODY_REACH;
          v.minY = view.minY + BODY_REACH;
          v.maxX = view.maxX - BODY_REACH;
          v.maxY = view.maxY - BODY_REACH;
          if (!segmentInRect(v, e.x, e.y, e.ex, e.ey)) lb.t0 = lb.t1 = 0;
          return this.smokeCut(e.x, e.y, viewer, 3);
        }
        segmentInRect(view, e.x, e.y, e.ex, e.ey);
        return this.smokeCut(e.x, e.y, viewer, lb.t1 < 1 ? 3 : 1);
      }
      case 'shot': {
        if (viewer >= 0 && e.shooter === viewer) return 0;
        if (view === null) return 1;
        // a culled shooter's tracer would locate it: its line (two of them cross at the muzzle) and,
        // with the weapon's range, its end. Only the coarse SOUND
        if (e.shooter >= 0 && !this.seen(e.shooter)) return 2;
        tracer.ex = e.ex;
        tracer.ey = e.ey;
        tracer.carried = false;
        if ((e.hit === 2 || e.hit === 3) && this.smokeHidden(e.target, view)) {
          // into a player (or its shield) smoke hides: on past it as a miss, then cut like any other tracer
          this.carryOn(e.ox, e.oy, e.ex, e.ey, e.weapon);
          if (!segmentInRect(view, e.ox, e.oy, tracer.ex, tracer.ey)) return 2;
          return this.smokeCut(e.ox, e.oy, viewer, 3);
        }
        // a tracer ending on a culled player's body or shield (hit 3) stops short of it
        if ((e.hit === 2 || e.hit === 3) && e.target >= 0 && !this.seen(e.target)) {
          const v = this.inset;
          v.minX = view.minX + BODY_REACH;
          v.minY = view.minY + BODY_REACH;
          v.maxX = view.maxX - BODY_REACH;
          v.maxY = view.maxY - BODY_REACH;
          // nothing of it inside the shrunk view (all in the off-screen margin): a zero-length miss at
          // the visible shooter's muzzle, so whether anything arrives doesn't tell a hit from a miss
          if (!segmentInRect(v, e.ox, e.oy, e.ex, e.ey)) lb.t0 = lb.t1 = 0;
          return this.smokeCut(e.ox, e.oy, viewer, 3);
        }
        if (!segmentInRect(view, e.ox, e.oy, e.ex, e.ey)) return 2;
        return this.smokeCut(e.ox, e.oy, viewer, lb.t0 > 0 || lb.t1 < 1 ? 3 : 1);
      }
      case 'explosion':
        return view === null || inRect(view, e.x, e.y) ? 1 : 2;
      case 'hit':
        // hit markers for the attacker, damage numbers over targets in view (and not hidden in smoke)
        if (view === null || e.attacker === viewer || e.target === viewer) return 1;
        return this.seen(e.target) ? 1 : 0;
      case 'death':
      case 'spawn':
      case 'mapEvent':
        return 1;
      case 'dash':
        // your own dash is drawn from prediction; others' only when you can see them
        if (viewer >= 0 && e.player === viewer) return 0;
        return view === null || this.seen(e.player) ? 1 : 0;
    }
  }
}

const NO_EVENTS: readonly SimEvent[] = [];
const sharedEncoder = new SnapshotEncoder();

/** Convenience full snapshot for one client (tests, tools): no baseline, no AOI. */
export function encodeSnapshot(
  game: Game,
  seq: number,
  events: readonly SimEvent[],
  client: { ackInputTick?: number; inputBufferHealth?: number; local?: PlayerState | null; view?: ViewRect | null } = {},
): Uint8Array {
  sharedEncoder.begin(game, seq, events);
  return sharedEncoder.encodeFor({
    baselines: null,
    ackInputTick: client.ackInputTick ?? ((game.tick - 1) & 0xffff),
    inputBufferHealth: client.inputBufferHealth ?? -128,
    local: client.local ?? null,
    view: client.view ?? null,
  });
}

// ---------- client side ----------

/**
 * Decodes snapshots, keeping the last 64 to resolve deltas. A snapshot whose baseline isn't held
 * throws DecodeError (don't ack it; the server falls back to an older baseline or a full one).
 */
export class SnapshotDecoder {
  static readonly SIZE = 64;
  private readonly seqs = new Int32Array(SnapshotDecoder.SIZE).fill(-1);
  private readonly present = new Uint8Array(SnapshotDecoder.SIZE * MAX_PLAYERS);
  private readonly states = new Int32Array(SnapshotDecoder.SIZE * MAX_PLAYERS * FIELDS);
  private readonly locals: (LocalState | null)[] = new Array<LocalState | null>(SnapshotDecoder.SIZE).fill(null);
  /** each snapshot's items (shared, never mutated: an unchanged list is the baseline's array) */
  private readonly pickups: SnapshotPickup[][] = new Array<SnapshotPickup[]>(SnapshotDecoder.SIZE).fill([]);
  private readonly pickupList = new Int32Array(PICKUP_LIST);
  private readonly nowPresent = new Uint8Array(MAX_PLAYERS);
  private readonly nowStates = new Int32Array(MAX_PLAYERS * FIELDS);
  private readonly reader = new BitReader(new Uint8Array(0));

  /** Forget all baselines (e.g. after reconnecting). */
  reset(): void {
    this.seqs.fill(-1);
  }

  decode(bytes: Uint8Array): SnapshotMsg {
    const r = this.reader.reset(bytes);
    if (r.remainingBits < 8 || r.u8() !== MsgType.Snapshot) throw new DecodeError('not a SNAPSHOT');
    const seq = r.u16();
    const serverTick = r.u32();
    const ackInputTick = r.u16();
    const inputBufferHealth = r.signed(8);
    const baselineSeq = r.u16();
    const hasLocal = r.bool();
    let bslot = -1;
    if (baselineSeq !== 0) {
      bslot = baselineSeq & (SnapshotDecoder.SIZE - 1);
      if (this.seqs[bslot] !== baselineSeq) throw new DecodeError(`missing baseline ${baselineSeq}`);
    }
    const baseLocal = bslot >= 0 ? this.locals[bslot]! : null;
    let local: LocalState | null = null;
    if (hasLocal) local = baseLocal ? readLocalStateDelta(r, baseLocal, createLocalState()) : readLocalState(r, createLocalState());

    // start from the baseline's players, apply changes and removals
    const now = this.nowStates;
    if (bslot >= 0) {
      this.nowPresent.set(this.present.subarray(bslot * MAX_PLAYERS, bslot * MAX_PLAYERS + MAX_PLAYERS));
      now.set(this.states.subarray(bslot * MAX_PLAYERS * FIELDS, (bslot + 1) * MAX_PLAYERS * FIELDS));
    } else {
      this.nowPresent.fill(0);
      now.fill(0);
    }
    const changed = r.bits(5);
    for (let k = 0; k < changed; k++) {
      const id = r.bits(5);
      if (id >= MAX_PLAYERS) throw new DecodeError(`player id ${id} out of range`);
      const mask = r.bits(8);
      if (!this.nowPresent[id]) {
        if (mask !== G_ALL) throw new DecodeError(`partial record for new player ${id}`);
        now.fill(0, id * FIELDS, id * FIELDS + FIELDS);
      }
      readRemote(r, now, id * FIELDS, mask);
      this.nowPresent[id] = 1;
    }
    const removed = r.bits(5);
    for (let k = 0; k < removed; k++) {
      const id = r.bits(5);
      if (id >= MAX_PLAYERS) throw new DecodeError(`player id ${id} out of range`);
      this.nowPresent[id] = 0;
    }

    const grenades: SnapshotGrenade[] = [];
    const grenadeCount = r.bits(7);
    for (let i = 0; i < grenadeCount; i++) {
      grenades.push({
        id: r.bits(6),
        owner: unPid(r.bits(5)),
        x: r.signed(24) / POS_INV,
        y: r.signed(24) / POS_INV,
        vx: r.signed(20) / VEL_INV,
        vy: r.signed(20) / VEL_INV,
        fuse: r.bits(8),
        type: r.bits(3),
        state: r.bits(2),
      });
    }
    let pickups: SnapshotPickup[];
    if (r.bool()) {
      const list = this.pickupList;
      const n = r.bits(6);
      if (n > MAX_PICKUPS) throw new DecodeError(`${n} pickups`);
      list[0] = n;
      for (let i = 0; i < n; i++) {
        const o = 1 + i * PICKUP_FIELDS;
        list[o] = r.bits(6);
        list[o + 1] = r.bits(6);
        list[o + 2] = r.signed(24);
        list[o + 3] = r.signed(24);
      }
      pickups = toPickups(list);
    } else if (bslot >= 0) pickups = this.pickups[bslot]!;
    else throw new DecodeError('a full snapshot must carry its pickups');
    const clouds: SnapshotCloud[] = [];
    const cloudCount = r.bits(5);
    for (let i = 0; i < cloudCount; i++) {
      clouds.push({ id: r.bits(5), type: r.bits(3), x: r.signed(24) / POS_INV, y: r.signed(24) / POS_INV, age: r.bits(10) });
    }

    const events: SnapshotEvent[] = [];
    const eventCount = r.u8();
    for (let i = 0; i < eventCount; i++) events.push(readEvent(r));

    // keep it as a baseline for later snapshots
    const slot = seq & (SnapshotDecoder.SIZE - 1);
    this.seqs[slot] = seq;
    this.present.set(this.nowPresent, slot * MAX_PLAYERS);
    this.states.set(now, slot * MAX_PLAYERS * FIELDS);
    this.locals[slot] = local ? local.slice() : null;
    this.pickups[slot] = pickups;

    const players: SnapshotPlayer[] = [];
    for (let id = 0; id < MAX_PLAYERS; id++) if (this.nowPresent[id]) players.push(toSnapshotPlayer(id, now, id * FIELDS));
    return { type: MsgType.Snapshot, seq, serverTick, ackInputTick, inputBufferHealth, baselineSeq, local, players, grenades, pickups, clouds, events };
  }
}


const statelessDecoder = new SnapshotDecoder();

/** Decodes a full snapshot without keeping state (decodeMessage, tests). Deltas throw. */
export function decodeFullSnapshot(bytes: Uint8Array): SnapshotMsg {
  statelessDecoder.reset();
  return statelessDecoder.decode(bytes);
}
