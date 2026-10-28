/**
 * Weapon skins' own sounds (docs/17 §3.6, V11): the K-47 Galaxy Relic line (owner, 28 Oct: "its own bespoke
 * sound"). A skin swaps a gun's sounds by id (packages/content weapon-skins.json `sounds`); each of its sounds
 * starts from exactly the samples its base sound plays (the same take, rendered through the bank's path) and adds
 * a timbre on top, after the base's transient. It is then cut to the base's length and levelled to the base's
 * loudness (BS.1770, analysis.ts), so it is heard as far, reads as the same gun by ear, and keeps every timing:
 * only the timbre changes (test: skins.test.ts). The director plays a skin's sounds with the base's pitch and level.
 *
 * Also here: the Locker's inspect chime and the Stardust Shatter kill effect's sound (docs/17 §3.7).
 */
import { decayEnv, linEnv, mixInto, modal, mulInPlace, noise, osc, crackle, reverb, svf, sweep, tremoloInPlace, buf, fadeInPlace } from '../dsp';
import { loudness, peakDb } from '../analysis';
import { renderDef } from './render';
import type { RenderCtx, SoundDef } from './types';
import { weaponSounds } from './weapons';

const G = 'Skins: K-47 Galaxy Relic';

/** A glass bowl's inharmonic partials (ratio, gain, decay s): the line's crystal. */
const CRYSTAL: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.16],
  [2.32, 0.6, 0.11],
  [4.25, 0.42, 0.07],
  [6.63, 0.28, 0.05],
  [9.38, 0.16, 0.035],
];

/** The base sound's take this variant plays (its samples, normalised and trimmed as the bank plays them). */
function base(id: keyof typeof weaponSounds, r: RenderCtx): Float32Array {
  const def: SoundDef = weaponSounds[id];
  return renderDef(id, def, r.v % Math.max(1, def.variants ?? 1), r.sr)[0]!;
}

/**
 * `layers` mixed onto `under` (the base take), then levelled to the base's loudness: the length is the base's
 * (a layer past it is cut), and so is the loudness (±0 LU by construction, unless the peak would pass the base's
 * ceiling `ceil`: then it is held there, a fraction of a dB quieter).
 */
function onBase(under: Float32Array, sr: number, layers: readonly (readonly [Float32Array, number, number])[], ceil = 0.9): Float32Array {
  const out = under.slice();
  for (const [layer, at, gain] of layers) mixInto(out, layer, sr, at, gain);
  // the base's own last 20 ms fade: nothing rings past where the base ends
  const fade = Math.min(out.length, Math.round(sr * 0.02));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i]! *= i / fade;
  const k = 10 ** ((loudness(under, sr) - loudness(out, sr)) / 20);
  for (let i = 0; i < out.length; i++) out[i]! *= k;
  // never over the base's ceiling (the bank's peak): a layer can't make it louder at its peak
  const over = 10 ** ((peakDb(out) - 20 * Math.log10(ceil)) / 20);
  if (over > 1) for (let i = 0; i < out.length; i++) out[i]! /= over;
  return out;
}

/** Silent for `after` s, then in over `rise` s: a layer that leaves the base's transient as it was. */
function after(sr: number, len: number, start: number, rise = 0.008): Float32Array {
  return linEnv(sr, len, [[0, 0], [start, 0], [start + rise, 1], [len, 1]]);
}

/** A crystal struck once at `f0`: the glass partials with a bright tick. */
function crystal(r: RenderCtx, f0: number, len: number, damp = 1): Float32Array {
  const { sr, rng } = r;
  const ring = modal(sr, len, rng.jitter(f0, 0.015), CRYSTAL.map(([ratio, g, d]) => [ratio, g, d * damp] as const), rng);
  const tick = mulInPlace(svf(noise(sr, 0.012, rng), sr, 'bp', Math.min(sr * 0.45, f0 * 6.5), 3), decayEnv(sr, 0.012, 0.004, 0.0002));
  mixInto(ring, tick, sr, 0, 0.5);
  return fadeInPlace(ring, sr, 0.0005, 0.01);
}

