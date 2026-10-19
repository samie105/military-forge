/**
 * A small sample-level synthesis kit: every sound in the game is made here, in code, from noise,
 * oscillators, filters and envelopes (no recorded or generated files). Pure functions over
 * Float32Arrays, so the sound bank renders the same in the browser and in tests.
 *
 * Conventions: times in seconds, frequencies in Hz, `sr` is the sample rate. Builders return new
 * arrays; `mixInto` and the in-place helpers say so in their names.
 */

/** A seeded random source (mulberry32), so each sound's variants are fixed. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** uniform in [a, b) */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** −1…1 */
  bi(): number {
    return this.next() * 2 - 1;
  }
  /** `v` jittered by ±`frac` of itself */
  jitter(v: number, frac: number): number {
    return v * (1 + this.bi() * frac);
  }
}

/** A string → 32-bit seed (FNV-1a). */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const samples = (sr: number, seconds: number): number => Math.max(1, Math.round(sr * seconds));
export const buf = (sr: number, seconds: number): Float32Array => new Float32Array(samples(sr, seconds));

// ------------------------------------------------------------------ sources

export type NoiseColor = 'white' | 'pink' | 'brown';

/** Noise of `seconds`: white, pink (Paul Kellet's economy filter) or brown (leaky integrator). */
export function noise(sr: number, seconds: number, rng: Rng, color: NoiseColor = 'white'): Float32Array {
  const out = buf(sr, seconds);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.bi();
    if (color === 'white') out[i] = w;
    else if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else {
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.5;
    }
  }
  return out;
}

export type Wave = 'sine' | 'tri' | 'saw' | 'square' | 'pulse25';

/** A frequency curve: a constant, or a function of time (s). */
export type Curve = number | ((t: number) => number);
const at = (c: Curve, t: number): number => (typeof c === 'number' ? c : c(t));

function waveAt(w: Wave, ph: number): number {
  switch (w) {
    case 'sine':
      return Math.sin(ph * 2 * Math.PI);
    case 'tri':
      return 1 - 4 * Math.abs(ph - 0.5);
    case 'saw':
      return 2 * ph - 1;
    case 'square':
      return ph < 0.5 ? 1 : -1;
    case 'pulse25':
      return ph < 0.25 ? 1 : -1;
  }
}

/** An oscillator whose frequency may follow a curve (pitch sweeps, vibrato). `phase` 0…1 to start. */
export function osc(sr: number, seconds: number, wave: Wave, freq: Curve, phase = 0): Float32Array {
  const out = buf(sr, seconds);
  let ph = phase;
  for (let i = 0; i < out.length; i++) {
    out[i] = waveAt(wave, ph);
    ph += at(freq, i / sr) / sr;
    ph -= Math.floor(ph);
  }
  return out;
}

/** An exponential sweep from f0 to f1 over `seconds` (then holds f1). */
export const sweep =
  (f0: number, f1: number, seconds: number): ((t: number) => number) =>
  (t) =>
    f0 * Math.pow(f1 / f0, Math.min(1, t / Math.max(1e-4, seconds)));

/**
 * Modal synthesis: a struck object as decaying sine partials (frequency ratio, gain, decay s).
 * Metal clicks, bells, clanks and pings come from here.
 */
export function modal(sr: number, seconds: number, f0: number, partials: readonly (readonly [ratio: number, gain: number, decay: number])[], rng?: Rng): Float32Array {
  const out = buf(sr, seconds);
  for (const [ratio, gain, decay] of partials) {
    const f = f0 * ratio * (rng ? 1 + rng.bi() * 0.01 : 1);
    if (f >= sr / 2) continue;
    const w = (2 * Math.PI * f) / sr;
    const k = Math.exp(-1 / (decay * sr));
    let a = gain;
    const ph = rng ? rng.next() * 6.283 : 0;
    for (let i = 0; i < out.length; i++) {
      out[i]! += a * Math.sin(w * i + ph);
      a *= k;
      if (a < 1e-5) break;
    }
  }
  return out;
}

