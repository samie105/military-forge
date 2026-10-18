/**
 * The local-player block of a snapshot (docs/05 §6.2, §8): every PlayerState field the movement,
 * weapon and regen sim reads from one tick to the next, as the exact quantised integers.
 *
 * Client prediction stores the same integers for each predicted tick, so reconciliation is an
 * integer compare (no epsilon), and applying a server block then re-simulating reproduces the
 * server bit-for-bit. Fields the sim can't distinguish beyond a point are normalised identically
 * on both sides: jetTicks only matters while ≤ jetKickTicks, ticksSinceShot only past 6, and the
 * ground normal/flags are only read while grounded (zero in the air).
 *
 * Fields are grouped; a snapshot with a baseline sends only the groups that changed since it.
 */
import { GRENADE_TYPES, NO_WEAPON } from '@military-forge/content';
import { POS_INV, SCALAR_INV, VEL_INV } from '@military-forge/shared';
import type { PlayerState, WeaponSlot } from '@military-forge/sim';
import type { BitReader, BitWriter } from './bitstream';

/** One fixed-point integer per field, in wire order. */
export type LocalState = Int32Array;

/** Field indices (grouped: each group is a contiguous range, see GROUPS). */
export const LS = {
  // kinematics
  x: 0,
  y: 1,
  vx: 2,
  vy: 3,
  // ground
  grounded: 4,
  groundNx: 5,
  groundNy: 6,
  groundFlags: 7,
  crouched: 8,
  downHeldTicks: 9,
  dropTicks: 10,
  // jetpack
  jetting: 11,
  jetTicks: 12,
  fuel: 13,
  fuelRegenDelay: 14,
  // life
  alive: 15,
  respawnTicks: 16,
  hp: 17,
  regenDelay: 18,
  // combat
  active: 19,
  dual: 20,
  swapTicks: 21,
  frags: 22,
  throwCooldown: 23,
  shotCounter: 24,
  prevButtons: 25,
  // weapon slots
  slot0: 26,
  slot1: 33,
  // melee (arsenal, v6): appended after the slots in its own group, so nothing above moved.
  // The swing timer drives the lunge and gates firing, so prediction needs it.
  meleeTicks: 40,
  // dash (v8, docs/02 §21): its own group after melee
  dashTicks: 41,
  dashDir: 42,
  dashCooldown: 43,
  airDashUsed: 44,
  // riot shield (v9), its own group after the dash: the carry mode and raise timer set the speed
  // and what the shield key does, so prediction needs them. HP is the server's (bullets), but it
  // rides along.
  shieldHp: 45,
  shieldStowed: 46,
  shieldTicks: 47,
  // grenade belt (arsenal B, v10): the selected type and the counts of types 1…5 (frags stay in
  // `frags` above). Cycling and throwing are predicted.
  grenadeType: 48,
  grenades: 49,
  // status effects (arsenal B, v10): flashbang blindness, the gas cough, a dead jetpack (EMP).
  // They count down every tick, so prediction stays exact after the server's first word on them.
  blindTicks: 54,
  blindFade: 55,
  gasTicks: 56,
  jetDisabledTicks: 57,
  // weapon handling (v11, the owner's more guns): a minigun's spin and a burst rifle's rounds left,
  // per slot. Prediction fires on them, so they travel; they rest at 0 for every other gun.
  spin0: 58,
  burst0: 59,
  spin1: 60,
  burst1: 61,
} as const;

/** Offsets inside a weapon slot. */
export const LS_SLOT = { def: 0, mag: 1, reserve: 2, cooldown: 3, reloadTicks: 4, bloom: 5, ticksSinceShot: 6 } as const;
const SLOT_FIELDS = 7;

export const LOCAL_STATE_FIELDS = LS.burst1 + 1;

/** grenade types whose counts travel in the grenade group (type 0, the frag, is `frags`) */
const OTHER_GRENADES = GRENADE_TYPES - 1;
if (LS.grenades + OTHER_GRENADES !== LS.blindTicks) throw new Error('local state: the grenade group must hold every type');

/** [start, end) field ranges sent as a unit in delta snapshots. */
const GROUPS: readonly (readonly [number, number])[] = [
  [LS.x, LS.grounded],
  [LS.grounded, LS.jetting],
  [LS.jetting, LS.alive],
  [LS.alive, LS.active],
  [LS.active, LS.slot0],
  [LS.slot0, LS.slot1],
  [LS.slot1, LS.meleeTicks],
  [LS.meleeTicks, LS.dashTicks],
  [LS.dashTicks, LS.shieldHp],
  [LS.shieldHp, LS.grenadeType],
  [LS.grenadeType, LS.blindTicks],
  [LS.blindTicks, LS.spin0],
  [LS.spin0, LOCAL_STATE_FIELDS],
];

