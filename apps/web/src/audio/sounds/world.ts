/**
 * The world: grenades and blasts, the jetpack and dash, footsteps, hits and kills, the riot
 * shield, pickups, bullets landing, and the soldiers' voices.
 */
import { crackle, decayEnv, driveInPlace, fadeInPlace, linEnv, mixInto, modal, mulInPlace, noise, osc, seamless, svf, sweep, wanderInPlace } from '../dsp';
import { beep, boom, clack, clipInPlace, sequence, slide, thump, whoosh, type BoomParams } from './kit';
import { recordedFoley, recordedRicochet, recordedVoice, recordedWorld } from '../recordings/render';
import type { RenderCtx, SoundDef } from './types';

// Deep, heavy and long: a war film's blasts, not a game's pops
const FRAG: BoomParams = { len: 2.4, low: [70, 20], lowT60: 0.9, lowGain: 1.2, bodyCut: [4200, 140], bodyT60: 1, bodyGain: 1, crack: 0.9, debrisRate: 110, debris: 0.45, wet: 0.55, decay: 2.2, drive: 3.5, rumble: 0.6, ring: 0.05 };
const ROCKET: BoomParams = { ...FRAG, len: 2.8, low: [60, 18], lowT60: 1.1, lowGain: 1.3, bodyT60: 1.3, debrisRate: 140, debris: 0.55, decay: 2.6, drive: 4, rumble: 0.8, ring: 0.06 };
const MINE: BoomParams = { ...FRAG, len: 2.2, low: [85, 22], crack: 1.1, debris: 0.4, rumble: 0.5 };

const blast = (label: string, group: string, render: (r: RenderCtx) => Float32Array, extra: Partial<SoundDef> = {}): SoundDef => ({
  label,
  group,
  bus: 'big',
  render,
  variants: 2,
  gain: 1,
  peak: 0.95,
  maxVoices: 4,
  cooldown: 0.03,
  priority: 90,
  range: 110,
  soft: 0.45,
  ...extra,
});

const sfx = (label: string, group: string, render: (r: RenderCtx) => Float32Array, extra: Partial<SoundDef> = {}): SoundDef => ({ label, group, bus: 'sfx', render, variants: 2, maxVoices: 4, ...extra });

/** A hiss loop (smoke, gas): high-passed noise with a slow wander. */
function hissLoop(r: RenderCtx, cut: number, bubbles: number): Float32Array {
  const { sr, rng } = r;
  const h = wanderInPlace(svf(noise(sr, 2.2, rng), sr, cut > 2000 ? 'hp' : 'bp', cut, 0.7), sr, rng, 0.3, 3);
  if (bubbles > 0) mixInto(h, svf(crackle(sr, 2.2, rng, 25, 0.01), sr, 'lp', 600), sr, 0, bubbles);
  return seamless(h, sr, 0.3);
}

/** A metallic bounce off the ground (grenades, shells): a clank at a random pitch. */
function bounce(r: RenderCtx, f: number): Float32Array {
  return sequence(r, 0.25, [
    [0, clack(r, r.rng.jitter(f, 0.12), 0.75, 0.2), 1],
    [0, thump(r, 0.08, 220, 120, 0.03), 0.5],
  ]);
}

/** Footsteps: a soft heel thud and a gritty scuff (four feet: alternate variants). */
function step(r: RenderCtx, weight: number): Float32Array {
  const { sr, rng } = r;
  const scuff = mulInPlace(svf(noise(sr, 0.07, rng), sr, 'bp', rng.range(1500, 2600), 1.1), decayEnv(sr, 0.07, 0.035, 0.002));
  const grit = mulInPlace(svf(crackle(sr, 0.06, rng, 250, 0.0008), sr, 'hp', 3000), decayEnv(sr, 0.06, 0.04));
  return sequence(r, 0.14, [
    [0, thump(r, 0.1, rng.range(95, 120) * (1.2 - weight * 0.3), 60, 0.04), 0.9 * weight],
    [0.004, scuff, 0.5],
    [0.006, grit, 0.25],
  ]);
}

