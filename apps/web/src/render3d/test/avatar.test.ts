import { movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { AnimationClip, Bone, Group, NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, Vector3, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp, type CharacterInstance } from '../character';
import { facingYaw } from '../locomotion';
import { playerView } from './helpers';

/** The shared-v1 bones the avatar drives, in the Rookie's bind-pose layout (art/character/rookie_rig.json). */
function syntheticRookie(): CharacterInstance {
  const bones = new Map<string, Bone>();
  const bone = (name: string, parent: Object3D, x: number, y: number, z = 0) => {
    const b = new Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    bones.set(name, b);
    return b;
  };
  const root = new Group();
  const pelvis = bone('pelvis', root, 0, 0.47);
  const spine1 = bone('spine1', pelvis, 0, 0.1);
  const spine2 = bone('spine2', spine1, 0, 0.145);
  bone('head', bone('neck', spine2, 0, 0.145), 0, 0.13);
  bone('socket_jetpack', spine2, 0, 0.01, -0.16);
  for (const [side, s] of [
    ['L', 1],
    ['R', -1],
  ] as const) {
    const upper = bone(`upperarm_${side}`, spine2, 0.22 * s, 0.085);
    const lower = bone(`forearm_${side}`, upper, 0, -0.162);
    const hand = bone(`hand_${side}`, lower, 0, -0.108);
    bone(`socket_weapon_${side}`, hand, 0, -0.052);
  }
  const idle = new AnimationClip('idle', 1, [new NumberKeyframeTrack('pelvis.position[y]', [0, 1], [0.47, 0.46])]);
  // like the real run clip: the spine and head are keyed but held still
  const still = (bone: string) => new QuaternionKeyframeTrack(`${bone}.quaternion`, [0, 0.6], [0, 0, 0, 1, 0, 0, 0, 1]);
  const run = new AnimationClip('run', 0.6, [
    new NumberKeyframeTrack('pelvis.position[y]', [0, 0.6], [0.47, 0.5]),
    still('spine1'),
    still('spine2'),
    still('head'),
  ]);
  return { root, meshes: [], clips: [idle, run], bone: (n) => bones.get(n) ?? null, dispose: () => root.removeFromParent() };
}

const world = new CollisionWorld(movementTestMap);

function avatar() {
  const inst = syntheticRookie();
  const a = new Avatar(inst, 0, new AvatarKit(toonRamp()), 1);
  return { a, inst };
}

describe('Avatar', () => {
  it('points the gun along the sim aim, facing the aim side (turned 30° toward the camera)', () => {
    const { a, inst } = avatar();
    for (const aim of [0.4, 2.6, -1.2]) {
      for (let i = 0; i < 20; i++) a.update(playerView({ x: 20, aim }), 1 / 60, world, true);
      const socket = inst.bone('socket_weapon_R')!;
      const muzzleDir = new Vector3(0, 1, 0).applyQuaternion(socket.getWorldQuaternion(new Quaternion()));
      expect(muzzleDir.dot(new Vector3(Math.cos(aim), Math.sin(aim), 0))).toBeCloseTo(1, 6);
      expect(a.pivot.rotation.y).toBeCloseTo(facingYaw(Math.cos(aim) >= 0 ? 1 : -1), 6);
      const gun = socket.children.find((c) => c.type === 'Mesh')!;
      expect(gun.visible).toBe(true);
    }
  });

  it('holds the second gun in the left hand when dual-wielding, and nothing there otherwise', () => {
    const { a, inst } = avatar();
    const leftGun = inst.bone('socket_weapon_L')!.children.find((c) => c.type === 'Mesh')!;
    a.update(playerView(), 1 / 60, world, true);
    expect(leftGun.visible).toBe(false);
    a.update(playerView({ dual: true, aim: 0.2 }), 1 / 60, world, true);
    expect(leftGun.visible).toBe(true);
    // the left hand turns onto the aim over a few frames (inertia.ts WorldEase), then stays exact
    for (let i = 0; i < 40; i++) a.update(playerView({ dual: true, aim: 0.2 }), 1 / 60, world, true);
    const dir = new Vector3(0, 1, 0).applyQuaternion(inst.bone('socket_weapon_L')!.getWorldQuaternion(new Quaternion()));
    expect(dir.dot(new Vector3(Math.cos(0.2), Math.sin(0.2), 0))).toBeCloseTo(1, 6);
  });

  it('lights the jet flame while jetting and hides it after', () => {
    const { a, inst } = avatar();
    const flame = inst.bone('socket_jetpack')!.children[0]!;
    a.update(playerView({ grounded: false, jetting: true, vy: 3, y: 3 }), 1 / 30, world, true);
    expect(flame.visible).toBe(true);
    for (let i = 0; i < 30; i++) a.update(playerView({ grounded: false, vy: -2, y: 3 }), 1 / 60, world, true);
    expect(flame.visible).toBe(false);
  });

  it('drops a blob shadow onto the ground below, fainter with height, and hides the dead', () => {
    const { a } = avatar();
    a.update(playerView({ x: 20, y: 0 }), 1 / 60, world, true);
    expect(a.blob.visible).toBe(true);
    expect(a.blob.position.y).toBeCloseTo(0.015, 6);
    const near = (a.blob.material as { opacity: number }).opacity;
    a.update(playerView({ x: 20, y: 4, grounded: false }), 1 / 60, world, true);
    expect(a.blob.position.y).toBeCloseTo(0.015, 6);
    expect((a.blob.material as { opacity: number }).opacity).toBeLessThan(near);
    // dead: the death beat (death.ts) shows the collapse and its shadow, then hides both
    a.update(playerView({ x: 20, y: 0, alive: false, deaths: 1 }), 1 / 60, world, true);
    expect(a.pivot.visible).toBe(true);
    for (let i = 0; i < 45; i++) a.update(playerView({ x: 20, y: 0, alive: false, deaths: 1 }), 1 / 60, world, true);
    expect(a.pivot.visible).toBe(false);
    expect(a.blob.visible).toBe(false);
  });

  it('blends locomotion by speed: idle at rest, the stepping cycle fading in as the player runs (locomotion.ts)', () => {
    const { a } = avatar();
    a.update(playerView(), 1 / 60, world, true);
    expect(a.loco.weights().idle).toBeCloseTo(1, 6);
    expect(a.loco.weights().run).toBe(0);
    a.update(playerView({ vx: 5 }), 1 / 60, world, true);
    const starting = a.loco.weights().run!;
    expect(starting).toBeGreaterThan(0); // fading in, not snapping
    for (let i = 0; i < 30; i++) a.update(playerView({ vx: 5 }), 1 / 60, world, true);
    expect(a.loco.weights().run).toBeGreaterThan(starting);
    expect(a.loco.state).toBe('run');
  });

  it('aims the spine and head without the turn piling up when the clip holds them still (regression: head spun while running)', () => {
    const { a, inst } = avatar();
    a.motion.breathe = 0; // (breathing moves the head on purpose)
    const head = inst.bone('head')!;
    const pose = () => head.getWorldQuaternion(new Quaternion());
    // into the run clip, and long enough for the gait springs to settle
    for (let i = 0; i < 150; i++) a.update(playerView({ vx: 5, aim: 0.8 }), 1 / 60, world, true);
    const settled = pose();
    for (let i = 0; i < 60; i++) a.update(playerView({ vx: 5, aim: 0.8 }), 1 / 60, world, true);
    expect(pose().angleTo(settled)).toBeLessThan(1e-6);
    // and it still looks up: the head is pitched by the aim, not left at the bind pose
    const level = avatar();
    for (let i = 0; i < 40; i++) level.a.update(playerView({ vx: 5, aim: 0 }), 1 / 60, world, true);
    expect(level.inst.bone('head')!.getWorldQuaternion(new Quaternion()).angleTo(settled)).toBeGreaterThan(0.1);
  });
});