/** A faint shimmer: sparse glints and a breath of high air, swelling then dying away over `len`. */
function shimmer(r: RenderCtx, len: number, peakAt: number, rate = 55): Float32Array {
  const { sr, rng } = r;
  const glints = svf(crackle(sr, len, rng, rate, 0.0009), sr, 'bp', sweep(7500, 5200, len), 2.5);
  const air = tremoloInPlace(svf(noise(sr, len, rng), sr, 'bp', sweep(9000, 6500, len), 4), sr, 13, 0.6);
  const out = buf(sr, len);
  mixInto(out, glints, sr, 0, 1);
  mixInto(out, air, sr, 0, 0.35);
  return mulInPlace(out, linEnv(sr, len, [[0, 0], [peakAt, 1], [len, 0]]));
}

/** The fire's arcane edge: a resonant ring, low and glassy, pitched down as it fades. */
function arcaneEdge(r: RenderCtx, len: number): Float32Array {
  const { sr, rng } = r;
  const ring = svf(noise(sr, len, rng), sr, 'bp', sweep(rng.jitter(3100, 0.04), 2300, len), 9);
  return mulInPlace(ring, decayEnv(sr, len, 0.11, 0.002));
}

/** A soft energy hum: two sine partials with a quick flutter, swelling and settling over `len`. */
function hum(r: RenderCtx, len: number): Float32Array {
  const { sr } = r;
  const out = osc(sr, len, 'sine', 147);
  mixInto(out, osc(sr, len, 'sine', 294), sr, 0, 0.45);
  mixInto(out, osc(sr, len, 'sine', 441.5), sr, 0, 0.18);
  tremoloInPlace(out, sr, 18, 0.45);
  return mulInPlace(out, linEnv(sr, len, [[0, 0], [len * 0.35, 1], [len, 0]]));
}

/** The fire: the K-47's report as it is, with a deep crystal ring, an arcane edge and a faint shimmering tail. */
function relicFire(r: RenderCtx): Float32Array {
  const { sr } = r;
  const b = base('rifle.fire', r);
  const L = b.length / sr;
  const ring = mulInPlace(crystal(r, 233, L, 1), after(sr, L, 0.004));
  const edge = mulInPlace(arcaneEdge(r, L), after(sr, L, 0.006));
  return onBase(b, sr, [
    [ring, 0, 0.06],
    [edge, 0, 0.24],
    [mulInPlace(shimmer(r, L, Math.min(0.12, L * 0.3)), after(sr, L, 0.006)), 0, 0.24],
  ]);
}

/** A reload part: the base foley, crystalline clicks where its clicks are, and (`withHum`) the magazine's hum. */
function relicPart(id: 'rifle.magout' | 'rifle.magin' | 'rifle.bolt', clicks: readonly number[], f0: number, withHum: boolean) {
  return (r: RenderCtx): Float32Array => {
    const { sr } = r;
    const b = base(id, r);
    const L = b.length / sr;
    const layers: [Float32Array, number, number][] = clicks.map((t, i) => [crystal(r, f0 * (1 + 0.19 * i), 0.12, 0.35), t + 0.002, 0.07 - 0.015 * i]);
    if (withHum) layers.push([hum(r, Math.min(0.3, L)), 0.01, 0.09]);
    return onBase(b, sr, layers);
  };
}

/** The draw: the base's cloth and clack with a short arcane chime on the clack. */
function relicDraw(r: RenderCtx): Float32Array {
  const { sr } = r;
  const b = base('rifle.draw', r);
  const L = b.length / sr;
  const chime = buf(sr, 0.26);
  mixInto(chime, crystal(r, 587.3, 0.26, 0.9), sr, 0, 0.7);
  mixInto(chime, crystal(r, 880, 0.2, 0.7), sr, 0.035, 0.4);
  return onBase(b, sr, [
    [chime, 0.13, 0.1],
    [shimmer(r, Math.min(0.25, L - 0.12), 0.06, 70), 0.12, 0.05],
  ]);
}

/** The Locker's inspect: a short arcane chime (D, A, E♭: dark), a rising sparkle, a little air. */
function inspectChime(r: RenderCtx): Float32Array {
  const { sr } = r;
  const len = 1.1;
  const dry = buf(sr, len);
  mixInto(dry, crystal(r, 293.66, 0.9, 2.2), sr, 0, 0.8);
  mixInto(dry, crystal(r, 440, 0.8, 2), sr, 0.08, 0.6);
  mixInto(dry, crystal(r, 622.25, 0.7, 1.8), sr, 0.16, 0.5);
  mixInto(dry, shimmer(r, 0.8, 0.3, 80), sr, 0.1, 0.25);
  return fadeInPlace(reverb(dry, sr, { size: 0.5, decay: 0.9, wet: 0.28, tail: 0.25, damp: 0.4 }), sr, 0.001, 0.08);
}

