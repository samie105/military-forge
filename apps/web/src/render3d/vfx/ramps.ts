/**
 * Colour-over-life ramps, baked once into a lookup table (linear RGB + alpha). A particle stores a
 * ramp id; its colour at age/life is one table read.
 */
export const Ramp = {
  /** white-hot → yellow → orange → deep red → gone */
  Fire: 0,
  /** white → yellow → orange */
  Spark: 1,
  /** the blast's lingering smoke: soot → grey, fades in, hangs, fades out */
  Smoke: 2,
  /** grenade trail puffs: mid grey, quick fade */
  Trail: 3,
  /** ground dust kicked up by the blast */
  Dust: 4,
  /** the shockwave ring */
  Ring: 5,
  /** the blast flash card */
  Flash: 6,
  /** scorch decals: hold, then fade over the last fifth */
  Scorch: 7,
  /** flipbook art as painted: white, opaque until the last fifth */
  Book: 8,
  /** a bullet tracer streak (white-yellow, fades) */
  Tracer: 9,
  /** debris chunks: dark earth, opaque until the last fifth */
  Chunk: 10,
  /** white haze that thins out (tint it): a sniper's smoke line */
  Haze: 11,
  /** the dash trail's sparkles: a white flash cooling to mint green, gone (dashTrail.ts) */
  Sparkle: 12,
  /** blood droplets (blood.ts, an option): dark red, darkening, gone */
  Blood: 13,
  /** a thin blood mist */
  BloodMist: 14,
  /** a blood splat: holds, then fades over the last fifth */
  BloodDecal: 15,
} as const;

/** [t, r, g, b, a] keys in linear colour, t ascending from 0 to 1 */
const KEYS: readonly (readonly number[])[][] = [
  [[0, 1, 0.93, 0.7, 1], [0.08, 1, 0.62, 0.14, 1], [0.3, 0.95, 0.3, 0.035, 0.85], [0.6, 0.55, 0.1, 0.02, 0.3], [0.85, 0.2, 0.04, 0.01, 0]],
  [[0, 1, 0.97, 0.8, 1], [0.35, 1, 0.65, 0.16, 1], [1, 0.75, 0.18, 0.03, 0]],
  [[0, 0.03, 0.03, 0.03, 0], [0.1, 0.045, 0.043, 0.04, 0.66], [0.55, 0.1, 0.096, 0.09, 0.5], [1, 0.2, 0.2, 0.19, 0]],
  [[0, 0.12, 0.12, 0.115, 0.9], [0.45, 0.19, 0.19, 0.18, 0.55], [1, 0.3, 0.3, 0.29, 0]],
  [[0, 0.12, 0.105, 0.085, 0.85], [0.5, 0.16, 0.145, 0.12, 0.55], [1, 0.22, 0.205, 0.18, 0]],
  [[0, 1, 0.95, 0.85, 0.95], [0.5, 1, 0.75, 0.45, 0.45], [1, 1, 0.6, 0.3, 0]],
  [[0, 1, 1, 0.95, 1], [0.4, 1, 0.85, 0.55, 0.6], [1, 1, 0.6, 0.25, 0]],
  [[0, 0.01, 0.008, 0.006, 0.85], [0.8, 0.01, 0.008, 0.006, 0.85], [1, 0.01, 0.008, 0.006, 0]],
  [[0, 1, 1, 1, 1], [0.8, 1, 1, 1, 1], [1, 1, 1, 1, 0]],
  [[0, 1, 0.98, 0.85, 1], [0.5, 1, 0.9, 0.6, 0.7], [1, 1, 0.8, 0.45, 0]],
  [[0, 0.045, 0.035, 0.025, 1], [0.8, 0.045, 0.035, 0.025, 1], [1, 0.045, 0.035, 0.025, 0]],
  [[0, 1, 1, 1, 0.55], [0.4, 1, 1, 1, 0.35], [1, 1, 1, 1, 0]],
  [[0, 0.85, 1, 0.85, 1], [0.15, 0.35, 1, 0.5, 1], [1, 0.1, 0.8, 0.25, 0]],
  [[0, 0.3, 0.012, 0.01, 1], [0.6, 0.19, 0.006, 0.005, 0.95], [1, 0.11, 0.004, 0.004, 0]],
  [[0, 0.32, 0.03, 0.025, 0.5], [1, 0.2, 0.015, 0.012, 0]],
  [[0, 0.14, 0.005, 0.004, 0.9], [0.8, 0.11, 0.004, 0.003, 0.85], [1, 0.09, 0.003, 0.003, 0]],
];

export const RAMP_STEPS = 64;
/** RAMP_STEPS × RGBA per ramp */
export const RAMPS = new Float32Array(KEYS.length * RAMP_STEPS * 4);

for (let r = 0; r < KEYS.length; r++) {
  const keys = KEYS[r]!;
  for (let s = 0; s < RAMP_STEPS; s++) {
    const t = s / (RAMP_STEPS - 1);
    let k = 0;
    while (k < keys.length - 2 && keys[k + 1]![0]! < t) k++;
    const a = keys[k]!;
    const b = keys[k + 1]!;
    const u = Math.min(1, Math.max(0, (t - a[0]!) / (b[0]! - a[0]! || 1)));
    for (let c = 0; c < 4; c++) RAMPS[(r * RAMP_STEPS + s) * 4 + c] = a[c + 1]! + (b[c + 1]! - a[c + 1]!) * u;
  }
}

/** Offset of ramp `ramp`'s entry for life fraction t (0…1) in RAMPS. */
export function rampIndex(ramp: number, t: number): number {
  const s = Math.min(RAMP_STEPS - 1, Math.max(0, Math.round(t * (RAMP_STEPS - 1))));
  return (ramp * RAMP_STEPS + s) * 4;
}
