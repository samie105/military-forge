/**
 * Locomotion on W8's real skeleton and clips (rookie_anims.glb, repaired as the assembler serves them): the speed
 * blend, the cadence, and the clip-repair regression. Planted feet (sliding, snaps, steps and slopes): feet.test.ts.
 */
import { NO_WEAPON, movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { AnimationMixer, Quaternion, QuaternionKeyframeTrack } from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp, type CharacterInstance } from '../character';
import { LocoLayer } from '../locomotion';
import type { PlayerView } from '../../view';
import { playerView } from './helpers';
import { rookieRig } from './rookieRig';

const world = new CollisionWorld(movementTestMap);
/** whole-skeleton runs: generous under a loaded CI machine */
const SLOW = 60_000;

async function runAt(speed: number, seconds = 3.5, dt = 1 / 60) {
  const inst = await rookieRig();
  const a = new Avatar(inst, 0, new AvatarKit(toonRamp()), 1);
  let x = 20;
  for (let i = 0; i < seconds / dt; i++) a.update(playerView({ x: (x += speed * dt), vx: speed, aim: 0.1 }), dt, world, false);
  return { a };
}

describe('locomotion on W8 clips', () => {
  it('blend weights versus speed: idle at rest, walk at a stroll, run at speed, air clips off on the ground', async () => {
    const inst = await rookieRig();
    const loco = new LocoLayer(new AnimationMixer(inst.root), inst, 1);
    loco.facing = 1;
    const settle = (vx: number) => {
      for (let i = 0; i < 90; i++) loco.update({ grounded: true, crouched: false, jetting: false, vx, vy: 0 }, 1 / 60);
      return loco.weights();
    };
    const rest = settle(0);
    expect(rest.idle).toBeCloseTo(1, 3);
    expect(rest.walk! + rest.run!).toBeLessThan(0.01);
    const careful = settle(0.4);
    expect(careful.slow).toBeGreaterThan(0.5); // the Forge's careful steps (walk_slow) at the slowest speeds
    const stroll = settle(1);
    expect(stroll.idle).toBeCloseTo(1, 3); // the base pose stays; the cycle is additive on top
    expect(stroll.walk).toBeGreaterThan(0.9);
    expect(stroll.slow).toBe(0);
    expect(stroll.run).toBe(0);
    const sprint = settle(5);
    expect(sprint.walk).toBe(0);
    expect(sprint.run).toBeGreaterThan(0.99); // the Forge's run is authored for this speed: no stride stretch
    for (const w of [rest, stroll, sprint]) expect(w.ascend! + w.hover! + w.fall!).toBeLessThan(1e-3);
    const crouched = (() => {
      for (let i = 0; i < 90; i++) loco.update({ grounded: true, crouched: true, jetting: false, vx: 2.2, vy: 0 }, 1 / 60);
      return loco.weights();
    })();
    expect(crouched.crouch).toBeGreaterThan(0.99);
    expect(crouched.crouchStep).toBeGreaterThan(0.5); // the Forge's crouch_walk steps over crouch_idle
    expect(crouched.walk! + crouched.run!).toBeLessThan(0.01);
    const air = (() => {
      for (let i = 0; i < 60; i++) loco.update({ grounded: false, crouched: false, jetting: true, vx: 0, vy: 4 }, 1 / 60);
      return loco.weights();
    })();
    expect(air.ascend).toBeGreaterThan(0.9);
    expect(air.idle).toBeLessThan(0.01);
  }, SLOW);

  it('the stepping cadence never stalls while moving (no timeScale near 0): the phase keeps advancing', async () => {
    for (const speed of [0.05, 0.3, 5]) {
      const { a } = await runAt(speed, 2);
      const before = a.loco.phase;
      a.update(playerView({ vx: speed, aim: 0.1 }), 1 / 60, world, false);
      const advance = (((a.loco.phase - before) % 1) + 1) % 1;
      expect(advance, `${speed} m/s`).toBeGreaterThanOrEqual((1.25 / 60) * 0.99);
    }
  }, SLOW);

  it('runs the cycle backwards when backpedalling (moving right, aiming left)', async () => {
    const inst = await rookieRig();
    const a = new Avatar(inst, 0, new AvatarKit(toonRamp()), 1);
    a.update(playerView({ vx: 2, aim: Math.PI - 0.1 }), 1 / 60, world, false);
    const before = a.loco.phase;
    a.update(playerView({ vx: 2, aim: Math.PI - 0.1 }), 1 / 60, world, false);
    expect((((before - a.loco.phase) % 1) + 1) % 1).toBeLessThan(0.5); // went down
  });
});

