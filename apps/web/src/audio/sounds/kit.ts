/**
 * Building blocks the recipes share: a gunshot, a mechanical clack, a slide, a whoosh, a blast, a
 * beep. Each takes the render context and a few numbers, and returns a mono Float32Array.
 */
import { METAL, buf, crackle, dcBlock, decayEnv, driveInPlace, echo, fadeInPlace, linEnv, mixInto, modal, mul, mulInPlace, noise, osc, reverb, svf, sweep, type Wave } from '../dsp';
import type { RenderCtx } from './types';

export interface GunParams {
  /** body length, s (tails extend it) */
  len: number;
  /** the supersonic crack / transient: gain and length (s) */
  crack: number;
  crackLen: number;
  /** the noise body: gain, t60, low-pass sweep from → to (Hz) over `bodySweep` s */
  body: number;
  bodyT60: number;
  bodyCut: readonly [number, number];
  bodySweep: number;
  /** the low thump: gain, pitch from → to (Hz), t60 */
  thump: number;
  thumpF: readonly [number, number];
  thumpT60: number;
  /** the action's metal click: gain and pitch */
  mech: number;
  mechF: number;
  /** the room/outdoor tail: gain, t60, low-pass */
  tail: number;
  tailT60: number;
  tailCut: number;
  /** slap-back echoes: delay s, feedback, taps */
  echo?: readonly [number, number, number];
  drive: number;
  /** the action cycling after the shot (bolt carrier, slide): a gritty metal rattle, gain */
  rattle?: number;
  /** a low shelf of sub under the body (the chest punch), gain; default 0.6 */
  sub?: number;
}

/**
 * A gunshot, built the way a real one sounds up close: a sharp N-wave crack (the bullet's shock
 * wave), the muzzle blast (noise through a closing low-pass), a sub-heavy body thump, the action's
 * metal, then an outdoor tail and slap-back echoes. Driven hard into saturation and a soft clip
 * so it has grit, not a clean synth tone.
 */
export function gunshot(r: RenderCtx, p: GunParams): Float32Array {
  const { sr, rng } = r;
  const L = p.len;
  const out = buf(sr, L);
  // the crack: a bipolar N-wave a millisecond or two long, plus a burst of high hash
  const nLen = Math.max(4, Math.round(sr * rng.range(0.0008, 0.0016)));
  const nwave = new Float32Array(nLen * 2);
  for (let i = 0; i < nwave.length; i++) nwave[i] = 1 - i / nLen;
  mixInto(out, nwave, sr, 0, p.crack * 0.9);
  const crack = mulInPlace(svf(noise(sr, p.crackLen * 4, rng), sr, 'hp', rng.jitter(2600, 0.1), 0.8), decayEnv(sr, p.crackLen * 4, p.crackLen, 0.0001));
  mixInto(out, crack, sr, 0, p.crack);
  // the muzzle blast
  const body = mulInPlace(svf(noise(sr, L, rng), sr, 'lp', sweep(rng.jitter(p.bodyCut[0], 0.08), p.bodyCut[1], p.bodySweep), 0.9), decayEnv(sr, L, rng.jitter(p.bodyT60, 0.1), 0.0003));
  mixInto(out, body, sr, 0, p.body);
  // the thump and a low shelf of sub under it
  const thump = mulInPlace(osc(sr, L, 'sine', sweep(rng.jitter(p.thumpF[0], 0.06), p.thumpF[1], p.thumpT60 * 0.6)), decayEnv(sr, L, p.thumpT60, 0.0012));
  mixInto(out, thump, sr, 0, p.thump);
  const sub = mulInPlace(svf(noise(sr, L, rng, 'brown'), sr, 'lp', 160, 0.9), decayEnv(sr, L, p.thumpT60 * 1.6, 0.002));
  mixInto(out, sub, sr, 0, (p.sub ?? 0.6) * 2.5);
  // the action's metal
  if (p.mech > 0) mixInto(out, modal(sr, 0.08, rng.jitter(p.mechF, 0.06), METAL, rng), sr, rng.range(0.001, 0.004), p.mech);
  if (p.rattle) {
    const rat = mulInPlace(svf(crackle(sr, 0.09, rng, 500, 0.0012), sr, 'bp', rng.range(2800, 4200), 1.4), linEnv(sr, 0.09, [[0, 0], [0.015, 1], [0.09, 0]]));
    mixInto(out, rat, sr, rng.range(0.012, 0.025), p.rattle);
  }
  // the space: a darkening noise tail
  const tail = mulInPlace(svf(noise(sr, L, rng, 'pink'), sr, 'lp', sweep(p.tailCut * 1.6, p.tailCut * 0.5, L), 0.7), linEnv(sr, L, [[0, 0], [0.008, 1], [L, 0]]));
  mulInPlace(tail, decayEnv(sr, L, p.tailT60, 0.006));
  mixInto(out, tail, sr, 0, p.tail);
  let y = clipInPlace(driveInPlace(dcBlock(out, sr), p.drive), 0.8);
  if (p.echo) y = echo(y, sr, rng.jitter(p.echo[0], 0.15), p.echo[1], p.echo[2], 1400);
  return fadeInPlace(y, sr, 0.0001, 0.03);
}

