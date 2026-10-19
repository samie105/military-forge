/**
 * Weapons: each family's fire, reload parts, empty click and draw. Guns share families
 * (families.ts maps every weapon to one, with a pitch and level of its own).
 */
import { crackle, decayEnv, fadeInPlace, linEnv, mixInto, modal, mulInPlace, noise, osc, seamless, svf, sweep, tremoloInPlace, wanderInPlace } from '../dsp';
import { clack, gunshot, sequence, slide, thump, whoosh, type GunParams } from './kit';
import type { RenderCtx, SoundDef } from './types';

const G = 'Weapons';

// Each family's weight (the owner: "hard boiled … like war"): a pistol snaps, a rifle cracks, an
// SMG chatters, an LMG chugs, a shotgun booms, a sniper cracks and rolls away in echoes.
const PISTOL: GunParams = { len: 0.5, crack: 0.9, crackLen: 0.004, body: 1, bodyT60: 0.07, bodyCut: [6500, 380], bodySweep: 0.05, thump: 0.9, thumpF: [150, 48], thumpT60: 0.1, sub: 0.5, mech: 0.35, mechF: 3400, tail: 0.3, tailT60: 0.4, tailCut: 1100, echo: [0.12, 0.3, 2], drive: 3.2 };
const SMG: GunParams = { len: 0.32, crack: 0.8, crackLen: 0.003, body: 0.95, bodyT60: 0.045, bodyCut: [7000, 700], bodySweep: 0.03, thump: 0.7, thumpF: [170, 65], thumpT60: 0.05, sub: 0.35, mech: 0.4, mechF: 4200, rattle: 0.35, tail: 0.22, tailT60: 0.22, tailCut: 1400, drive: 3.4 };
const RIFLE: GunParams = { len: 0.7, crack: 1.3, crackLen: 0.005, body: 1, bodyT60: 0.09, bodyCut: [8000, 360], bodySweep: 0.06, thump: 1, thumpF: [125, 40], thumpT60: 0.13, sub: 0.7, mech: 0.3, mechF: 3000, rattle: 0.4, tail: 0.38, tailT60: 0.6, tailCut: 1000, echo: [0.14, 0.35, 3], drive: 3.8 };
const SHOTGUN: GunParams = { len: 0.9, crack: 0.9, crackLen: 0.006, body: 1.2, bodyT60: 0.17, bodyCut: [5000, 220], bodySweep: 0.1, thump: 1.2, thumpF: [95, 30], thumpT60: 0.24, sub: 1, mech: 0.2, mechF: 2400, tail: 0.45, tailT60: 0.8, tailCut: 800, echo: [0.16, 0.4, 3], drive: 4.2 };
const SNIPER: GunParams = { len: 1.3, crack: 1.5, crackLen: 0.007, body: 1.1, bodyT60: 0.13, bodyCut: [9000, 300], bodySweep: 0.08, thump: 1.2, thumpF: [100, 30], thumpT60: 0.26, sub: 0.9, mech: 0.25, mechF: 2700, tail: 0.5, tailT60: 1.2, tailCut: 800, echo: [0.24, 0.45, 4], drive: 4 };
const LMG: GunParams = { len: 0.42, crack: 1, crackLen: 0.004, body: 1.1, bodyT60: 0.075, bodyCut: [6000, 420], bodySweep: 0.05, thump: 1.1, thumpF: [105, 36], thumpT60: 0.09, sub: 0.9, mech: 0.35, mechF: 2600, rattle: 0.55, tail: 0.25, tailT60: 0.28, tailCut: 1000, drive: 4.2 };

const gun = (label: string, p: GunParams, extra: Partial<SoundDef> = {}): SoundDef => ({
  label,
  group: G,
  bus: 'sfx',
  render: (r) => gunshot(r, p),
  variants: 3,
  priority: 70,
  range: 70,
  maxVoices: 6,
  cooldown: 0.012,
  // far away: the low report rolling off the buildings takes over from the crack
  far: 'distant.gun',
  ...extra,
});