export const worldSounds = {
  // ---------------------------------------------------------------- grenades
  'grenade.throw': sfx('Grenade: throw', 'Grenades', (r) =>
    sequence(r, 0.4, [
      [0, modal(r.sr, 0.18, r.rng.jitter(3600, 0.03), [[1, 1, 0.06], [2.3, 0.5, 0.04]], r.rng), 0.35],
      [0.05, whoosh(r, 0.28, 400, 1600, 1.2, 0.45), 0.8],
    ]),
  { gain: 0.6, range: 30, priority: 55 }),
  'grenade.bounce': sfx('Grenade: bounce', 'Grenades', (r) => bounce(r, 1300), { variants: 4, gain: 0.5, range: 30, cooldown: 0.04, maxVoices: 5, priority: 40 }),
  'frag.explode': blast('Frag: explosion', 'Grenades', (r) => boom(r, FRAG), { far: 'distant.boom', farFrom: 35, farTo: 100 }),
  'smoke.pop': blast('Smoke: pop', 'Grenades', (r) =>
    sequence(r, 0.8, [
      [0, thump(r, 0.3, 160, 70, 0.1), 0.8],
      [0, mulInPlace(svf(noise(r.sr, 0.7, r.rng), r.sr, 'hp', 2500), linEnv(r.sr, 0.7, [[0, 0], [0.03, 1], [0.7, 0.25]])), 0.6],
      [0, clack(r, 1800, 0.6, 0.05), 0.3],
    ]),
  { bus: 'sfx', gain: 0.7, soft: 1, priority: 60, range: 60 }),
  'smoke.hiss': { ...sfx('Smoke: hiss (loop)', 'Grenades', (r) => hissLoop(r, 4500, 0), { gain: 0.3, range: 30, priority: 30 }), loop: true, variants: 1 },
  'gas.pop': blast('Gas: pop', 'Grenades', (r) =>
    sequence(r, 0.8, [
      [0, thump(r, 0.3, 130, 60, 0.12), 0.8],
      [0, mulInPlace(svf(noise(r.sr, 0.7, r.rng), r.sr, 'bp', 1400, 0.9), linEnv(r.sr, 0.7, [[0, 0], [0.04, 1], [0.7, 0.3]])), 0.6],
    ]),
  { bus: 'sfx', gain: 0.7, soft: 1, priority: 60, range: 60 }),
  'gas.hiss': { ...sfx('Gas: hiss (loop)', 'Grenades', (r) => hissLoop(r, 1600, 0.5), { gain: 0.3, range: 30, priority: 30 }), loop: true, variants: 1 },
  'flash.bang': blast('Flashbang: bang', 'Grenades', (r) => {
    const { sr, rng } = r;
    const crack = mulInPlace(svf(noise(sr, 0.5, rng), sr, 'hp', 1200), decayEnv(sr, 0.5, 0.18, 0.0002));
    return sequence(r, 1.2, [
      [0, crack, 1.2],
      [0, boom(r, { ...FRAG, len: 1, lowGain: 0.6, bodyGain: 0.5, debris: 0, wet: 0.35, decay: 1 }), 0.7],
      [0, modal(sr, 0.9, 3100, [[1, 0.4, 0.4], [1.51, 0.3, 0.3]], rng), 0.2],
    ]);
  }),
  'flash.ring': {
    label: 'Flashbang: ears ringing',
    group: 'Grenades',
    bus: 'voice',
    render: (r) => {
      const { sr } = r;
      const t = osc(sr, 3, 'sine', (s) => 3520 + 12 * Math.sin(s * 9));
      mixInto(t, osc(sr, 3, 'sine', 3532), sr, 0, 0.6);
      return fadeInPlace(mulInPlace(t, linEnv(sr, 3, [[0, 0], [0.05, 1], [0.8, 0.6], [3, 0]])), sr, 0.01, 0.1);
    },
    gain: 0.18,
    peak: 0.6,
    maxVoices: 1,
    cooldown: 1,
    priority: 85,
    soft: 0,
    pitchJitter: 0,
  },
  'emp.burst': blast('EMP: burst', 'Grenades', (r) => {
    const { sr, rng } = r;
    const down = svf(osc(sr, 1.2, 'saw', sweep(1600, 40, 0.9)), sr, 'lp', sweep(6000, 300, 1), 4);
    mulInPlace(down, decayEnv(sr, 1.2, 1, 0.002));
    const cr = mulInPlace(svf(crackle(sr, 1.2, rng, 400, 0.0012), sr, 'hp', 2200), decayEnv(sr, 1.2, 0.8));
    return sequence(r, 1.3, [
      [0, thump(r, 0.6, 120, 35, 0.35), 1],
      [0, down, 0.6],
      [0, cr, 0.7],
    ]);
  }),
  'mine.arm': sfx('Mine: stuck and arming', 'Grenades', (r) =>
    sequence(r, 0.5, [
      [0, clack(r, 900, 0.5, 0.1), 0.8],
      [0.15, radioBlip(r, 1980, 0.05), 0.5],
      [0.3, radioBlip(r, 1980, 0.05), 0.5],
    ]),
  { gain: 0.55, range: 25, variants: 1, priority: 55 }),
  'mine.armed': sfx('Mine: armed', 'Grenades', (r) => radioBlip(r, 2400, 0.07), { gain: 0.45, range: 20, variants: 1, cooldown: 0.3, priority: 50 }),
  'mine.trigger': sfx('Mine: triggered', 'Grenades', (r) =>
    sequence(r, 0.35, [
      [0, clack(r, 2500, 1, 0.04), 0.8],
      ...[0, 1, 2, 3, 4].map((i) => [0.04 + i * 0.05, beep(r, 2000 + i * 300, 0.04, 'square', 0.03), 0.25] as const),
    ]),
  { gain: 0.65, range: 30, variants: 1, priority: 80 }),
  'mine.explode': blast('Mine: explosion', 'Grenades', (r) => boom(r, MINE), { far: 'distant.boom', farFrom: 35, farTo: 100 }),
  'rocket.explode': blast('Rocket: explosion', 'Grenades', (r) => boom(r, ROCKET), { range: 130, far: 'distant.boom', farFrom: 40, farTo: 110 }),
  'shell.explode': blast('Launcher shell: explosion', 'Grenades', (r) => boom(r, { ...FRAG, len: 1.6, low: [100, 30] }), { far: 'distant.boom', farFrom: 35, farTo: 100 }),
  'orb.burst': blast('Orb: EMP burst', 'Grenades', (r) =>
    sequence(r, 1, [
      [0, thump(r, 0.5, 200, 50, 0.25), 0.8],
      [0, mulInPlace(svf(osc(r.sr, 0.9, 'saw', sweep(2400, 80, 0.7)), r.sr, 'bp', sweep(3000, 200, 0.8), 3), decayEnv(r.sr, 0.9, 0.7)), 0.7],
      [0, mulInPlace(svf(crackle(r.sr, 0.9, r.rng, 300, 0.001), r.sr, 'hp', 2500), decayEnv(r.sr, 0.9, 0.6)), 0.6],
    ]),
  { soft: 0.6 }),
  // ---------------------------------------------------------------- off screen (the server's coarse SOUND events)
  'distant.gun': sfx('Gunfire off screen', 'Off screen', (r) => {
    const { sr, rng } = r;
    const b = mulInPlace(svf(noise(sr, 0.6, rng, 'pink'), sr, 'lp', 700, 0.8), decayEnv(sr, 0.6, 0.35, 0.004));
    return sequence(r, 0.9, [
      [0, b, 1],
      [0, thump(r, 0.3, 90, 45, 0.2), 0.7],
      [0.14, b, 0.3],
    ]);
  }, { variants: 3, gain: 0.8, range: 400, maxVoices: 4, cooldown: 0.04, priority: 20, wet: 0.4 }),
  'distant.boom': sfx('Blast off screen', 'Off screen', (r) => {
    const s = boom(r, { ...FRAG, bodyCut: [900, 120], crack: 0, debris: 0, wet: 0.6, decay: 2 });
    return s;
  }, { gain: 1, range: 400, maxVoices: 3, cooldown: 0.1, priority: 30, wet: 0.4 }),
  // ---------------------------------------------------------------- jetpack and dash
  'jet.start': sfx('Jetpack: ignite', 'Movement', (r) => {
    // the igniter's crack, a combustion cough, the turbine catching
    const { sr, rng } = r;
    const cough = clipInPlace(mulInPlace(svf(noise(sr, 0.35, rng, 'brown'), sr, 'lp', sweep(300, 1400, 0.25), 1.2), linEnv(sr, 0.35, [[0, 0], [0.03, 1], [0.12, 0.6], [0.35, 0]])), 0.6);
    return sequence(r, 0.55, [
      [0, clack(r, 2600, 1, 0.03), 0.35],
      [0.01, cough, 1.2],
      [0.02, thump(r, 0.3, 90, 40, 0.16), 0.9],
      [0.08, turbine(r, 0.45, 300, 1100), 0.25],
    ]);
  }, { gain: 0.6, range: 35, priority: 55 }),
  'jet.loop': {
    label: 'Jetpack: thrust (loop)',
    group: 'Movement',
    bus: 'sfx',
    render: (r) => {
      const { sr, rng } = r;
      const out = recordedWorld('jet_loop', sr);
      const air = wanderInPlace(svf(noise(sr, out.length / sr, rng, 'brown'), sr, 'lp', 750, 0.8), sr, rng, 0.12, 6);
      mixInto(out, air, sr, 0, 0.14);
      return seamless(out, sr, 0.25);
    },
    loop: true,
    gain: 0.32,
    maxVoices: 4,
    range: 35,
    priority: 50,
  },
  'jet.stop': sfx('Jetpack: cut off', 'Movement', (r) => {
    const tail = recordedWorld('jet_stop', r.sr);
    return mulInPlace(tail, linEnv(r.sr, tail.length / r.sr, [[0, 1], [0.12, 0.8], [tail.length / r.sr, 0]]));
  }, { gain: 0.45, range: 30, priority: 40 }),
  'jet.lowfuel': {
    label: 'Jetpack: low fuel',
    group: 'Movement',
    bus: 'ui',
    render: (r) => sequence(r, 0.3, [[0, radioBlip(r, 760, 0.06), 1], [0.11, radioBlip(r, 760, 0.06), 1]]),
    gain: 0.35,
    maxVoices: 1,
    cooldown: 0.4,
    priority: 75,
    pitchJitter: 0,
  },
  'jet.sputter': sfx('Jetpack: knocked out (EMP)', 'Movement', (r) =>
    sequence(r, 0.75, [0, 0.2, 0.43].map((t, i) => [t, recordedWorld('jet_start', r.sr).subarray(0, Math.round(r.sr * 0.2)), 0.7 - i * 0.2] as const)),
  { gain: 0.55, range: 25, priority: 70, variants: 1 }),
  dash: sfx('Dash', 'Movement', (r) => burst(r, 1), { variants: 3, gain: 0.65, range: 30, priority: 60 }),
  'dash.chain': sfx('Dash: chained', 'Movement', (r) =>
    sequence(r, 0.45, [
      [0, burst(r, 1.2), 1],
      // a valve venting: the pack's pressure dumped again
      [0.03, mulInPlace(svf(noise(r.sr, 0.18, r.rng), r.sr, 'hp', 3500), linEnv(r.sr, 0.18, [[0, 0], [0.02, 1], [0.18, 0]])), 0.25],
    ]),
  { variants: 3, gain: 0.65, range: 30, priority: 62 }),
  step: sfx('Footstep', 'Movement', (r) => step(r, 1), { variants: 4, gain: 0.3, range: 18, maxVoices: 6, cooldown: 0.05, priority: 15 }),
  land: sfx('Landing', 'Movement', (r) =>
    sequence(r, 0.3, [
      [0, step(r, 1.4), 1],
      [0.02, mulInPlace(svf(crackle(r.sr, 0.15, r.rng, 120, 0.002), r.sr, 'bp', 2000), decayEnv(r.sr, 0.15, 0.1)), 0.3],
    ]),
  { variants: 2, gain: 0.45, range: 22, priority: 30 }),
  'land.hard': sfx('Landing: hard', 'Movement', (r) =>
    sequence(r, 0.45, [
      [0, thump(r, 0.3, 120, 40, 0.16), 1],
      [0, step(r, 1.6), 0.8],
      [0.03, clack(r, 700, 0.4, 0.12), 0.4],
    ]),
  { variants: 2, gain: 0.6, range: 25, priority: 40 }),
  // ---------------------------------------------------------------- bullets landing
  'impact.wall': sfx('Bullet: hits a wall', 'Impacts', (r) => {
    const { sr, rng } = r;
    const chip = mulInPlace(svf(noise(sr, 0.12, rng), sr, 'bp', rng.range(1200, 2600), 0.65), decayEnv(sr, 0.12, 0.035, 0.0003));
    const knock = mulInPlace(svf(noise(sr, 0.08, rng, 'pink'), sr, 'lp', rng.range(420, 720), 0.7), decayEnv(sr, 0.08, 0.025, 0.0002));
    return sequence(r, 0.2, [
      [0, chip, 0.8],
      [0, knock, 0.8],
      [0.008, mulInPlace(svf(crackle(sr, 0.12, rng, 100, 0.001), sr, 'hp', 1800), decayEnv(sr, 0.12, 0.07)), 0.3],
    ]);
  }, { variants: 4, gain: 0.3, range: 22, maxVoices: 5, cooldown: 0.03, priority: 20 }),
  'impact.body': sfx('Bullet: hits someone', 'Impacts', (r) => {
    const { sr, rng } = r;
    const slap = mulInPlace(svf(noise(sr, 0.12, rng), sr, 'lp', 1500, 1), decayEnv(sr, 0.12, 0.05, 0.0003));
    return sequence(r, 0.2, [
      [0, mulInPlace(svf(noise(sr, 0.12, rng, 'pink'), sr, 'lp', 350), decayEnv(sr, 0.12, 0.055, 0.0003)), 0.9],
      [0, slap, 1],
      [0.002, mulInPlace(svf(noise(sr, 0.03, rng), sr, 'bp', 3000, 1), decayEnv(sr, 0.03, 0.01)), 0.3],
    ]);
  }, { variants: 4, gain: 0.45, range: 30, maxVoices: 4, cooldown: 0.03, priority: 35 }),
  whiz: sfx('Bullet: cracks past you', 'Impacts', (r) => {
    // a near miss: the supersonic snap of the round, then its tearing whiz away
    const { sr, rng } = r;
    const snap = mulInPlace(svf(noise(sr, 0.03, rng), sr, 'hp', 3000), decayEnv(sr, 0.03, 0.006, 0.0001));
    const w = svf(noise(sr, 0.12, rng), sr, 'bp', sweep(rng.range(3500, 4600), 1100, 0.12), 0.8);
    return sequence(r, 0.22, [
      [0, snap, 1.5],
      [0.004, fadeInPlace(mulInPlace(w, linEnv(sr, 0.12, [[0, 1], [0.12, 0]])), sr, 0.001, 0.01), 0.45],
    ]);
  }, { variants: 4, gain: 0.5, maxVoices: 3, cooldown: 0.06, priority: 55 }),
  ricochet: sfx('Ricochet', 'Impacts', (r) => recordedRicochet(r.v, r.sr),
    { variants: 4, gain: 0.45, range: 35, cooldown: 0.05, priority: 45, pitchJitter: 0.035 }),
  // ---------------------------------------------------------------- the riot shield
  'shield.hit': sfx('Shield: takes a hit', 'Shield', (r) =>
    sequence(r, 0.4, [[0, recordedWorld(r.v % 2 ? 'metal_hit' : 'metal_heavy', r.sr), 1],
      [0, mulInPlace(svf(noise(r.sr, 0.08, r.rng, 'pink'), r.sr, 'lp', 500), decayEnv(r.sr, 0.08, 0.035)), 0.25]]),
  { variants: 4, gain: 0.55, range: 35, maxVoices: 5, cooldown: 0.025, priority: 55 }),
  'shield.break': blast('Shield: breaks', 'Shield', (r) => {
    const { sr, rng } = r;
    return sequence(r, 1.3, [
      [0, recordedWorld('metal_heavy', sr), 0.9],
      [0.03, recordedWorld('metal_break', sr), 0.6],
      [0.06, mulInPlace(svf(crackle(sr, 0.55, rng, 90, 0.002), sr, 'hp', 1800), decayEnv(sr, 0.55, 0.27)), 0.25],
    ]);
  }, { bus: 'sfx', soft: 0.7, gain: 0.8, priority: 85, range: 50 }),
  'shield.raise': sfx('Shield: raised', 'Shield', (r) =>
    sequence(r, 0.45, [
      [0, slide(r, 0.2, 500, 1100, 0.8), 0.22],
      [0.14, recordedWorld('metal_heavy', r.sr), 0.75],
    ]),
  { gain: 0.45, range: 20, priority: 40 }),
  // ---------------------------------------------------------------- pickups
  'pickup.shield': sfx('Pickup: riot shield', 'Pickups', (r) =>
    sequence(r, 0.55, [[0, recordedWorld('metal_heavy', r.sr), 0.7],
      [0.16, recordedFoley('rifle_release', r.sr), 0.3]]),
  { gain: 0.6, range: 20, priority: 60, variants: 1 }),
  'pickup.grenades': sfx('Pickup: grenades', 'Pickups', (r) =>
    sequence(r, 0.35, [[0, recordedFoley('mag_release', r.sr), 0.55],
      [0.11, recordedWorld('metal_hit', r.sr), 0.5]]),
  { gain: 0.6, range: 20, priority: 60, variants: 1 }),
  'pickup.weapon': sfx('Pickup: weapon crate swap', 'Pickups', (r) =>
    sequence(r, 0.7, [[0, recordedWorld('metal_heavy', r.sr), 0.45],
      [0.12, recordedFoley('rifle_release', r.sr), 0.55],
      [0.35, recordedFoley('mag_seat', r.sr), 0.65]]),
  { gain: 0.65, range: 20, priority: 60, variants: 1 }),
  spawn: sfx('Spawn', 'Pickups', (r) =>
    // dropped in: the pack's thrust, boots on the ground, a weapon brought up
    sequence(r, 0.7, [
      [0, burst(r, 0.8), 0.6],
      [0.28, thump(r, 0.25, 120, 50, 0.12), 0.8],
      [0.3, recordedFoley('rifle_release', r.sr), 0.3],
      [0.42, recordedFoley('mag_seat', r.sr), 0.22],
    ]),
  { gain: 0.5, range: 25, priority: 50, variants: 1, pitchJitter: 0 }),
  // ---------------------------------------------------------------- hits, kills, and being hit
  'hit.taken': sfx('You: hit', 'Combat', (r) => {
    const { sr, rng } = r;
    return sequence(r, 0.4, [
      [0, recordedWorld(r.v % 2 ? 'metal_hit' : 'metal_heavy', sr), 0.7],
      [0, mulInPlace(svf(noise(sr, 0.13, rng, 'pink'), sr, 'lp', 900), decayEnv(sr, 0.13, 0.05)), 0.35],
    ]);
  }, { variants: 4, gain: 0.8, maxVoices: 2, cooldown: 0.06, priority: 88 }),
  'hit.marker': {
    label: 'Your hit lands',
    group: 'Combat',
    bus: 'ui',
    render: (r) => sequence(r, 0.14, [[0, recordedWorld('metal_hit', r.sr), 0.45],
      [0, mulInPlace(svf(noise(r.sr, 0.03, r.rng), r.sr, 'bp', 1400, 0.8), decayEnv(r.sr, 0.03, 0.009)), 0.28]]),
    variants: 2,
    gain: 0.4,
    maxVoices: 2,
    cooldown: 0.05,
    priority: 70,
  },
  'hit.head': {
    label: 'Headshot',
    group: 'Combat',
    bus: 'ui',
    render: (r) =>
      sequence(r, 0.3, [[0, recordedWorld('metal_heavy', r.sr), 0.85],
        [0, recordedFoley('mag_release', r.sr), 0.15]]),
    variants: 2,
    gain: 0.5,
    maxVoices: 2,
    cooldown: 0.08,
    priority: 75,
  },
  'kill.confirm': {
    label: 'Kill confirmed',
    group: 'Combat',
    bus: 'ui',
    render: (r) =>
      sequence(r, 0.35, [[0, recordedWorld('metal_hit', r.sr), 0.55],
        [0, mulInPlace(svf(noise(r.sr, 0.22, r.rng, 'brown'), r.sr, 'lp', 430), decayEnv(r.sr, 0.22, 0.13)), 0.55]]),
    variants: 2,
    gain: 0.55,
    maxVoices: 2,
    cooldown: 0.1,
    priority: 80,
    pitchJitter: 0.02,
  },
  'kill.head': {
    label: 'Headshot kill',
    group: 'Combat',
    bus: 'ui',
    render: (r) =>
      sequence(r, 0.42, [[0, recordedWorld('metal_heavy', r.sr), 0.75],
        [0.03, recordedWorld('metal_hit', r.sr), 0.2],
        [0, mulInPlace(svf(noise(r.sr, 0.25, r.rng, 'brown'), r.sr, 'lp', 500), decayEnv(r.sr, 0.25, 0.15)), 0.45]]),
    variants: 2,
    gain: 0.55,
    maxVoices: 2,
    cooldown: 0.1,
    priority: 82,
    pitchJitter: 0.02,
  },
  'death.self': sfx('You: down', 'Combat', (r) =>
    sequence(r, 1.1, [[0, recordedWorld('metal_heavy', r.sr), 0.75],
      [0, mulInPlace(svf(noise(r.sr, 1, r.rng, 'brown'), r.sr, 'lp', sweep(700, 120, 0.9)), decayEnv(r.sr, 1, 0.75)), 0.5]]),
  { variants: 1, gain: 0.75, priority: 95, maxVoices: 1 }),
  'blast.ring': {
    label: 'A blast close by: ears ringing',
    group: 'Grenades',
    bus: 'voice',
    render: (r) => {
      const { sr } = r;
      const f = r.rng.range(3200, 3900);
      const t = osc(sr, 2.2, 'sine', (s) => f + 9 * Math.sin(s * 7));
      mixInto(t, mulInPlace(svf(noise(sr, 2.2, r.rng), sr, 'bp', f, 8), 1), sr, 0, 0.3);
      return fadeInPlace(mulInPlace(t, linEnv(sr, 2.2, [[0, 0], [0.04, 1], [0.6, 0.5], [2.2, 0]])), sr, 0.01, 0.1);
    },
    gain: 0.12,
    peak: 0.6,
    maxVoices: 1,
    cooldown: 1.5,
    priority: 80,
    soft: 0,
    pitchJitter: 0,
  },
  // ---------------------------------------------------------------- voices
  'voice.hurt': {
    label: 'Voice: hurt',
    group: 'Voices',
    bus: 'voice',
    render: (r) => recordedVoice('hurt', r.v, r.sr),
    variants: 4,
    gain: 0.32,
    maxVoices: 2,
    cooldown: 0.7,
    pitchJitter: 0.04,
    priority: 55,
    range: 25,
  },
  'voice.death': {
    label: 'Voice: goes down',
    group: 'Voices',
    bus: 'voice',
    render: (r) => recordedVoice('death', r.v, r.sr),
    variants: 3,
    gain: 0.38,
    maxVoices: 2,
    cooldown: 0.5,
    pitchJitter: 0.035,
    priority: 60,
    range: 35,
  },
  'voice.cough': {
    label: 'Voice: coughing (gas)',
    group: 'Voices',
    bus: 'voice',
    render: (r) => recordedWorld((['cough_1', 'cough_2', 'cough_3'] as const)[r.v % 3]!, r.sr),
    variants: 3,
    gain: 0.38,
    maxVoices: 1,
    cooldown: 1.3,
    priority: 50,
  },
} satisfies Record<string, SoundDef>;