/** Ground normals are quantised to 1/65536 by the sim (quantizeMovement). */
const NORMAL_INV = 65536;
/** Raw int32 (shotCounter feeds the spread seed, so it must round-trip exactly). */
const RAW32 = 32;

// Bit widths in field order: positive = unsigned, negative = signed two's complement.
const SLOT_BITS = [6, 8, 10, 18, 10, 14, 7]; // def, mag, reserve, cooldown (1/1024 tick), reloadTicks, bloom (1/1024 °), ticksSinceShot (≤ 127)
const BITS: readonly number[] = [
  -24, -24, -20, -20, // x, y (1/1024 m), vx, vy (1/1024 m/s)
  1, -18, -18, 3, 1, 8, 8, // grounded, groundNx, groundNy (1/65536), groundFlags, crouched, downHeldTicks, dropTicks
  1, 6, 20, 10, // jetting, jetTicks (≤ 63), fuel (1/1024), fuelRegenDelay
  1, 10, 18, 10, // alive, respawnTicks, hp (1/1024), regenDelay
  1, 1, 8, 3, 8, RAW32, 16, // active, dual, swapTicks, frags, throwCooldown, shotCounter, prevButtons
  ...SLOT_BITS,
  ...SLOT_BITS,
  6, // meleeTicks (a swing lasts ≤ 0.6 s = 36 ticks)
  6, 3, 8, 1, // dashTicks (≤ 63), dashDir (8-way), dashCooldown (≤ 255 ticks), airDashUsed
  19, 1, 5, // shieldHp (1/1024, ≤ 300), shieldStowed, shieldTicks (≤ raise time, 15)
  3, ...new Array<number>(OTHER_GRENADES).fill(3), // grenadeType, counts (≤ 7)
  8, 7, 6, 8, // blindTicks (≤ 4.25 s), blindFade (≤ 2.1 s), gasTicks (≤ 1 s), jetDisabledTicks (≤ 4.25 s)
  8, 2, 8, 2, // spin0 (≤ SPIN_FULL 240), burst0 (≤ 3), spin1, burst1
];

if (BITS.length !== LOCAL_STATE_FIELDS) throw new Error('local state layout out of sync');

/** Wire size of a full block (both weapon slots armed, grounded). */
export const LOCAL_STATE_MAX_BITS = BITS.reduce((a, b) => a + Math.abs(b), 0);

export function createLocalState(): LocalState {
  return new Int32Array(LOCAL_STATE_FIELDS);
}

/** Clamps to the field's wire range so captured history equals what the decoder will produce. */
function fit(value: number, bits: number): number {
  if (bits === RAW32) return value | 0;
  if (bits > 0) return Math.max(0, Math.min((1 << bits) - 1, value));
  const half = 1 << (-bits - 1);
  return Math.max(-half, Math.min(half - 1, value));
}

const fx = (v: number, inv: number) => Math.round(v * inv);

function captureSlot(slot: WeaponSlot, out: LocalState, base: number): void {
  if (slot.def === NO_WEAPON) {
    out[base] = NO_WEAPON;
    out.fill(0, base + 1, base + SLOT_FIELDS);
    return;
  }
  out[base + LS_SLOT.def] = slot.def;
  out[base + LS_SLOT.mag] = slot.mag;
  out[base + LS_SLOT.reserve] = slot.reserve;
  out[base + LS_SLOT.cooldown] = fx(slot.cooldown, SCALAR_INV);
  out[base + LS_SLOT.reloadTicks] = slot.reloadTicks;
  out[base + LS_SLOT.bloom] = fx(slot.bloom, SCALAR_INV);
  out[base + LS_SLOT.ticksSinceShot] = slot.ticksSinceShot;
}