describe('W8 aim poses and locomotion share the mixer', () => {
  /** how far (°) a bone's local turn strays from its first sample over a second of a 5 m/s run */
  async function sway(bone: string, weapons: PlayerView['weapons']): Promise<number> {
    const inst = await rookieRig();
    const a = new Avatar(inst, 0, new AvatarKit(toonRamp()), 1);
    const b = inst.bone(bone)!;
    const first = new Quaternion();
    let worst = 0;
    let x = 20;
    for (let i = 0; i < 150; i++) {
      a.update(playerView({ x: (x += 5 / 60), vx: 5, aim: 0.1, weapons }), 1 / 60, world, false);
      if (i === 90) first.copy(b.quaternion);
      if (i > 90) worst = Math.max(worst, (b.quaternion.angleTo(first) * 180) / Math.PI);
    }
    return worst;
  }

  it('armed, the aim pose owns the upper body: the run keeps the legs and leaves the spine still (setUpperBody)', async () => {
    const unarmed = [{ def: NO_WEAPON, mag: 0, reserve: 0, reloadTicks: 0 }];
    const armed = playerView().weapons;
    // unarmed, the run swings the arms and sways the spine; armed, the aim pose holds them (a still spine: the
    // lean and the hold are constant at a steady run)
    expect(await sway('upperarm_L', unarmed)).toBeGreaterThan(20);
    expect(await sway('upperarm_L', armed)).toBeLessThan(1);
    expect(await sway('spine2', unarmed)).toBeGreaterThan(1);
    expect(await sway('spine2', armed)).toBeLessThan(0.5);
    // the legs run either way
    expect(await sway('thigh_L', armed)).toBeGreaterThan(20);
  }, SLOW);
});

describe('clip repair (W8 export writes identity quaternions as tangents)', () => {
  it('the idle no longer bows: the pelvis stays still between keys that hold it still', async () => {
    const inst: CharacterInstance = await rookieRig();
    const idle = inst.clips.find((c) => c.name === 'idle')!;
    const mixer = new AnimationMixer(inst.root);
    const action = mixer.clipAction(idle).play();
    const pelvis = inst.bone('pelvis')!;
    let worst = 0;
    for (let t = 0; t < idle.duration; t += 0.05) {
      action.time = t;
      mixer.update(0);
      worst = Math.max(worst, pelvis.quaternion.angleTo(new Quaternion()));
    }
    expect(worst).toBeLessThan(0.01); // it swung ±0.19 rad (11°) before the repair
  });

  it('no bone spins the long way round a quaternion sign flip between keys (review M4)', async () => {
    const inst: CharacterInstance = await rookieRig();
    const a = new Quaternion();
    const b = new Quaternion();
    let fastest = 0;
    for (const clip of inst.clips)
      for (const track of clip.tracks) {
        if (!(track instanceof QuaternionKeyframeTrack)) continue;
        for (let i = 1; i < track.times.length; i++) {
          const turn = a.fromArray(track.values, (i - 1) * 4).angleTo(b.fromArray(track.values, i * 4));
          fastest = Math.max(fastest, (turn * 180) / Math.PI / (track.times[i]! - track.times[i - 1]!));
        }
      }
    // 14 key pairs in melee, reload and throw spun at up to 4,700°/s; the fastest real turn (the throw's hand) is ~1,750
    expect(fastest).toBeLessThan(2500);
  });
});