/** A magazine pulled out: a release click, then the slide out. `size` 0.5 (pistol) … 1.4 (LMG box). */
function magOut(r: RenderCtx, size: number): Float32Array {
  return sequence(r, 0.3, [
    [0, clack(r, 2600 / size, 0.9, 0.06), 0.7],
    [0.02, slide(r, 0.12 * size, 1800, 900, 1.2), 0.5],
  ]);
}

/** A magazine seated: the slide in, a firm clack and a thunk. */
function magIn(r: RenderCtx, size: number): Float32Array {
  return sequence(r, 0.3, [
    [0, slide(r, 0.08 * size, 900, 2000, 1.2), 0.4],
    [0.07 * size, clack(r, 2100 / size, 0.85, 0.09), 1],
    [0.07 * size, thump(r, 0.08, 180 / size, 90, 0.05), 0.6],
  ]);
}

/** A bolt or slide racked: back (click + slide), then home (a harder clack). */
function rack(r: RenderCtx, size: number, gap = 0.09): Float32Array {
  return sequence(r, 0.35, [
    [0, clack(r, 3000 / size, 1, 0.05), 0.6],
    [0.01, slide(r, gap, 2500, 1400, 2), 0.35],
    [gap + 0.01, clack(r, 2400 / size, 1, 0.08), 1],
  ]);
}

/** The dry click of an empty gun. */
function dry(r: RenderCtx, f: number): Float32Array {
  return sequence(r, 0.12, [
    [0, clack(r, f, 1, 0.05), 1],
    [0.0, modal(r.sr, 0.05, f * 0.5, [[1, 0.3, 0.012]], r.rng), 0.4],
  ]);
}

/** Drawing a gun: cloth and a grip, then the gun's own clack. */
function draw(r: RenderCtx, size: number): Float32Array {
  const { sr, rng } = r;
  const cloth = mulInPlace(svf(noise(sr, 0.18, rng, 'pink'), sr, 'bp', sweep(600, 1800, 0.18), 0.9), linEnv(sr, 0.18, [[0, 0], [0.08, 1], [0.18, 0]]));
  return sequence(r, 0.4, [
    [0, cloth, 0.5],
    [0.13, clack(r, 2200 / size, 0.9, 0.1), 0.9],
    [0.2, clack(r, 3600 / size, 1, 0.05), 0.35],
  ]);
}

const part = (label: string, render: (r: RenderCtx) => Float32Array, extra: Partial<SoundDef> = {}): SoundDef => ({ label, group: G, bus: 'sfx', render, variants: 2, gain: 0.55, maxVoices: 3, range: 25, priority: 40, ...extra });

/** A charging whine (Ripper, Pulse): a rising, wobbling tone with a buzz. */
function chargeUp(r: RenderCtx, len: number, f0: number, f1: number, wobble: number): Float32Array {
  const { sr, rng } = r;
  const tone = osc(sr, len, 'saw', (t) => sweep(f0, f1, len)(t) * (1 + 0.01 * Math.sin(t * 2 * Math.PI * wobble)));
  const sig = svf(tone, sr, 'lp', sweep(f0 * 2, f1 * 3, len), 2);
  mixInto(sig, svf(noise(sr, len, rng), sr, 'bp', sweep(f0 * 4, f1 * 4, len), 4), sr, 0, 0.15);
  tremoloInPlace(sig, sr, (t) => 8 + 30 * (t / len), 0.35);
  return fadeInPlace(mulInPlace(sig, linEnv(sr, len, [[0, 0], [len * 0.7, 0.8], [len, 1]])), sr, 0.01, 0.01);
}

/** A loop of fire: a roar (low-passed noise with a wandering level) and crackle. */
function flameLoop(r: RenderCtx, len: number, cut: number, crack: number): Float32Array {
  const { sr, rng } = r;
  const roar = wanderInPlace(svf(noise(sr, len + 0.2, rng, 'pink'), sr, 'lp', cut, 0.8), sr, rng, 0.35, 9);
  mixInto(roar, svf(crackle(sr, len + 0.2, rng, 60, 0.003), sr, 'hp', 1800), sr, 0, crack);
  return seamless(roar, sr, 0.2);
}