/** Inharmonic partials of a struck bar/plate (good metal). */
export const METAL: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.05],
  [2.76, 0.6, 0.03],
  [5.4, 0.4, 0.018],
  [8.93, 0.25, 0.01],
];

/** Sparse random clicks (crackle, debris, rattles): `rate` per second, each `len` s long. */
export function crackle(sr: number, seconds: number, rng: Rng, rate: number, len = 0.002): Float32Array {
  const out = buf(sr, seconds);
  const n = Math.round(rate * seconds);
  const l = samples(sr, len);
  for (let k = 0; k < n; k++) {
    const start = Math.floor(rng.next() * out.length);
    const amp = rng.range(0.2, 1) * (rng.next() < 0.5 ? -1 : 1);
    for (let i = 0; i < l && start + i < out.length; i++) out[start + i]! += amp * (1 - i / l) * rng.bi();
  }
  return out;
}

// ------------------------------------------------------------------ envelopes

/** Exponential decay to −60 dB over `t60` s, after `attack` s of linear rise. */
export function decayEnv(sr: number, seconds: number, t60: number, attack = 0.001): Float32Array {
  const out = buf(sr, seconds);
  const a = Math.max(1, samples(sr, attack));
  const k = Math.exp(Math.log(0.001) / Math.max(1, t60 * sr));
  let v = 1;
  for (let i = 0; i < out.length; i++) {
    if (i < a) out[i] = i / a;
    else {
      out[i] = v;
      v *= k;
    }
  }
  return out;
}

/** Piecewise-linear envelope through [time, level] points (holds the last level). */
export function linEnv(sr: number, seconds: number, points: readonly (readonly [number, number])[]): Float32Array {
  const out = buf(sr, seconds);
  let j = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    while (j < points.length - 1 && t > points[j + 1]![0]) j++;
    const [t0, v0] = points[j]!;
    const [t1, v1] = points[Math.min(j + 1, points.length - 1)]!;
    out[i] = t <= t0 ? v0 : t1 <= t0 ? v1 : v0 + (v1 - v0) * Math.min(1, (t - t0) / (t1 - t0));
  }
  return out;
}

/** ADSR (seconds; sustain level 0…1; `hold` is how long the note is held before release). */
export function adsr(sr: number, seconds: number, a: number, d: number, s: number, hold: number, r: number): Float32Array {
  return linEnv(sr, seconds, [
    [0, 0],
    [a, 1],
    [a + d, s],
    [Math.max(a + d, hold), s],
    [Math.max(a + d, hold) + r, 0],
  ]);
}

// ------------------------------------------------------------------ filters

export type FilterMode = 'lp' | 'hp' | 'bp' | 'notch';

/**
 * A state-variable filter (Zavalishin's TPT form): stable under per-sample cutoff sweeps, which
 * is most of what these sounds do. `q` 0.5…20. Returns a new array.
 */
export function svf(input: Float32Array, sr: number, mode: FilterMode, cutoff: Curve, q = 0.707): Float32Array {
  const out = new Float32Array(input.length);
  let ic1 = 0;
  let ic2 = 0;
  const k = 1 / Math.max(0.05, q);
  const fixed = typeof cutoff === 'number';
  let g = fixed ? Math.tan((Math.PI * Math.min(cutoff, sr * 0.45)) / sr) : 0;
  let a1 = 1 / (1 + g * (g + k));
  for (let i = 0; i < input.length; i++) {
    if (!fixed && (i & 7) === 0) {
      g = Math.tan((Math.PI * Math.min(Math.max(20, at(cutoff, i / sr)), sr * 0.45)) / sr);
      a1 = 1 / (1 + g * (g + k));
    }
    const v0 = input[i]!;
    const v1 = a1 * (ic1 + g * (v0 - ic2));
    const v2 = ic2 + g * v1;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    switch (mode) {
      case 'lp':
        out[i] = v2;
        break;
      case 'bp':
        out[i] = v1 * k;
        break;
      case 'hp':
        out[i] = v0 - k * v1 - v2;
        break;
      case 'notch':
        out[i] = v0 - k * v1;
        break;
    }
  }
  return out;
}

