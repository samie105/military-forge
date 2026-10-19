/**
 * The interface, map event cues, and the music's stings and instruments. Tactical and muted, the
 * way the owner asked ("hard boiled … military, serious battle … not joyous"): switch clicks,
 * radio blips and squelch, low drums and drones in minor keys. No chimes, no jingles.
 */
import { crackle, decayEnv, fadeInPlace, linEnv, mixInto, mtof, mulInPlace, noise, osc, reverb, reversed, svf, sweep } from '../dsp';
import { clack, clipInPlace, sequence, thump } from './kit';
import { radioBlip } from './world';
import type { RenderCtx, SoundDef } from './types';

const ui = (label: string, render: (r: RenderCtx) => Float32Array | [Float32Array, Float32Array], extra: Partial<SoundDef> = {}): SoundDef => ({
  label,
  group: 'Interface',
  bus: 'ui',
  render,
  variants: 1,
  maxVoices: 2,
  cooldown: 0.03,
  priority: 30,
  pitchJitter: 0,
  ...extra,
});

/** A muted switch: a dull plastic-and-metal click, low-passed so it never pokes out. */
function switchClick(r: RenderCtx, f: number, weight = 1): Float32Array {
  const { sr, rng } = r;
  const tick = mulInPlace(svf(noise(sr, 0.025, rng), sr, 'bp', f, 1.4), decayEnv(sr, 0.025, 0.008, 0.0002));
  return sequence(r, 0.06, [
    [0, svf(tick, sr, 'lp', 3500), 1],
    [0, thump(r, 0.04, f * 0.12, f * 0.07, 0.015), 0.5 * weight],
  ]);
}

/** Radio squelch: a burst of band-limited static that opens or closes a transmission. */
function squelch(r: RenderCtx, len: number, level = 1): Float32Array {
  const { sr, rng } = r;
  const n = svf(svf(noise(sr, len, rng), sr, 'hp', 600, 0.7), sr, 'lp', 3200, 0.7);
  mixInto(n, svf(crackle(sr, len, rng, 300, 0.0008), sr, 'bp', 2000, 1), sr, 0, 0.5);
  return fadeInPlace(mulInPlace(clipInPlace(n, 0.6), linEnv(sr, len, [[0, level], [len * 0.7, level * 0.8], [len, 0]])), sr, 0.001, 0.006);
}

/** A low drum hit (a taiko-ish tom): a pitched body sweeping down, and a skin slap. */
function drum(r: RenderCtx, f: number, len: number): Float32Array {
  const { sr, rng } = r;
  return sequence(r, len, [
    [0, thump(r, len, f * 1.6, f, len * 0.6), 1],
    [0, mulInPlace(svf(noise(sr, 0.08, rng), sr, 'bp', f * 6, 1), decayEnv(sr, 0.08, 0.03, 0.001)), 0.5],
  ]);
}

/** A dark brass-like swell: detuned saws in a low, minor cluster through a slowly opening filter. */
function darkBrass(r: RenderCtx, notes: readonly number[], len: number, open = 1400): Float32Array {
  const { sr } = r;
  const out = new Float32Array(Math.round(sr * len));
  for (const n of notes)
    for (const d of [-0.1, 0, 0.09]) mixInto(out, osc(sr, len, 'saw', mtof(n + d), r.rng.next()), sr, 0, 0.3 / notes.length);
  const f = svf(out, sr, 'lp', (t) => 250 + open * Math.min(1, t / (len * 0.35)) * Math.max(0.3, 1 - t / len), 1.4);
  return fadeInPlace(mulInPlace(clipInPlace(f, 0.8), linEnv(sr, len, [[0, 0], [0.04, 1], [len * 0.5, 0.7], [len, 0]])), sr, 0.002, 0.08);
}

/** Stereo from mono: the second channel slightly delayed (width for stings). */
function widen(r: RenderCtx, x: Float32Array, ms = 13): [Float32Array, Float32Array] {
  const d = Math.round((r.sr * ms) / 1000);
  const right = new Float32Array(x.length);
  right.set(x.subarray(0, x.length - d), d);
  return [x, right];
}