/** A soft knee hard clip at ±`at` of the peak: flattens the top for grit. In place. */
export function clipInPlace(x: Float32Array, at: number): Float32Array {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  const t = p * at;
  if (t <= 0) return x;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const a = Math.abs(v);
    if (a > t) x[i] = Math.sign(v) * (t + (a - t) / (1 + ((a - t) / (p - t + 1e-9)) * 3));
  }
  return x;
}

/** A metal (or plastic: lower `hardness`) clack at `f` Hz: modal partials plus a noise tick. */
export function clack(r: RenderCtx, f: number, hardness = 1, len = 0.09): Float32Array {
  const { sr, rng } = r;
  const ring = modal(
    sr,
    len,
    rng.jitter(f, 0.05),
    METAL.map(([ratio, g, d]) => [ratio, g, d * (0.4 + 0.8 * hardness)] as const),
    rng,
  );
  const tick = mulInPlace(svf(noise(sr, 0.02, rng), sr, 'bp', rng.jitter(f * 1.6, 0.1), 1.2), decayEnv(sr, 0.02, 0.006, 0.0002));
  const thud = mulInPlace(osc(sr, len, 'sine', sweep(f * 0.12 + 90, 70, 0.04)), decayEnv(sr, len, 0.03 + 0.03 * (1 - hardness)));
  const out = buf(sr, len);
  mixInto(out, ring, sr, 0, 0.35 * hardness + 0.05);
  mixInto(out, tick, sr, 0, 0.8);
  mixInto(out, thud, sr, 0, 0.5 * (1.2 - hardness));
  return fadeInPlace(out, sr, 0.0002, 0.01);
}

/** A sliding scrape (a mag in its well, a bolt drawn back): band-passed noise swelling over `len`. */
export function slide(r: RenderCtx, len: number, f0: number, f1: number, q = 1.5): Float32Array {
  const { sr, rng } = r;
  const n = svf(noise(sr, len, rng), sr, 'bp', sweep(rng.jitter(f0, 0.08), f1, len), q);
  return fadeInPlace(mulInPlace(n, linEnv(sr, len, [[0, 0], [len * 0.3, 1], [len * 0.85, 0.7], [len, 0]])), sr, 0.002, 0.004);
}

/** A whoosh: noise through a band-pass sweeping f0 → f1, shaped by a rise and a fall. */
export function whoosh(r: RenderCtx, len: number, f0: number, f1: number, q = 1.2, peakAt = 0.4, color: 'white' | 'pink' = 'white'): Float32Array {
  const { sr, rng } = r;
  const n = svf(noise(sr, len, rng, color), sr, 'bp', sweep(rng.jitter(f0, 0.06), rng.jitter(f1, 0.06), len), q);
  return mulInPlace(n, linEnv(sr, len, [[0, 0], [len * peakAt, 1], [len, 0]]));
}

/** A low sine thump sweeping f0 → f1. */
export function thump(r: RenderCtx, len: number, f0: number, f1: number, t60: number): Float32Array {
  const { sr } = r;
  return mulInPlace(osc(sr, len, 'sine', sweep(f0, f1, t60 * 0.6)), decayEnv(sr, len, t60, 0.002));
}

/** A tone with a quick attack and an exponential decay. */
export function beep(r: RenderCtx, f: number, len: number, wave: Wave = 'sine', t60 = len, attack = 0.003): Float32Array {
  return fadeInPlace(mulInPlace(osc(r.sr, len, wave, f), decayEnv(r.sr, len, t60, attack)), r.sr, 0.001, 0.01);
}

export interface BoomParams {
  len: number;
  /** sub sweep from → to, its t60 and gain */
  low: readonly [number, number];
  lowT60: number;
  lowGain: number;
  /** the noise body: low-pass sweep from → to, t60, gain */
  bodyCut: readonly [number, number];
  bodyT60: number;
  bodyGain: number;
  /** the front crack */
  crack: number;
  /** debris crackle per second and gain */
  debrisRate: number;
  debris: number;
  /** reverb wet and decay */
  wet: number;
  decay: number;
  drive: number;
  /** the rolling rumble after the blast (the shock wave across the map), gain; default 0.5 */
  rumble?: number;
  /** the ringing tail: a faint metallic whine that hangs after the boom, gain; default 0.06 */
  ring?: number;
}

