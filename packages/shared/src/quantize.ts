/**
 * Quantisation helpers (docs/02 §15). Authoritative state is snapped to network precision at
 * the end of every tick on BOTH client and server, so a snapshot reconstructs the server state
 * bit-for-bit and client re-simulation starts from identical numbers.
 *
 * Steps are powers of two, so every quantised value is exactly representable as a float.
 *
 * Phase 0 note: docs/02 proposed 1/128 m positions. Rounding the absolute position every tick at
 * that resolution biases speed (5 m/s becomes ~5.16 m/s) and freezes anything slower than
 * ~0.23 m/s, so positions and velocities use 1/1024 instead (~0.4% worst-case speed error).
 */

/** Inverse step for positions (m) and velocities (m/s): 1/1024. */
export const POS_INV = 1024;
export const VEL_INV = 1024;
/** Inverse step for scalar resources (fuel, HP) and fractional timers. */
export const SCALAR_INV = 1024;

/** Rounds `value` to the nearest multiple of 1/inv. Never returns −0. */
export function quantize(value: number, inv: number): number {
  return Math.round(value * inv) / inv + 0;
}

/** Fixed-point integer for the wire: round(value · inv). */
export function toFixed(value: number, inv: number): number {
  return Math.round(value * inv) | 0;
}

export function fromFixed(fixed: number, inv: number): number {
  return fixed / inv;
}

const TAU = 6.283185307179586;

/** Radians → u16 (0..65535 ↔ 0..2π). */
export function angleToU16(rad: number): number {
  const turns = rad / TAU;
  const u = Math.round((turns - Math.floor(turns)) * 65536);
  return u === 65536 ? 0 : u;
}

/** u16 → radians in (−π, π]. */
export function u16ToAngle(u: number): number {
  const a = ((u & 0xffff) * TAU) / 65536;
  return a > 3.141592653589793 ? a - TAU : a;
}