export const weaponSounds = {
  // ---------------------------------------------------------------- pistols (Hammer .44, Hawk .50)
  'pistol.fire': gun('Pistol: fire', PISTOL),
  'pistol.magout': part('Pistol: mag out', (r) => magOut(r, 0.7)),
  'pistol.magin': part('Pistol: mag in', (r) => magIn(r, 0.7)),
  'pistol.slide': part('Pistol: slide', (r) => rack(r, 0.7, 0.06)),
  'pistol.empty': part('Pistol: empty click', (r) => dry(r, 3400), { gain: 0.45, cooldown: 0.12, range: 15 }),
  'pistol.draw': part('Pistol: draw', (r) => draw(r, 0.7)),
  // ---------------------------------------------------------------- SMGs (Buzz, Rattler, Hornet)
  'smg.fire': gun('SMG: fire', SMG, { maxVoices: 8, cooldown: 0.01 }),
  'smg.magout': part('SMG: mag out', (r) => magOut(r, 0.85)),
  'smg.magin': part('SMG: mag in', (r) => magIn(r, 0.85)),
  'smg.bolt': part('SMG: bolt', (r) => rack(r, 0.85, 0.07)),
  'smg.empty': part('SMG: empty click', (r) => dry(r, 3000), { gain: 0.45, cooldown: 0.12, range: 15 }),
  'smg.draw': part('SMG: draw', (r) => draw(r, 0.85)),
  // ---------------------------------------------------------------- rifles (K-47, Trident, Bullpup)
  'rifle.fire': gun('Rifle: fire', RIFLE),
  'rifle.magout': part('Rifle: mag out', (r) => magOut(r, 1)),
  'rifle.magin': part('Rifle: mag in', (r) => magIn(r, 1)),
  'rifle.bolt': part('Rifle: charging handle', (r) => rack(r, 1, 0.1)),
  'rifle.empty': part('Rifle: empty click', (r) => dry(r, 2600), { gain: 0.45, cooldown: 0.12, range: 15 }),
  'rifle.draw': part('Rifle: draw', (r) => draw(r, 1)),
  // ---------------------------------------------------------------- shotgun (Breacher)
  'shotgun.fire': gun('Shotgun: fire', SHOTGUN, { maxVoices: 4, cooldown: 0.05 }),
  'shotgun.shell': part('Shotgun: shell in', (r) =>
    sequence(r, 0.2, [
      [0, slide(r, 0.06, 1200, 2400, 1.4), 0.5],
      [0.05, clack(r, 1500, 0.6, 0.08), 0.9],
    ]),
  ),
  'shotgun.pump': part('Shotgun: pump', (r) =>
    sequence(r, 0.4, [
      [0, slide(r, 0.08, 900, 1700, 1.2), 0.6],
      [0.07, clack(r, 1700, 0.9, 0.08), 1],
      [0.16, slide(r, 0.07, 1700, 1000, 1.2), 0.55],
      [0.22, clack(r, 2100, 1, 0.1), 1.1],
    ]),
  { gain: 0.7 }),
  'shotgun.empty': part('Shotgun: empty click', (r) => dry(r, 2200), { gain: 0.45, cooldown: 0.12, range: 15 }),
  'shotgun.draw': part('Shotgun: draw', (r) => draw(r, 1.15)),
  // ---------------------------------------------------------------- sniper and DMR (Widow, Longbow)
  'sniper.fire': gun('Sniper: fire', SNIPER, { maxVoices: 3, cooldown: 0.05, range: 90, priority: 75 }),
  'sniper.bolt': part('Sniper: bolt cycle', (r) =>
    sequence(r, 0.5, [
      [0, clack(r, 2800, 1, 0.05), 0.7],
      [0.05, slide(r, 0.09, 2600, 1500, 2), 0.5],
      [0.15, clack(r, 2000, 1, 0.06), 0.6],
      [0.22, slide(r, 0.08, 1500, 2600, 2), 0.45],
      [0.3, clack(r, 2400, 1, 0.08), 1],
      [0.36, clack(r, 3100, 1, 0.05), 0.6],
    ]),
  { gain: 0.6 }),
  'sniper.magout': part('Sniper: mag out', (r) => magOut(r, 1.05)),
  'sniper.magin': part('Sniper: mag in', (r) => magIn(r, 1.05)),
  'sniper.empty': part('Sniper: empty click', (r) => dry(r, 2400), { gain: 0.45, cooldown: 0.12, range: 15 }),
  'sniper.draw': part('Sniper: draw', (r) => draw(r, 1.25)),
  // ---------------------------------------------------------------- LMG / minigun (Shredder)
  'lmg.fire': gun('LMG: fire', LMG, { maxVoices: 8, cooldown: 0.01 }),
  'lmg.spinup': part('Minigun: spin up', (r) => spin(r, 0.6, 40, 190, 'up'), { gain: 0.6, range: 35 }),
  'lmg.spin': {
    ...part('Minigun: spinning (loop)', (r) => spin(r, 1.2, 190, 190, 'loop'), { gain: 0.5, range: 35 }),
    loop: true,
    variants: 1,
  },
  'lmg.spindown': part('Minigun: spin down', (r) => spin(r, 0.9, 190, 30, 'down'), { gain: 0.55, range: 35 }),
  'lmg.magout': part('LMG: box out', (r) => magOut(r, 1.4)),
  'lmg.magin': part('LMG: box in', (r) => magIn(r, 1.4)),
  'lmg.empty': part('LMG: empty click', (r) => dry(r, 1900), { gain: 0.45, cooldown: 0.12, range: 15 }),
  'lmg.draw': part('LMG: draw', (r) => draw(r, 1.45)),
  // ---------------------------------------------------------------- spent brass on the ground
  'brass.tinkle': {
    label: 'Spent brass on concrete',
    group: G,
    bus: 'sfx',
    render: (r) => {
      // a casing hits, bounces two or three times, each smaller and sooner, then rolls
      const { rng } = r;
      const parts: [number, Float32Array, number][] = [];
      let t = 0;
      let g = 1;
      const f = rng.range(4200, 5600);
      for (let i = 0; i < 4; i++) {
        parts.push([t, modal(r.sr, 0.12, rng.jitter(f, 0.03), [[1, 1, 0.04], [2.32, 0.6, 0.025], [4.25, 0.35, 0.012], [6.1, 0.2, 0.008]], rng), g]);
        t += rng.range(0.07, 0.12) * g;
        g *= rng.range(0.45, 0.6);
      }
      parts.push([t, mulInPlace(svf(crackle(r.sr, 0.15, rng, 200, 0.0006), r.sr, 'bp', 5000, 2), decayEnv(r.sr, 0.15, 0.1)), 0.15]);
      return sequence(r, 0.6, parts);
    },
    variants: 4,
    gain: 0.18,
    maxVoices: 4,
    cooldown: 0.05,
    range: 12,
    priority: 10,
  },
  'shell.hull': {
    label: 'Shotgun hull on the ground',
    group: G,
    bus: 'sfx',
    render: (r) => sequence(r, 0.4, [[0, clack(r, r.rng.range(900, 1200), 0.35, 0.08), 1], [0.09, clack(r, r.rng.range(1000, 1300), 0.3, 0.06), 0.45]]),
    variants: 2,
    gain: 0.16,
    maxVoices: 2,
    cooldown: 0.1,
    range: 12,
    priority: 10,
  },
  // ---------------------------------------------------------------- beam (Arc)
  'beam.start': part('Beam: start', (r) => zap(r, 0.25, 300, 1400), { gain: 0.6, range: 40 }),
  'beam.loop': {
    ...part('Beam: firing (loop)', (r) => beamLoop(r), { gain: 0.5, range: 40, priority: 65 }),
    loop: true,
    variants: 1,
  },
  'beam.stop': part('Beam: stop', (r) => zap(r, 0.3, 1200, 120), { gain: 0.5, range: 40 }),
  'beam.recharge': part('Beam: cell recharged', (r) => sequence(r, 0.35, [[0, zap(r, 0.22, 90, 400), 0.5], [0.2, clack(r, 2200, 1, 0.06), 0.7]]), { gain: 0.35, range: 12 }),
  'beam.empty': part('Beam: cell empty', (r) => zap(r, 0.18, 400, 90), { gain: 0.4, cooldown: 0.2, range: 15 }),
  'beam.draw': part('Beam: draw', (r) => sequence(r, 0.45, [[0, draw(r, 1)], [0.15, chargeUp(r, 0.25, 200, 900, 6), 0.3]])),
  // ---------------------------------------------------------------- launchers (Thumper rockets, Popper shells)
  'rocket.fire': {
    label: 'Rocket: launch',
    group: G,
    bus: 'sfx',
    render: (r) =>
      sequence(r, 1.1, [
        [0, gunshot(r, { ...SHOTGUN, len: 0.6, crack: 0.5, body: 0.7, thump: 1, thumpF: [90, 35] }), 0.8],
        [0.02, whoosh(r, 1, 300, 2400, 0.9, 0.15, 'pink'), 1],
      ]),
    variants: 2,
    priority: 80,
    range: 80,
    maxVoices: 3,
    cooldown: 0.05,
  },
  'rocket.flight': {
    label: 'Rocket: in flight (loop)',
    group: G,
    bus: 'sfx',
    render: (r) => {
      const { sr, rng } = r;
      const hiss = wanderInPlace(svf(noise(sr, 1.4, rng), sr, 'bp', 1600, 0.8), sr, rng, 0.3, 14);
      mixInto(hiss, svf(noise(sr, 1.4, rng, 'brown'), sr, 'lp', 400), sr, 0, 0.8);
      return seamless(hiss, sr, 0.2);
    },
    loop: true,
    gain: 0.45,
    range: 45,
    maxVoices: 4,
    priority: 55,
  },
  'popper.fire': {
    label: 'Grenade launcher: fire',
    group: G,
    bus: 'sfx',
    render: (r) => {
      const { sr, rng } = r;
      const tube = mulInPlace(svf(noise(sr, 0.3, rng), sr, 'bp', sweep(500, 220, 0.15), 3), decayEnv(sr, 0.3, 0.12, 0.002));
      return sequence(r, 0.6, [
        [0, thump(r, 0.4, 120, 55, 0.18), 1],
        [0, tube, 0.8],
        [0, clack(r, 1400, 0.7, 0.08), 0.3],
      ]);
    },
    variants: 2,
    priority: 70,
    range: 55,
    maxVoices: 3,
    cooldown: 0.05,
  },
  'launcher.load': part('Launcher: load', (r) =>
    sequence(r, 0.45, [
      [0, slide(r, 0.18, 500, 1200, 1.1), 0.6],
      [0.17, clack(r, 1100, 0.6, 0.12), 1],
      [0.18, thump(r, 0.12, 140, 70, 0.07), 0.6],
    ]),
  ),
  'launcher.empty': part('Launcher: empty click', (r) => dry(r, 1700), { gain: 0.45, cooldown: 0.12, range: 15 }),
  'launcher.draw': part('Launcher: draw', (r) => draw(r, 1.6)),
  // ---------------------------------------------------------------- flamethrower (Dragon)
  'flame.start': part('Flamethrower: ignite', (r) =>
    sequence(r, 0.5, [
      [0, clack(r, 3200, 1, 0.04), 0.4],
      [0.02, whoosh(r, 0.45, 200, 900, 0.8, 0.25, 'pink'), 1],
      [0.03, thump(r, 0.3, 110, 60, 0.15), 0.7],
    ]),
  { gain: 0.7, range: 35 }),
  'flame.loop': {
    ...part('Flamethrower: firing (loop)', (r) => flameLoop(r, 1.4, 1100, 0.25), { gain: 0.6, range: 35, priority: 65 }),
    loop: true,
    variants: 1,
  },
  'flame.stop': part('Flamethrower: stop', (r) => mulInPlace(whoosh(r, 0.4, 900, 200, 0.8, 0.05, 'pink'), 0.8), { gain: 0.5, range: 35 }),
  'flame.empty': part('Flamethrower: tank empty', (r) => sequence(r, 0.3, [[0, dry(r, 1500)], [0.04, whoosh(r, 0.2, 400, 200, 1, 0.1), 0.3]]), { gain: 0.45, cooldown: 0.2, range: 15 }),
  'flame.draw': part('Flamethrower: draw', (r) => sequence(r, 0.5, [[0, draw(r, 1.5)], [0.25, mulInPlace(svf(noise(r.sr, 0.15, r.rng), r.sr, 'hp', 3000), decayEnv(r.sr, 0.15, 0.1)), 0.15]])),
  'burn.loop': {
    label: 'On fire (loop)',
    group: G,
    bus: 'sfx',
    render: (r) => flameLoop(r, 1.6, 700, 0.5),
    loop: true,
    gain: 0.35,
    range: 25,
    maxVoices: 3,
    priority: 45,
  },
  // ---------------------------------------------------------------- charge weapons (Ripper blades, Pulse orbs)
  'ripper.charge': part('Ripper: charging', (r) => chargeUp(r, 0.42, 260, 1500, 11), { gain: 0.5, range: 30 }),
  'ripper.fire': {
    label: 'Ripper: blade away',
    group: G,
    bus: 'sfx',
    render: (r) =>
      sequence(r, 0.6, [
        [0, modal(r.sr, 0.5, r.rng.jitter(1900, 0.04), [[1, 1, 0.25], [2.4, 0.5, 0.15], [4.1, 0.3, 0.08]], r.rng), 0.6],
        [0, whoosh(r, 0.35, 900, 3500, 1.4, 0.15), 1],
        [0, thump(r, 0.15, 160, 80, 0.06), 0.5],
      ]),
    variants: 2,
    priority: 70,
    range: 55,
    maxVoices: 3,
  },
  'blade.spin': {
    label: 'Blade: spinning (loop)',
    group: G,
    bus: 'sfx',
    render: (r) => {
      const { sr, rng } = r;
      const w = tremoloInPlace(svf(noise(sr, 1.1, rng), sr, 'bp', 2400, 3), sr, 28, 0.85);
      mixInto(w, mulInPlace(osc(sr, 1.1, 'tri', 520), 0.15), sr);
      return seamless(w, sr, 0.1);
    },
    loop: true,
    gain: 0.35,
    range: 30,
    maxVoices: 4,
    priority: 45,
  },
  'blade.ricochet': {
    label: 'Blade: bounce',
    group: G,
    bus: 'sfx',
    render: (r) => sequence(r, 0.5, [[0, clack(r, 2300, 1, 0.4), 1], [0.01, slide(r, 0.12, 4000, 2000, 2), 0.4]]),
    variants: 3,
    gain: 0.6,
    range: 40,
    maxVoices: 3,
    priority: 50,
  },
  'pulse.charge': part('Pulse: charging', (r) => chargeUp(r, 0.72, 90, 420, 5), { gain: 0.55, range: 30 }),
  'pulse.fire': {
    label: 'Pulse: orb away',
    group: G,
    bus: 'sfx',
    render: (r) => sequence(r, 0.6, [[0, thump(r, 0.4, 220, 60, 0.2), 1], [0, zap(r, 0.4, 2400, 300), 0.7]]),
    variants: 2,
    priority: 70,
    range: 55,
    maxVoices: 3,
  },
  'orb.hum': {
    label: 'Orb: in flight (loop)',
    group: G,
    bus: 'sfx',
    render: (r) => {
      const { sr, rng } = r;
      const hum = osc(sr, 1.2, 'saw', (t) => 110 + 6 * Math.sin(t * 2 * Math.PI * 5));
      const s = svf(hum, sr, 'lp', 900, 3);
      mixInto(s, svf(crackle(sr, 1.2, rng, 40), sr, 'bp', 3000, 1), sr, 0, 0.4);
      return seamless(tremoloInPlace(s, sr, 10, 0.4), sr, 0.1);
    },
    loop: true,
    gain: 0.4,
    range: 30,
    maxVoices: 3,
    priority: 45,
  },
  'charge.load': part('Charge weapon: load', (r) => sequence(r, 0.55, [[0, magOut(r, 1)], [0.2, magIn(r, 1)], [0.3, zap(r, 0.2, 60, 240), 0.3]])),
  'charge.empty': part('Charge weapon: empty', (r) => sequence(r, 0.3, [[0, dry(r, 2000)], [0.02, zap(r, 0.12, 200, 80), 0.2]]), { gain: 0.45, cooldown: 0.12, range: 15 }),
  'charge.draw': part('Charge weapon: draw', (r) => sequence(r, 0.5, [[0, draw(r, 1.2)], [0.2, chargeUp(r, 0.2, 300, 700, 8), 0.2]])),
  // ---------------------------------------------------------------- melee (Machete, and every swing)
  'melee.swing': {
    label: 'Machete: swing',
    group: G,
    bus: 'sfx',
    render: (r) => whoosh(r, 0.22, 500, 2600, 1.6, 0.55),
    variants: 3,
    gain: 0.7,
    range: 25,
    maxVoices: 4,
    priority: 60,
  },
  'melee.hit': {
    label: 'Machete: hit',
    group: G,
    bus: 'sfx',
    render: (r) => {
      const { sr, rng } = r;
      const wet = mulInPlace(svf(noise(sr, 0.18, rng), sr, 'lp', sweep(2500, 500, 0.1), 1.2), decayEnv(sr, 0.18, 0.08, 0.001));
      return sequence(r, 0.3, [
        [0, thump(r, 0.2, 140, 60, 0.09), 1],
        [0, wet, 0.9],
        [0, clack(r, 1600, 0.5, 0.06), 0.3],
      ]);
    },
    variants: 3,
    gain: 0.85,
    range: 30,
    maxVoices: 4,
    priority: 70,
  },
  'melee.draw': part('Machete: draw', (r) =>
    sequence(r, 0.5, [
      [0, slide(r, 0.28, 3000, 6500, 3), 0.7],
      [0.26, modal(r.sr, 0.25, r.rng.jitter(2600, 0.03), [[1, 1, 0.15], [2.7, 0.5, 0.08], [5.3, 0.3, 0.05]], r.rng), 0.35],
    ]),
  ),
} satisfies Record<string, SoundDef>;