/** PlayerState → integers (clamped to the wire ranges). */
export function captureLocalState(p: PlayerState, out: LocalState): LocalState {
  out[LS.x] = fx(p.x, POS_INV);
  out[LS.y] = fx(p.y, POS_INV);
  out[LS.vx] = fx(p.vx, VEL_INV);
  out[LS.vy] = fx(p.vy, VEL_INV);
  out[LS.grounded] = p.grounded ? 1 : 0;
  // only read while grounded (landing sets them again)
  out[LS.groundNx] = p.grounded ? fx(p.groundNx, NORMAL_INV) : 0;
  out[LS.groundNy] = p.grounded ? fx(p.groundNy, NORMAL_INV) : 0;
  out[LS.groundFlags] = p.grounded ? p.groundFlags : 0;
  out[LS.crouched] = p.crouched ? 1 : 0;
  out[LS.downHeldTicks] = p.downHeldTicks;
  out[LS.dropTicks] = p.dropTicks;
  out[LS.jetting] = p.jetting ? 1 : 0;
  out[LS.jetTicks] = p.jetTicks;
  out[LS.fuel] = fx(p.fuel, SCALAR_INV);
  out[LS.fuelRegenDelay] = p.fuelRegenDelay;
  out[LS.alive] = p.alive ? 1 : 0;
  out[LS.respawnTicks] = p.respawnTicks;
  out[LS.hp] = fx(p.hp, SCALAR_INV);
  out[LS.regenDelay] = p.regenDelay;
  out[LS.active] = p.active;
  out[LS.dual] = p.dual ? 1 : 0;
  out[LS.swapTicks] = p.swapTicks;
  out[LS.frags] = p.frags;
  out[LS.throwCooldown] = p.throwCooldown;
  out[LS.shotCounter] = p.shotCounter;
  out[LS.prevButtons] = p.prevButtons;
  captureSlot(p.weapons[0], out, LS.slot0);
  captureSlot(p.weapons[1], out, LS.slot1);
  out[LS.meleeTicks] = p.meleeTicks;
  out[LS.dashTicks] = p.dashTicks;
  // the direction only matters during a burst: normalised to 0 otherwise, like the ground normal
  out[LS.dashDir] = p.dashTicks > 0 ? p.dashDir : 0;
  out[LS.dashCooldown] = p.dashCooldown;
  out[LS.airDashUsed] = p.airDashUsed ? 1 : 0;
  out[LS.shieldHp] = fx(p.shieldHp, SCALAR_INV);
  out[LS.shieldStowed] = p.shieldStowed ? 1 : 0;
  out[LS.shieldTicks] = p.shieldTicks;
  out[LS.grenadeType] = p.grenadeType;
  for (let i = 0; i < OTHER_GRENADES; i++) out[LS.grenades + i] = p.grenadeCounts[i + 1]!;
  out[LS.blindTicks] = p.blindTicks;
  out[LS.blindFade] = p.blindFade;
  out[LS.gasTicks] = p.gasTicks;
  out[LS.jetDisabledTicks] = p.jetDisabledTicks;
  out[LS.spin0] = p.weapons[0].spin;
  out[LS.burst0] = p.weapons[0].burst;
  out[LS.spin1] = p.weapons[1].spin;
  out[LS.burst1] = p.weapons[1].burst;
  for (let i = 0; i < LOCAL_STATE_FIELDS; i++) out[i] = fit(out[i]!, BITS[i]!);
  return out;
}

function applySlot(s: LocalState, base: number, slot: WeaponSlot): void {
  slot.def = s[base + LS_SLOT.def]!;
  slot.mag = s[base + LS_SLOT.mag]!;
  slot.reserve = s[base + LS_SLOT.reserve]!;
  slot.cooldown = s[base + LS_SLOT.cooldown]! / SCALAR_INV;
  slot.reloadTicks = s[base + LS_SLOT.reloadTicks]!;
  slot.bloom = s[base + LS_SLOT.bloom]! / SCALAR_INV;
  slot.ticksSinceShot = s[base + LS_SLOT.ticksSinceShot]!;
}

/** Integers → PlayerState (the inverse of captureLocalState for everything the sim reads). */
export function applyLocalState(s: LocalState, p: PlayerState): void {
  p.x = s[LS.x]! / POS_INV;
  p.y = s[LS.y]! / POS_INV;
  p.prevY = p.y;
  p.vx = s[LS.vx]! / VEL_INV;
  p.vy = s[LS.vy]! / VEL_INV;
  p.grounded = s[LS.grounded] === 1;
  p.groundNx = s[LS.groundNx]! / NORMAL_INV;
  p.groundNy = s[LS.groundNy]! / NORMAL_INV;
  p.groundFlags = s[LS.groundFlags]!;
  p.crouched = s[LS.crouched] === 1;
  p.downHeldTicks = s[LS.downHeldTicks]!;
  p.dropTicks = s[LS.dropTicks]!;
  p.jetting = s[LS.jetting] === 1;
  p.jetTicks = s[LS.jetTicks]!;
  p.fuel = s[LS.fuel]! / SCALAR_INV;
  p.fuelRegenDelay = s[LS.fuelRegenDelay]!;
  p.alive = s[LS.alive] === 1;
  p.respawnTicks = s[LS.respawnTicks]!;
  p.hp = s[LS.hp]! / SCALAR_INV;
  p.regenDelay = s[LS.regenDelay]!;
  p.active = s[LS.active]!;
  p.dual = s[LS.dual] === 1;
  p.swapTicks = s[LS.swapTicks]!;
  p.frags = s[LS.frags]!;
  p.throwCooldown = s[LS.throwCooldown]!;
  p.shotCounter = s[LS.shotCounter]!;
  p.prevButtons = s[LS.prevButtons]!;
  applySlot(s, LS.slot0, p.weapons[0]);
  applySlot(s, LS.slot1, p.weapons[1]);
  p.meleeTicks = s[LS.meleeTicks]!;
  p.dashTicks = s[LS.dashTicks]!;
  p.dashDir = s[LS.dashDir]!;
  p.dashCooldown = s[LS.dashCooldown]!;
  p.airDashUsed = s[LS.airDashUsed] === 1;
  p.shieldHp = s[LS.shieldHp]! / SCALAR_INV;
  p.shieldStowed = s[LS.shieldStowed] === 1;
  p.shieldTicks = s[LS.shieldTicks]!;
  p.grenadeType = s[LS.grenadeType]!;
  for (let i = 0; i < OTHER_GRENADES; i++) p.grenadeCounts[i + 1] = s[LS.grenades + i]!;
  p.blindTicks = s[LS.blindTicks]!;
  p.blindFade = s[LS.blindFade]!;
  p.gasTicks = s[LS.gasTicks]!;
  p.jetDisabledTicks = s[LS.jetDisabledTicks]!;
  p.weapons[0].spin = s[LS.spin0]!;
  p.weapons[0].burst = s[LS.burst0]!;
  p.weapons[1].spin = s[LS.spin1]!;
  p.weapons[1].burst = s[LS.burst1]!;
}