/** One-pole low-pass smoothing (cheap darkening). */
export function onePole(input: Float32Array, sr: number, cutoff: number): Float32Array {
  const out = new Float32Array(input.length);
  const a = Math.exp((-2 * Math.PI * cutoff) / sr);
  let y = 0;
  for (let i = 0; i < input.length; i++) {
    y = (1 - a) * input[i]! + a * y;
    out[i] = y;
  }
  return out;
}

// ------------------------------------------------------------------ shaping and mixing

/** x × env (same length or the shorter of the two), in place on x. */
export function mulInPlace(x: Float32Array, env: Float32Array | number): Float32Array {
  if (typeof env === 'number') {
    for (let i = 0; i < x.length; i++) x[i]! *= env;
    return x;
  }
  const n = Math.min(x.length, env.length);
  for (let i = 0; i < n; i++) x[i]! *= env[i]!;
  for (let i = n; i < x.length; i++) x[i] = 0;
  return x;
}

/** A copy of x × env. */
export const mul = (x: Float32Array, env: Float32Array | number): Float32Array => mulInPlace(Float32Array.from(x), env);

/** Adds `src × gain` into `dst` starting at `offset` s (clipped to dst's length). Returns dst. */
export function mixInto(dst: Float32Array, src: Float32Array, sr: number, offset = 0, gain = 1): Float32Array {
  const o = Math.round(offset * sr);
  for (let i = 0; i < src.length; i++) {
    const j = o + i;
    if (j < 0) continue;
    if (j >= dst.length) break;
    dst[j]! += src[i]! * gain;
  }
  return dst;
}

/** Soft saturation: tanh(drive·x)/tanh(drive). In place. */
export function driveInPlace(x: Float32Array, drive: number): Float32Array {
  const n = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(drive * x[i]!) / n;
  return x;
}

export function peak(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    if (a > m) m = a;
  }
  return m;
}

export function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length));
}

/** Scales x so its peak is `target` (silence stays silence). In place. */
export function normalizeInPlace(x: Float32Array, target = 0.9): Float32Array {
  const p = peak(x);
  if (p > 1e-9) mulInPlace(x, target / p);
  return x;
}

/** Short linear fades at both ends (no clicks). In place. */
export function fadeInPlace(x: Float32Array, sr: number, fadeIn = 0.001, fadeOut = 0.01): Float32Array {
  const a = Math.min(x.length, samples(sr, fadeIn));
  const b = Math.min(x.length, samples(sr, fadeOut));
  for (let i = 0; i < a; i++) x[i]! *= i / a;
  for (let i = 0; i < b; i++) x[x.length - 1 - i]! *= i / b;
  return x;
}

/** Removes DC with a gentle high-pass (20 Hz). */
export function dcBlock(x: Float32Array, sr: number): Float32Array {
  const out = new Float32Array(x.length);
  const r = 1 - (2 * Math.PI * 20) / sr;
  let px = 0;
  let py = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i]! - px + r * py;
    px = x[i]!;
    py = y;
    out[i] = y;
  }
  return out;
}

/** Plays x backwards (reverse swells). */
export const reversed = (x: Float32Array): Float32Array => Float32Array.from(x).reverse();

/**
 * Feedback echoes (an outdoor slap-back): `taps` copies, each `delay` s later and `fb` quieter,
 * darkened by a one-pole low-pass. Extends the length by the tail. Returns a new array.
 */