export const uiSounds = {
  'ui.hover': ui('Hover', (r) => mulInPlace(svf(noise(r.sr, 0.03, r.rng), r.sr, 'bp', 2400, 2), decayEnv(r.sr, 0.03, 0.008, 0.0002)), { gain: 0.12, cooldown: 0.05 }),
  'ui.click': ui('Click', (r) => switchClick(r, 2200), { gain: 0.35 }),
  'ui.back': ui('Back', (r) => switchClick(r, 1500, 1.3), { gain: 0.32 }),
  'ui.toggle': ui('Switch', (r) => sequence(r, 0.1, [[0, switchClick(r, 2600), 1], [0.03, clack(r, 1800, 0.8, 0.04), 0.4]]), { gain: 0.35 }),
  'ui.tick': ui('Slider tick', (r) => switchClick(r, 3000, 0.4), { gain: 0.15, cooldown: 0.04 }),
  'ui.toast': ui('Toast (radio in)', (r) => sequence(r, 0.2, [[0, squelch(r, 0.06), 0.6], [0.06, radioBlip(r, 1200, 0.05), 0.8]]), { gain: 0.35, cooldown: 0.3 }),
  'ui.error': ui('Error', (r) => sequence(r, 0.35, [[0, squelch(r, 0.05), 0.5], [0.05, radioBlip(r, 320, 0.1), 1], [0.18, radioBlip(r, 280, 0.12), 1]]), { gain: 0.35, cooldown: 0.3 }),
  'ui.ready': ui('Ready (stamp)', (r) => sequence(r, 0.3, [[0, thump(r, 0.15, 160, 60, 0.07), 1], [0, clack(r, 1500, 0.8, 0.1), 0.8], [0.06, radioBlip(r, 1000, 0.04), 0.4]]), { gain: 0.4 }),
  'ui.join': ui('A player joins (radio)', (r) => sequence(r, 0.2, [[0, squelch(r, 0.04), 0.5], [0.04, radioBlip(r, 900, 0.04), 0.7], [0.1, radioBlip(r, 1200, 0.04), 0.7]]), { gain: 0.28, cooldown: 0.15 }),
  'ui.leave': ui('A player leaves (radio)', (r) => sequence(r, 0.25, [[0, radioBlip(r, 1000, 0.04), 0.7], [0.07, radioBlip(r, 700, 0.05), 0.7], [0.13, squelch(r, 0.05), 0.5]]), { gain: 0.25, cooldown: 0.15 }),
  'ui.count': ui('Countdown: 3, 2, 1', (r) =>
    sequence(r, 0.45, [
      [0, drum(r, 70, 0.4), 1],
      [0, clack(r, 1400, 0.9, 0.06), 0.35],
    ]),
  { gain: 0.55, cooldown: 0.2, priority: 80 }),
  'ui.go': ui('GO', (r) => {
    const { sr, rng } = r;
    const hit = sequence(r, 1.4, [
      [0, thump(r, 1, 70, 24, 0.5), 1.2],
      [0, drum(r, 55, 0.8), 0.9],
      [0, mulInPlace(svf(noise(sr, 0.5, rng), sr, 'lp', sweep(5000, 300, 0.4)), decayEnv(sr, 0.5, 0.35, 0.001)), 0.6],
      [0, darkBrass(r, [38, 45, 50, 51], 1.3, 900), 0.6],
      [0.02, clack(r, 900, 0.6, 0.15), 0.5],
    ]);
    return reverb(hit, sr, { size: 0.9, decay: 1.6, wet: 0.35, tail: 0.6 });
  }, { gain: 0.65, priority: 85 }),
  'ui.flood': ui('Match start: flood', (r) => {
    // a dark riser: rushing air and a sub swelling up into the countdown
    const { sr, rng } = r;
    const air = mulInPlace(svf(noise(sr, 0.45, rng, 'pink'), sr, 'bp', sweep(200, 2000, 0.42), 0.8), linEnv(sr, 0.45, [[0, 0], [0.38, 1], [0.45, 0]]));
    const sub = mulInPlace(osc(sr, 0.45, 'sine', sweep(35, 70, 0.4)), linEnv(sr, 0.45, [[0, 0], [0.4, 1], [0.45, 0]]));
    return sequence(r, 0.75, [
      [0, air, 1],
      [0, sub, 0.7],
      [0.38, drum(r, 60, 0.35), 0.8],
    ]);
  }, { gain: 0.5, priority: 70 }),
  'ui.win': ui('Results: you won', (r) => {
    // won, but it's war: two heavy drums and a low suspended swell, no fanfare
    const s = sequence(r, 2.6, [
      [0, drum(r, 60, 0.8), 1],
      [0.42, drum(r, 60, 0.8), 1],
      [0.42, darkBrass(r, [38, 45, 50, 52], 2, 1600), 0.7],
    ]);
    return widen(r, reverb(s, r.sr, { size: 0.9, decay: 1.8, wet: 0.35, tail: 0.6 }));
  }, { gain: 0.55, priority: 60 }),
  'ui.lose': ui('Results: match over', (r) => {
    const s = sequence(r, 2.4, [
      [0, drum(r, 55, 0.9), 1],
      [0.1, darkBrass(r, [38, 41, 44, 45], 2.1, 900), 0.7],
    ]);
    return widen(r, reverb(s, r.sr, { size: 0.9, decay: 1.8, wet: 0.35, tail: 0.6 }));
  }, { gain: 0.5, priority: 60 }),
  // ---------------------------------------------------------------- map events
  'event.warn': ui('Map event: warning (siren)', (r) => {
    // an air-raid siren: a slow wail up and down, harsh and band-limited
    const { sr } = r;
    const len = 2;
    const f = (t: number) => 330 + 260 * Math.sin(Math.min(1, t / len) * Math.PI);
    const tone = osc(sr, len, 'saw', f);
    mixInto(tone, osc(sr, len, 'square', (t) => f(t) * 1.005), sr, 0, 0.5);
    const band = clipInPlace(svf(tone, sr, 'bp', (t) => f(t) * 2, 1.5), 0.7);
    return fadeInPlace(mulInPlace(band, linEnv(sr, len, [[0, 0], [0.2, 1], [1.6, 0.9], [len, 0]])), sr, 0.01, 0.05);
  }, { gain: 0.3, cooldown: 1, priority: 75 }),
  'event.start': ui('Map event: starts', (r) => sequence(r, 1.3, [[0, drum(r, 50, 1), 1], [0, darkBrass(r, [38, 39, 45], 1.2, 800), 0.6], [0.05, squelch(r, 0.12), 0.3]]), { gain: 0.45, cooldown: 1, priority: 75 }),
  'event.end': ui('Map event: ends (radio)', (r) => sequence(r, 0.3, [[0, squelch(r, 0.05), 0.5], [0.06, radioBlip(r, 800, 0.08), 0.8]]), { gain: 0.3, cooldown: 1 }),
  // ---------------------------------------------------------------- music stings (the bed is live: music.ts)
  'sting.start': {
    label: 'Sting: match start',
    group: 'Music',
    bus: 'music',
    render: (r) => {
      // a reversed rush into a war drum and a low, dissonant brass cluster (D, A, E-flat)
      const { sr, rng } = r;
      const swell = reversed(mulInPlace(svf(noise(sr, 0.8, rng, 'pink'), sr, 'bp', 1200, 0.6), decayEnv(sr, 0.8, 0.7)));
      const s = sequence(r, 3, [
        [0, swell, 0.45],
        [0.8, thump(r, 1.2, 65, 22, 0.8), 1.2],
        [0.8, drum(r, 52, 1), 0.9],
        [0.8, darkBrass(r, [26, 38, 45, 51], 2, 1200), 0.85],
        [1.35, drum(r, 52, 0.8), 0.7],
        [1.6, drum(r, 46, 0.9), 0.6],
      ]);
      return widen(r, reverb(s, sr, { size: 1, decay: 2.2, wet: 0.35, tail: 0.6 }));
    },
    gain: 0.75,
    maxVoices: 1,
    cooldown: 1,
    priority: 90,
    pitchJitter: 0,
  },
  // ---------------------------------------------------------------- the music bed's instruments
  'music.drum': { label: 'Music: war drum', group: 'Music', bus: 'music', render: (r) => drum(r, 55, 0.7), variants: 2, gain: 0.6, maxVoices: 3, cooldown: 0, priority: 20, pitchJitter: 0.01 },
  'music.snare': {
    label: 'Music: military snare',
    group: 'Music',
    bus: 'music',
    // a dry field snare, low in the mix: wires and a short body
    render: (r) => sequence(r, 0.2, [[0, mulInPlace(svf(noise(r.sr, 0.18, r.rng), r.sr, 'bp', 2600, 0.6), decayEnv(r.sr, 0.18, 0.1, 0.001)), 1], [0, thump(r, 0.08, 230, 160, 0.03), 0.4]]),
    variants: 3,
    gain: 0.22,
    maxVoices: 4,
    cooldown: 0,
    priority: 15,
  },
  'music.tick': { label: 'Music: clock tick', group: 'Music', bus: 'music', render: (r) => clack(r, 3200, 1, 0.03), variants: 2, gain: 0.1, maxVoices: 2, cooldown: 0, priority: 10 },
  'music.hit': {
    label: 'Music: low metal hit (D, pitched)',
    group: 'Music',
    bus: 'music',
    // a struck steel plate, low: the bed's sparse melodic hits
    render: (r) => {
      const s = sequence(r, 1.6, [
        [0, mulInPlace(osc(r.sr, 1.6, 'sine', mtof(50)), decayEnv(r.sr, 1.6, 1.2, 0.002)), 0.8],
        [0, mulInPlace(osc(r.sr, 1.6, 'sine', mtof(50) * 2.76), decayEnv(r.sr, 1.6, 0.5, 0.002)), 0.3],
        [0, mulInPlace(osc(r.sr, 1.6, 'sine', mtof(50) * 5.4), decayEnv(r.sr, 1.6, 0.2, 0.001)), 0.12],
        [0, clack(r, 700, 0.5, 0.05), 0.2],
      ]);
      return reverb(s, r.sr, { size: 0.8, decay: 1.5, wet: 0.3, tail: 0.4 });
    },
    gain: 0.3,
    maxVoices: 3,
    cooldown: 0,
    priority: 20,
    pitchJitter: 0,
  },
} satisfies Record<string, SoundDef>;