export function localStatesEqual(a: LocalState, b: LocalState): boolean {
  for (let i = 0; i < LOCAL_STATE_FIELDS; i++) if (a[i] !== b[i]) return false;
  return true;
}

const NAMES: string[] = [];
for (const [k, v] of Object.entries(LS)) if (!k.startsWith('slot')) NAMES[v] = k;
for (let i = 0; i < OTHER_GRENADES; i++) NAMES[LS.grenades + i] = `grenades[${i + 1}]`;
for (const [k, v] of Object.entries(LS_SLOT)) {
  NAMES[LS.slot0 + v] = `w0.${k}`;
  NAMES[LS.slot1 + v] = `w1.${k}`;
}

/** "x: 9410→9411, fuel: …" for logs and test failures. Empty when equal. */
export function describeLocalDiff(predicted: LocalState, server: LocalState): string {
  const out: string[] = [];
  for (let i = 0; i < LOCAL_STATE_FIELDS; i++) if (predicted[i] !== server[i]) out.push(`${NAMES[i]}: ${predicted[i]}→${server[i]}`);
  return out.join(', ');
}

/** Fields the encoder skips after field i (they're zero): ground details in the air, empty slots, no shield. */
function skipAfter(i: number, v: number): number {
  if (i === LS.grounded && v === 0) return LS.groundFlags - LS.grounded;
  if ((i === LS.slot0 || i === LS.slot1) && v === NO_WEAPON) return SLOT_FIELDS - 1;
  if (i === LS.shieldHp && v === 0) return LS.shieldTicks - LS.shieldHp;
  return 0;
}

function writeRange(w: BitWriter, s: LocalState, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const bits = BITS[i]!;
    const v = s[i]!;
    if (bits === RAW32) w.bits(v >>> 0, 32);
    else if (bits > 0) w.bits(v, bits);
    else w.signed(v, -bits);
    i += skipAfter(i, v);
  }
}

function readRange(r: BitReader, out: LocalState, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const bits = BITS[i]!;
    out[i] = bits === RAW32 ? r.u32() | 0 : bits > 0 ? r.bits(bits) : r.signed(-bits);
    const skip = skipAfter(i, out[i]!);
    if (skip > 0) {
      out.fill(0, i + 1, i + 1 + skip);
      i += skip;
    }
  }
}

export function writeLocalState(w: BitWriter, s: LocalState): void {
  writeRange(w, s, 0, LOCAL_STATE_FIELDS);
}

export function readLocalState(r: BitReader, out: LocalState): LocalState {
  readRange(r, out, 0, LOCAL_STATE_FIELDS);
  return out;
}

/** Only the groups that differ from `base` (the block in the client's acked baseline snapshot). */
export function writeLocalStateDelta(w: BitWriter, s: LocalState, base: LocalState): void {
  let mask = 0;
  for (let g = 0; g < GROUPS.length; g++) {
    const [a, b] = GROUPS[g]!;
    for (let i = a; i < b; i++) {
      if (s[i] !== base[i]) {
        mask |= 1 << g;
        break;
      }
    }
  }
  w.bits(mask, GROUPS.length);
  for (let g = 0; g < GROUPS.length; g++) if (mask & (1 << g)) writeRange(w, s, GROUPS[g]![0], GROUPS[g]![1]);
}

export function readLocalStateDelta(r: BitReader, base: LocalState, out: LocalState): LocalState {
  out.set(base);
  const mask = r.bits(GROUPS.length);
  for (let g = 0; g < GROUPS.length; g++) if (mask & (1 << g)) readRange(r, out, GROUPS[g]![0], GROUPS[g]![1]);
  return out;
}