/** A turbine's whine from f0 to f1: a gritty band of noise around a tone. */
function turbine(r: RenderCtx, len: number, f0: number, f1: number): Float32Array {
  const { sr, rng } = r;
  const f = sweep(f0, f1, len);
  const tone = osc(sr, len, 'saw', (t) => f(t) * (1 + 0.004 * Math.sin(t * 40)));
  const band = svf(tone, sr, 'bp', (t) => f(t) * 2, 4);
  mixInto(band, svf(noise(sr, len, rng), sr, 'bp', (t) => f(t) * 3, 6), sr, 0, 0.5);
  return fadeInPlace(band, sr, 0.01, 0.02);
}

/** A hard burst of air and thrust (the dash): a pressure thump, a short roar, grit. */
function burst(r: RenderCtx, weight: number): Float32Array {
  const { sr, rng } = r;
  const len = 0.32;
  const air = clipInPlace(driveInPlace(mulInPlace(svf(noise(sr, len, rng, 'pink'), sr, 'bp', sweep(rng.range(500, 700), 2200, 0.08), 0.7), linEnv(sr, len, [[0, 0], [0.012, 1], [0.08, 0.55], [len, 0]])), 2), 0.7);
  return sequence(r, 0.4, [
    [0, air, 1],
    [0, thump(r, 0.2, 120 / weight, 45, 0.08), 0.9 * weight],
    [0, mulInPlace(svf(noise(sr, 0.04, rng), sr, 'hp', 2500), decayEnv(sr, 0.04, 0.012, 0.0002)), 0.5],
  ]);
}

/** A radio blip: a short square tone through a telephone band, with a hiss of static. */
export function radioBlip(r: RenderCtx, f: number, len: number): Float32Array {
  const { sr, rng } = r;
  const t = osc(sr, len + 0.02, 'square', f);
  mixInto(t, noise(sr, len + 0.02, rng), sr, 0, 0.25);
  const band = svf(svf(t, sr, 'hp', 400, 0.7), sr, 'lp', 2800, 0.7);
  return fadeInPlace(mulInPlace(clipInPlace(band, 0.6), linEnv(sr, len + 0.02, [[0, 0], [0.003, 1], [len, 0.8], [len + 0.02, 0]])), sr, 0.001, 0.004);
}
