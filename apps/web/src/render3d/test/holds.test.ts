import { BREACHER, BUZZ, HAMMER, K47, MACHETE, WIDOW, movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { AnimationClip, AnimationMixer, Bone, Group, NumberKeyframeTrack, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp } from '../character';
import { AIM_ANGLES, AimClips, HOLDS, aimBlend, holdFamily } from '../holds';
import { aimRig as rig, playerView } from './helpers';

describe('holdFamily', () => {
  it('takes the Forge family when there is one, else the weapon class', () => {
    expect(holdFamily(K47, 'rifle')).toBe('rifle');
    expect(holdFamily(BREACHER, 'shotgun')).toBe('shotgun');
    expect(holdFamily(WIDOW)).toBe('sniper'); // no sockets yet: by class
    expect(holdFamily({ class: 'heavy', hands: 2 }, 'heavy')).toBe('heavy');
    expect(holdFamily({ class: 'special', hands: 2 }, 'launcher')).toBe('launcher');
    expect(holdFamily(MACHETE, 'melee')).toBe('melee');
  });

  it('a one-handed weapon keeps the one-handed hold (the Buzz is a one-handed SMG)', () => {
    expect(holdFamily(BUZZ, 'pistol')).toBe('pistol');
    expect(holdFamily(BUZZ)).toBe('pistol');
    expect(holdFamily(HAMMER)).toBe('pistol');
  });

  it('two-handed holds have a support-hand target and a W8 rifle aim pose; one-handed ones none', () => {
    for (const f of ['rifle', 'shotgun', 'sniper', 'heavy', 'launcher'] as const) {
      expect(HOLDS[f].offhand).not.toBeNull();
      expect(HOLDS[f].aimPose).toBe('rifle');
    }
    expect(HOLDS.pistol.offhand).toBeNull();
    expect(HOLDS.melee.offhand).toBeNull();
  });
});

describe('W8 aim poses', () => {
  it('blends the two poses around the aim angle', () => {
    expect(aimBlend(-Math.PI / 2)).toEqual({ lo: 0, hi: 1, t: 0 });
    expect(aimBlend(0)).toEqual({ lo: 2, hi: 3, t: 0 });
    const b = aimBlend(Math.PI / 8);
    expect([b.lo, b.hi]).toEqual([2, 3]);
    expect(b.t).toBeCloseTo(0.5);
    expect(aimBlend(Math.PI / 2)).toEqual({ lo: 3, hi: 4, t: 1 });
  });

  const clip = (name: string) => new AnimationClip(name, 1, [new NumberKeyframeTrack('spine2.position[y]', [0, 1], [0.1, 0.1])]);

  it('weights the held weapon’s set, and falls back from dual to pistol to rifle', () => {
    const root = new Group();
    const bone = new Bone();
    bone.name = 'spine2';
    root.add(bone);
    const mixer = new AnimationMixer(root);
    const clips = AIM_ANGLES.map((a) => clip(`aim_rifle_${a}`));
    const aim = new AimClips(mixer, clips);
    expect(aim.available).toBe(true);
    const weight = (name: string) => mixer.existingAction(clips.find((c) => c.name === name)!)!.getEffectiveWeight();
    aim.update('rifle', Math.PI / 8);
    expect(weight('aim_rifle_level')).toBeCloseTo(0.5);
    expect(weight('aim_rifle_up45')).toBeCloseTo(0.5);
    expect(weight('aim_rifle_down45')).toBe(0);
    expect(aim.update('dual', 0)).toBe('rifle'); // no dual or pistol set on this rig
    expect(aim.update(null, 0)).toBeNull();
    expect(weight('aim_rifle_level')).toBe(0);
  });

  it('is unavailable on a rig without the full set (the Phase 0 Rookie)', () => {
    const aim = new AimClips(new AnimationMixer(new Group()), [clip('idle'), clip('aim_rifle_level')]);
    expect(aim.available).toBe(false);
    expect(aim.update('rifle', 0)).toBeNull();
  });
});

const world = new CollisionWorld(movementTestMap);
const kit = new AvatarKit(toonRamp());

function holding(def: number, aim = 0.2) {
  const inst = rig();
  const a = new Avatar(inst, 0, kit, 1);
  const view = playerView({ x: 20, aim, weapons: [{ def, mag: 10, reserve: 10, reloadTicks: 0 }, { def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }] });
  for (let i = 0; i < 12; i++) a.update(view, 1 / 60, world, true);
  const at = (n: string) => inst.bone(n)!.getWorldPosition(new Vector3());
  const shoulder = at('upperarm_R');
  const hand = at('socket_weapon_R');
  const dir = new Vector3(0, 1, 0).applyQuaternion(inst.bone('socket_weapon_R')!.getWorldQuaternion(new Quaternion()));
  return { inst, a, shoulder, hand, dir, aimDir: new Vector3(Math.cos(aim), Math.sin(aim), 0), at };
}

describe('Avatar holds', () => {
  it('a pistol at arm’s length; a rifle closer in, at the shoulder', () => {
    const pistol = holding(HAMMER.index);
    const rifle = holding(K47.index);
    const reach = (h: typeof pistol) => h.hand.clone().sub(h.shoulder).dot(h.aimDir);
    expect(reach(rifle)).toBeLessThan(reach(pistol) - 0.05);
    for (const h of [pistol, rifle]) expect(h.dir.dot(h.aimDir)).toBeCloseTo(1, 5); // the gun still points along the aim
  });

  it('two hands on a rifle: the support hand comes to the weapon', () => {
    const rifle = holding(K47.index);
    const pistol = holding(HAMMER.index);
    const gap = (h: typeof rifle) => h.at('hand_L').distanceTo(h.at('hand_R'));
    expect(gap(rifle)).toBeLessThan(gap(pistol));
  });

  it('a sniper holds higher and tighter than a rifle; a machete’s blade is raised above the aim', () => {
    const sniper = holding(WIDOW.index);
    const rifle = holding(K47.index);
    expect(sniper.hand.y - sniper.shoulder.y).toBeGreaterThan(rifle.hand.y - rifle.shoulder.y);
    const machete = holding(MACHETE.index);
    expect(machete.dir.dot(machete.aimDir)).toBeCloseTo(Math.cos(HOLDS.melee.pitch), 4);
    expect(machete.dir.y).toBeGreaterThan(machete.aimDir.y); // pitched up
  });
});