/**
 * The Stardust Shatter (docs/17 §3.7): a glassy break (a tick and a spray of glass pings, densest at the start)
 * into a sparkling whoosh, all ≤ 0.85 s and above 2.8 kHz, clear of the footsteps' and the jetpack's bands.
 */
function shatter(r: RenderCtx): Float32Array {
  const { sr, rng } = r;
  const len = 0.85;
  const out = buf(sr, len);
  // the break: a bright tick
  mixInto(out, mulInPlace(svf(noise(sr, 0.04, rng), sr, 'hp', 3200, 0.9), decayEnv(sr, 0.04, 0.018, 0.0003)), sr, 0, 0.9);
  // the shards: glass pings, front-loaded, each its own small crystal
  for (let i = 0; i < 26; i++) {
    const u = rng.next();
    const t = 0.32 * u * u;
    const f = rng.range(2900, 8200);
    const ping = modal(sr, 0.16, f, [[1, 1, rng.range(0.03, 0.09)], [2.7, 0.45, 0.03], [5.1, 0.2, 0.015]], rng);
    mixInto(out, ping, sr, t, (0.35 + 0.4 * rng.next()) * (1 - 0.6 * u));
  }
  // the sparkling whoosh, and its glints
  const whoosh = mulInPlace(svf(noise(sr, len - 0.12, rng), sr, 'bp', sweep(3200, 8500, len - 0.12), 1.6), linEnv(sr, len - 0.12, [[0, 0], [0.3, 1], [len - 0.12, 0]]));
  mixInto(out, whoosh, sr, 0.12, 0.35);
  mixInto(out, shimmer(r, len - 0.2, 0.25, 110), sr, 0.2, 0.5);
  // nothing low: two high-passes keep it out of the footsteps' thump and scuff and the jet's roar
  const hp = svf(svf(out, sr, 'hp', 2800, 0.7), sr, 'hp', 2800, 0.7);
  return fadeInPlace(hp, sr, 0.0005, 0.06);
}

/** A skin's version of a base weapon sound: the base's playback (range, far layer, voices, priority), a new render. */
const skinOf = (id: keyof typeof weaponSounds, label: string, render: (r: RenderCtx) => Float32Array): SoundDef => ({
  ...weaponSounds[id],
  label,
  group: G,
  render,
  asRendered: true,
});

export const skinSounds = {
  'relic.fire': skinOf('rifle.fire', 'Galaxy Relic: fire', relicFire),
  'relic.magout': skinOf('rifle.magout', 'Galaxy Relic: mag out', relicPart('rifle.magout', [0, 0.035], 3100, false)),
  'relic.magin': skinOf('rifle.magin', 'Galaxy Relic: mag in (hum)', relicPart('rifle.magin', [0, 0.035], 2700, true)),
  'relic.bolt': skinOf('rifle.bolt', 'Galaxy Relic: charging handle', relicPart('rifle.bolt', [0, 0.15], 2400, false)),
  'relic.draw': skinOf('rifle.draw', 'Galaxy Relic: draw', relicDraw),
  'relic.inspect': { label: 'Galaxy Relic: inspect (Locker)', group: G, bus: 'ui', render: inspectChime, gain: 0.4, maxVoices: 1, cooldown: 0.4, pitchJitter: 0 },
  'stardust.shatter': {
    label: 'Stardust Shatter (kill effect)',
    group: G,
    bus: 'sfx',
    render: shatter,
    variants: 3,
    // its loudest 400 ms sit ≥ 1 dB under the base death voice's quietest take (voice.death at 0.38): skins.test.ts
    gain: 0.16,
    maxVoices: 4,
    cooldown: 0.05,
    priority: 55,
    range: 35,
    wet: 0.15,
  },
} satisfies Record<string, SoundDef>;

/** The skin lines' sounds (rendered only when someone in the match wears the line: their own memory budget). */
export const SKIN_SOUND_IDS = Object.keys(skinSounds) as (keyof typeof skinSounds)[];