/** A motor (the minigun's barrels): a buzzing tone plus a rattle, from f0 to f1. */
function spin(r: RenderCtx, len: number, f0: number, f1: number, shape: 'up' | 'loop' | 'down'): Float32Array {
  const { sr, rng } = r;
  const f = sweep(f0, f1, len);
  const tone = svf(osc(sr, len + 0.15, 'saw', f), sr, 'lp', 1200, 1.5);
  const rattle = tremoloInPlace(svf(noise(sr, len + 0.15, rng), sr, 'bp', 3000, 1.2), sr, (t) => f(t) / 3, 0.9);
  mixInto(tone, rattle, sr, 0, 0.35);
  if (shape === 'loop') return seamless(tone, sr, 0.15);
  const env = shape === 'up' ? linEnv(sr, len, [[0, 0.2], [len, 1]]) : linEnv(sr, len, [[0, 1], [len, 0]]);
  return fadeInPlace(mulInPlace(tone.slice(0, env.length), env), sr, 0.005, 0.02);
}

/** An electric zap: a buzzing saw sweeping f0 → f1 with crackle. */
function zap(r: RenderCtx, len: number, f0: number, f1: number): Float32Array {
  const { sr, rng } = r;
  const z = svf(osc(sr, len, 'saw', sweep(f0, f1, len)), sr, 'bp', sweep(f0 * 2, f1 * 2, len), 2);
  mixInto(z, svf(crackle(sr, len, rng, 300, 0.001), sr, 'hp', 2000), sr, 0, 0.5);
  return fadeInPlace(mulInPlace(z, decayEnv(sr, len, len * 0.9, 0.003)), sr, 0.001, 0.02);
}

/** The Arc's beam: a hard buzz at 110 Hz with a wandering band-pass and crackle. */
function beamLoop(r: RenderCtx): Float32Array {
  const { sr, rng } = r;
  const len = 1.2;
  const b = osc(sr, len + 0.1, 'saw', (t) => 110 * (1 + 0.03 * Math.sin(t * 2 * Math.PI * 7)));
  mixInto(b, osc(sr, len + 0.1, 'square', 220.5), sr, 0, 0.3);
  const f = svf(b, sr, 'bp', (t) => 900 + 500 * Math.sin(t * 2 * Math.PI * 3), 1.5);
  mixInto(f, svf(crackle(sr, len + 0.1, rng, 200, 0.0015), sr, 'hp', 2500), sr, 0, 0.6);
  return seamless(f, sr, 0.1);
}
