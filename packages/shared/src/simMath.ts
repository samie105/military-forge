/**
 * Deterministic transcendental functions for the sim (docs/02 §15).
 *
 * Math.sin/cos/atan2/exp are allowed to differ in the last bits between V8, JavaScriptCore
 * and SpiderMonkey. These versions use only + − × ÷, Math.round/abs/sqrt (all IEEE-exact),
 * so they return bit-identical results everywhere. Accuracy is ~1e-10, far below anything
 * the game can perceive.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const DEG2RAD = PI / 180;
export const RAD2DEG = 180 / PI;

// π/2 split into a high part with trailing zero bits and a low correction (Cody–Waite reduction).
const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;
const INV_PIO2 = 0.6366197723675814;

const S3 = -1 / 6;
const S5 = 1 / 120;
const S7 = -1 / 5040;
const S9 = 1 / 362880;
const S11 = -1 / 39916800;

const C2 = -1 / 2;
const C4 = 1 / 24;
const C6 = -1 / 720;
const C8 = 1 / 40320;
const C10 = -1 / 3628800;
const C12 = 1 / 479001600;

/** sin on |r| ≤ π/4 */
function kernelSin(r: number): number {
  const r2 = r * r;
  return r + r * r2 * (S3 + r2 * (S5 + r2 * (S7 + r2 * (S9 + r2 * S11))));
}

/** cos on |r| ≤ π/4 */
function kernelCos(r: number): number {
  const r2 = r * r;
  return 1 + r2 * (C2 + r2 * (C4 + r2 * (C6 + r2 * (C8 + r2 * (C10 + r2 * C12)))));
}

export function simSin(x: number): number {
  const k = Math.round(x * INV_PIO2);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  switch (k & 3) {
    case 0:
      return kernelSin(r);
    case 1:
      return kernelCos(r);
    case 2:
      return -kernelSin(r);
    default:
      return -kernelCos(r);
  }
}

export function simCos(x: number): number {
  const k = Math.round(x * INV_PIO2);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  switch ((k + 1) & 3) {
    case 0:
      return kernelSin(r);
    case 1:
      return kernelCos(r);
    case 2:
      return -kernelSin(r);
    default:
      return -kernelCos(r);
  }
}

/** Writes [cos, sin] of `x` into `out` without allocating. */
export function simCosSin(x: number, out: { x: number; y: number }): void {
  const k = Math.round(x * INV_PIO2);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  const s = kernelSin(r);
  const c = kernelCos(r);
  switch (k & 3) {
    case 0:
      out.x = c;
      out.y = s;
      break;
    case 1:
      out.x = -s;
      out.y = c;
      break;
    case 2:
      out.x = -c;
      out.y = -s;
      break;
    default:
      out.x = s;
      out.y = -c;
  }
}

const TAN_PI_12 = 0.2679491924311227; // 2 − √3
const SQRT3 = 1.7320508075688772;
const PI_6 = PI / 6;

/** atan on |t| ≤ 2 − √3 (Taylor, error ~1e-11) */
function atanKernel(t: number): number {
  const t2 = t * t;
  return t * (1 + t2 * (-1 / 3 + t2 * (1 / 5 + t2 * (-1 / 7 + t2 * (1 / 9 + t2 * (-1 / 11 + t2 * (1 / 13 - t2 / 15)))))));
}

/** atan on [0, 1] */
function atanUnit(a: number): number {
  if (a > TAN_PI_12) return PI_6 + atanKernel((a * SQRT3 - 1) / (a + SQRT3));
  return atanKernel(a);
}

export function simAtan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let r = ay <= ax ? atanUnit(ay / ax) : HALF_PI - atanUnit(ax / ay);
  if (x < 0) r = PI - r;
  return y < 0 ? -r : r;
}

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;

/** Multiplies by 2^k exactly (powers of two are exact in binary floating point). */
function scaleByPow2(v: number, k: number): number {
  let result = v;
  let e = k;
  while (e >= 30) {
    result *= 1073741824;
    e -= 30;
  }
  while (e <= -30) {
    result /= 1073741824;
    e += 30;
  }
  return e >= 0 ? result * (1 << e) : result / (1 << -e);
}

export function simExp(x: number): number {
  if (x > 709) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2_HI - k * LN2_LO; // |r| ≤ ~0.35
  let sum = 1;
  let term = 1;
  for (let i = 1; i <= 13; i++) {
    term = (term * r) / i;
    sum += term;
  }
  return scaleByPow2(sum, k);
}

/** Wraps an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  let r = a - TAU * Math.round(a / TAU);
  if (r <= -PI) r += TAU;
  return r;
}
