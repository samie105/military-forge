/**
 * Measuring a sound: its loudness (ITU-R BS.1770 K-weighting, in LUFS), where its energy sits (octave
 * bands, the spectral centroid) and its peak. A skin's sounds are levelled with these to their base
 * sounds' loudness (sounds/skins.ts), and the parity tests hold them to it (docs/17 V11).
 */

/** One biquad over `x` (direct form I), normalised by a0. */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Float32Array {
  const out = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const y = (b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** BS.1770's K-weighting at any sample rate: its high shelf (+4 dB above ~1.7 kHz), then its high-pass (38 Hz). */
export function kWeight(x: Float32Array, sr: number): Float32Array {
  // the shelf (the standard's 48 kHz filter, re-derived for `sr`)
  const A = 10 ** (3.999843853973347 / 40);
  let w = (2 * Math.PI * 1681.974450955533) / sr;
  let alpha = Math.sin(w) / (2 * 0.7071752369554196);
  let c = Math.cos(w);
  const s = 2 * Math.sqrt(A) * alpha;
  const shelf = biquad(x, A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s), A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s);
  w = (2 * Math.PI * 38.13547087602444) / sr;
  alpha = Math.sin(w) / (2 * 0.5003270373238773);
  c = Math.cos(w);
  return biquad(shelf, (1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
}

/**
 * Loudness in LUFS over the whole sound (a one-shot is shorter than BS.1770's 400 ms gating blocks
 * would need, so no gate: every sample counts, as it does when it plays).
 */
export function loudness(x: Float32Array, sr: number): number {
  const y = kWeight(x, sr);
  let sum = 0;
  for (let i = 0; i < y.length; i++) sum += y[i]! * y[i]!;
  return -0.691 + 10 * Math.log10(sum / Math.max(1, y.length) + 1e-20);
}

/** Peak level in dBFS. */
export function peakDb(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return 20 * Math.log10(p + 1e-20);
}

/** In-place radix-2 FFT (re, im of a power-of-two length). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k);
        const wi = Math.sin(a * k);
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * wr - im[i + k + len / 2]! * wi;
        const vi = re[i + k + len / 2]! * wi + im[i + k + len / 2]! * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/** The power spectrum summed over Hann-windowed frames (Welch): power per FFT bin, bin width sr / size. */
export function powerSpectrum(x: Float32Array, size = 2048): Float64Array {
  const hop = size / 2;
  const out = new Float64Array(size / 2);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let start = 0; start < Math.max(1, x.length - hop); start += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) out[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
  }
  return out;
}

/** Octave bands' centres (Hz): the ones a 32 kHz bank holds. */
export const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000] as const;

/** Each octave band's share of the sound's energy (0…1), centred on OCTAVES (the top one runs to Nyquist). */
export function octaveShares(x: Float32Array, sr: number): number[] {
  const p = powerSpectrum(x);
  const bin = sr / (2 * p.length);
  const bands = OCTAVES.map(() => 0);
  let total = 0;
  for (let k = 1; k < p.length; k++) {
    const f = k * bin;
    let b = OCTAVES.findIndex((c) => f < c * Math.SQRT2);
    if (b < 0) b = OCTAVES.length - 1;
    if (f < OCTAVES[0] / Math.SQRT2) continue;
    bands[b]! += p[k]!;
    total += p[k]!;
  }
  return bands.map((e) => e / (total || 1));
}

/** The share of a sound's energy below `hz`. */
export function shareBelow(x: Float32Array, sr: number, hz: number): number {
  const p = powerSpectrum(x);
  const bin = sr / (2 * p.length);
  let below = 0;
  let total = 0;
  for (let k = 1; k < p.length; k++) {
    total += p[k]!;
    if (k * bin < hz) below += p[k]!;
  }
  return below / (total || 1);
}

/** The spectral centroid (Hz): the energy-weighted mean frequency. */
export function centroid(x: Float32Array, sr: number): number {
  const p = powerSpectrum(x);
  const bin = sr / (2 * p.length);
  let num = 0;
  let den = 0;
  for (let k = 1; k < p.length; k++) {
    num += k * bin * p[k]!;
    den += p[k]!;
  }
  return num / (den || 1);
}

/** The loudest 400 ms of a sound (BS.1770's momentary loudness, LUFS), stepped every 100 ms. */
export function momentaryMax(x: Float32Array, sr: number): number {
  const y = kWeight(x, sr);
  const win = Math.round(sr * 0.4);
  const hop = Math.round(sr * 0.1);
  let best = -Infinity;
  for (let start = 0; start === 0 || start + win <= y.length; start += hop) {
    let sum = 0;
    for (let i = start; i < Math.min(y.length, start + win); i++) sum += y[i]! * y[i]!;
    best = Math.max(best, -0.691 + 10 * Math.log10(sum / win + 1e-20));
    if (start + win >= y.length) break;
  }
  return best;
}