export function echo(x: Float32Array, sr: number, delay: number, fb: number, taps: number, darken = 2500): Float32Array {
  const extra = delay * taps;
  const out = new Float32Array(x.length + samples(sr, extra));
  out.set(x);
  let tap: Float32Array = Float32Array.from(x);
  for (let k = 1; k <= taps; k++) {
    tap = onePole(tap, sr, darken);
    mixInto(out, tap, sr, delay * k, Math.pow(fb, k));
  }
  return out;
}

/**
 * A small Schroeder reverb (4 combs + 2 all-passes): `size` 0…1 scales the delays, `decay` is the
 * tail's t60-ish in seconds, `wet` the mix. Extends the length by `tail` s. Returns a new array.
 */
export function reverb(x: Float32Array, sr: number, opts: { size?: number; decay?: number; wet?: number; tail?: number; damp?: number } = {}): Float32Array {
  const size = opts.size ?? 0.5;
  const decay = opts.decay ?? 1;
  const wet = opts.wet ?? 0.25;
  const tail = opts.tail ?? decay;
  const damp = opts.damp ?? 0.3;
  const n = x.length + samples(sr, tail);
  const dry = new Float32Array(n);
  dry.set(x);
  const wetSum = new Float32Array(n);
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => Math.max(1, Math.round(d * (0.5 + size) * sr)));
  for (const d of combs) {
    const g = Math.pow(0.001, d / sr / Math.max(0.05, decay));
    const line = new Float32Array(d);
    let idx = 0;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const y = line[idx]!;
      lp = y * (1 - damp) + lp * damp;
      line[idx] = dry[i]! + lp * g;
      idx = (idx + 1) % d;
      wetSum[i]! += y;
    }
  }
  let sig = wetSum;
  for (const d0 of [0.005, 0.0017]) {
    const d = Math.max(1, Math.round(d0 * sr));
    const line = new Float32Array(d);
    const out = new Float32Array(n);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const b = line[idx]!;
      const v = sig[i]! + b * 0.5;
      line[idx] = v;
      out[i] = b - v * 0.5;
      idx = (idx + 1) % d;
    }
    sig = out;
  }
  for (let i = 0; i < n; i++) dry[i]! += sig[i]! * wet * 0.25;
  return dry;
}

/**
 * Makes x loop seamlessly: the last `xfade` s are cross-faded into the start (equal power), and
 * the result is that much shorter.
 */
export function seamless(x: Float32Array, sr: number, xfade: number): Float32Array {
  const f = Math.min(Math.floor(x.length / 2), samples(sr, xfade));
  const out = new Float32Array(x.subarray(0, x.length - f));
  for (let i = 0; i < f; i++) {
    const t = i / f;
    out[i] = x[i]! * Math.sin((t * Math.PI) / 2) + x[x.length - f + i]! * Math.cos((t * Math.PI) / 2);
  }
  return out;
}

/** Amplitude modulation by an LFO: 1 − depth·(0.5 − 0.5·cos), rate in Hz (may be a curve). In place. */
export function tremoloInPlace(x: Float32Array, sr: number, rate: Curve, depth: number): Float32Array {
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    x[i]! *= 1 - depth * (0.5 - 0.5 * Math.cos(ph * 2 * Math.PI));
    ph += at(rate, i / sr) / sr;
  }
  return x;
}

/** A slowly wandering gain 1±depth (random walk, smoothed): living loops. In place. */
export function wanderInPlace(x: Float32Array, sr: number, rng: Rng, depth: number, speed = 6): Float32Array {
  let target = 1;
  let v = 1;
  const k = Math.exp((-2 * Math.PI * speed) / sr);
  const every = Math.max(1, Math.round(sr / (speed * 2)));
  for (let i = 0; i < x.length; i++) {
    if (i % every === 0) target = 1 + rng.bi() * depth;
    v = target + (v - target) * k;
    x[i]! *= v;
  }
  return x;
}

/** A sum of arrays (lengths may differ: the longest wins). */
export function sum(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i]! += p[i]!;
  return out;
}

/** Note number → Hz (A4 = 69 = 440 Hz). */
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