/**
 * A blast: a deep sub drop with a low shelf of rumble under it, a darkening noise body, the crack
 * at the front, debris raining down, a ringing tail, and a big outdoor reverb. Saturated and
 * clipped so the low end hits the chest.
 */
export function boom(r: RenderCtx, p: BoomParams): Float32Array {
  const { sr, rng } = r;
  const L = p.len;
  const out = buf(sr, L);
  mixInto(out, thump(r, L, rng.jitter(p.low[0], 0.06), p.low[1], p.lowT60), sr, 0, p.lowGain);
  // the low shelf: brown noise under 120 Hz, rolling for the whole length
  const rumble = mulInPlace(svf(noise(sr, L, rng, 'brown'), sr, 'lp', 120, 0.8), decayEnv(sr, L, L * 0.9, 0.01));
  mixInto(out, rumble, sr, 0, (p.rumble ?? 0.5) * 3);
  const body = mulInPlace(svf(noise(sr, L, rng, 'pink'), sr, 'lp', sweep(rng.jitter(p.bodyCut[0], 0.1), p.bodyCut[1], L * 0.5), 0.8), decayEnv(sr, L, p.bodyT60, 0.002));
  mixInto(out, body, sr, 0, p.bodyGain);
  const crack = mulInPlace(svf(noise(sr, 0.08, rng), sr, 'hp', 1200), decayEnv(sr, 0.08, 0.03, 0.0002));
  mixInto(out, crack, sr, 0, p.crack);
  if (p.debris > 0) {
    // grit and stones coming down: denser at first, sparser later
    const d = mulInPlace(svf(crackle(sr, L, rng, p.debrisRate, 0.005), sr, 'bp', 2200, 0.7), linEnv(sr, L, [[0, 0], [0.12, 1], [L * 0.6, 0.4], [L, 0]]));
    mixInto(out, d, sr, 0.04, p.debris);
    const dirt = mulInPlace(svf(noise(sr, L, rng), sr, 'bp', 900, 0.6), linEnv(sr, L, [[0, 0], [0.2, 0.35], [L, 0]]));
    mixInto(out, dirt, sr, 0.1, p.debris * 0.4);
  }
  let y = clipInPlace(driveInPlace(dcBlock(out, sr), p.drive), 0.75);
  const ringGain = p.ring ?? 0.06;
  if (ringGain > 0) {
    const f = rng.range(2900, 3600);
    const ring = mulInPlace(osc(sr, L, 'sine', (t) => f + 7 * Math.sin(t * 11)), linEnv(sr, L, [[0, 0], [0.15, 1], [L, 0]]));
    mixInto(y, ring, sr, 0, ringGain);
  }
  // the engine's convolver adds the space around it; this is the blast's own close roll
  if (p.wet > 0) y = reverb(y, sr, { size: 1, decay: p.decay, wet: p.wet, tail: p.decay * 0.45, damp: 0.6 });
  return fadeInPlace(y, sr, 0.0002, 0.1);
}

/** Holds a note, plays nothing, or more: a sequence of [time, sound] mixed into one array. */
export function sequence(r: RenderCtx, len: number, parts: readonly (readonly [number, Float32Array, number?])[]): Float32Array {
  const out = buf(r.sr, len);
  for (const [t, s, g] of parts) mixInto(out, s, r.sr, t, g ?? 1);
  return out;
}

/**
 * A vowel-ish voice (formant synthesis): a pulse train at `pitch` (Hz curve) through three
 * band-passes at the formants, plus breath. Grunts, coughs, cries.
 */
export function voice(r: RenderCtx, len: number, pitch: (t: number) => number, formants: readonly [number, number, number], breath = 0.3, env?: Float32Array): Float32Array {
  const { sr, rng } = r;
  const src = osc(sr, len, 'saw', (t) => pitch(t) * (1 + 0.02 * Math.sin(t * 31)));
  const air = mul(noise(sr, len, rng), breath);
  for (let i = 0; i < src.length; i++) src[i]! += air[i]!;
  const out = buf(sr, len);
  const gains = [1, 0.6, 0.25];
  formants.forEach((f, i) => mixInto(out, svf(src, sr, 'bp', f, 6 + i * 2), sr, 0, gains[i]));
  return fadeInPlace(mulInPlace(out, env ?? linEnv(sr, len, [[0, 0], [0.02, 1], [len * 0.6, 0.7], [len, 0]])), sr, 0.002, 0.02);
}

/** Uses r.v to pick a value from a list (variants that differ by design, not only by seed). */
export const pick = <T>(r: RenderCtx, xs: readonly T[]): T => xs[r.v % xs.length]!;

export { mul };
