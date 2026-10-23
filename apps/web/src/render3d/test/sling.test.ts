import { BUZZ, HAMMER, K47, MACHETE, WIDOW, movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { Bone, Vector3, type Mesh, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerView } from '../../view';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp } from '../character';
import { DRAW_START, STOW_END, slingPointFor, switchPhase, switchSeconds, type SwitchPose } from '../sling';
import { aimRig, playerView } from './helpers';

const world = new CollisionWorld(movementTestMap);

/** The test rig with a right thigh under the pelvis and, unless `sockets` is false, #95's sling sockets. */
function rig(sockets = true) {
  const inst = aimRig();
  const added = new Map<string, Bone>();
  const add = (name: string, parent: Object3D, x: number, y: number, z: number) => {
    const b = new Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    added.set(name, b);
    return b;
  };
  const thigh = add('thigh_R', inst.bone('pelvis')!, -0.1, -0.05, 0);
  if (sockets) {
    add('sling_back', inst.bone('spine2')!, 0, 0.08, -0.42);
    add('holster_thigh', thigh, -0.21, -0.1, -0.02);
  }
  return { ...inst, bone: (n: string) => added.get(n) ?? inst.bone(n) };
}

/** the slung guns on show, by the point they hang from */
function slung(inst: ReturnType<typeof rig>): Record<string, number> {
  const out: Record<string, number> = {};
  inst.root.traverse((o: Object3D) => {
    if (o.name === 'slung-gun' && o.visible) out[o.parent!.name] = (out[o.parent!.name] ?? 0) + 1;
  });
  return out;
}

const loadout = (active: 0 | 1, over: Partial<PlayerView> = {}) =>
  playerView({ x: 20, aim: 0, active, weapons: [{ def: K47.index, mag: 30, reserve: 90, reloadTicks: 0 }, { def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }], ...over });

describe('where each gun hangs', () => {
  it('long guns on the back, pistols and SMGs on the thigh, melee at the hip; with the shield slung, a long gun at the side', () => {
    expect(slingPointFor(K47, 'rifle', false)).toBe('back');
    expect(slingPointFor(WIDOW, 'sniper', false)).toBe('back');
    expect(slingPointFor(BUZZ, 'pistol', false)).toBe('thigh'); // the Buzz is in the pistol family
    expect(slingPointFor(HAMMER, null, false)).toBe('thigh'); // by class without sockets.json
    expect(slingPointFor(MACHETE, null, true)).toBe('hip');
    expect(slingPointFor(K47, 'rifle', true)).toBe('side');
    expect(slingPointFor(HAMMER, 'pistol', true)).toBe('thigh');
  });

  it('a switch: stow the old gun, cross empty-handed, draw the new one, in the sim’s equip time', () => {
    const at = (k: number) => ({ ...switchPhase(k, {} as SwitchPose) });
    expect(at(0)).toMatchObject({ holdingOld: true, holdingNew: false, away: 0 });
    expect(at(STOW_END - 0.01)).toMatchObject({ holdingOld: true, away: expect.closeTo(1, 1) });
    expect(at((STOW_END + DRAW_START) / 2)).toMatchObject({ holdingOld: false, holdingNew: false, away: 1, across: expect.closeTo(0.5, 2) });
    // the hand leaves and comes back to the aim gently (no jolt), fastest at the dip
    expect(at(0.02).away).toBeLessThan(0.01);
    expect(at(1 - 0.02).away).toBeLessThan(0.01);
    expect(at(DRAW_START + 0.01).holdingNew).toBe(true);
    expect(at(0.999).away).toBeLessThan(0.01);
    expect(switchSeconds(K47.index)).toBe(K47.equip);
  });
});

describe('Avatar: guns on the body and the switch', () => {
  it('the gun not in hand hangs on the body; a switch carries them between hand and body, then swaps them', () => {
    const inst = rig();
    const a = new Avatar(inst as never, 0, new AvatarKit(toonRamp()), 1);
    const step = (view: PlayerView, seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += 1 / 60) a.update(view, 1 / 60, world, true);
    };
    step(loadout(0), 0.1);
    expect(slung(inst)).toEqual({ holster_thigh: 1 }); // the Hammer, holstered
    const handGun = () => inst.bone('socket_weapon_R')!.children.find((c) => (c as Mesh).isMesh && c.name !== 'gun-part') as Mesh;
    const dur = switchSeconds(HAMMER.index);
    // the switch to the Hammer: the K-47 goes down to the hip first, still in hand
    step(loadout(1), dur * 0.2);
    expect(handGun().visible).toBe(true);
    expect(slung(inst)).toEqual({ holster_thigh: 1 });
    // at the dip the guns change over: the K-47 onto the back, the Hammer out of the holster
    step(loadout(1), dur * 0.35);
    expect(slung(inst)).toEqual({ sling_back: 1 });
    // the Hammer comes up; the K-47 stays on the back
    step(loadout(1), dur * 0.6);
    expect(handGun().visible).toBe(true);
    expect(slung(inst)).toEqual({ sling_back: 1 });
  });

  it('dual guns: both in hand, nothing hangs; a pickup into a slot is no switch; the shield moves a long gun to the side', () => {
    const inst = rig();
    const a = new Avatar(inst as never, 0, new AvatarKit(toonRamp()), 1);
    a.update(loadout(0, { dual: true, weapons: [{ def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }, { def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }] }), 1 / 60, world, true);
    expect(slung(inst)).toEqual({});
    const b = rig();
    const av = new Avatar(b as never, 0, new AvatarKit(toonRamp()), 1);
    av.update(loadout(1), 1 / 60, world, true);
    av.update(loadout(1, { shield: 'back' }), 1 / 60, world, true);
    expect(slung(b)).toEqual({ 'side-sling': 1 }); // the K-47 at the side: the shield has the back
    // a new weapon in the other slot (a pickup) shows at once, without a switch
    av.update(loadout(1, { weapons: [{ def: WIDOW.index, mag: 5, reserve: 20, reloadTicks: 0 }, { def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }] }), 1 / 60, world, true);
    expect(slung(b)).toEqual({ sling_back: 1 });
    const hand = b.bone('hand_R')!.getWorldPosition(new Vector3());
    av.update(loadout(1, { weapons: [{ def: WIDOW.index, mag: 5, reserve: 20, reloadTicks: 0 }, { def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }] }), 1 / 60, world, true);
    expect(b.bone('hand_R')!.getWorldPosition(new Vector3()).distanceTo(hand)).toBeLessThan(0.01); // no carry
  });
});

describe('Low', () => {
  it('a remote soldier at LOD1 (Low) carries no slung gun: one draw call less each', () => {
    const inst = rig();
    const a = new Avatar(inst as never, 1, new AvatarKit(toonRamp()), 1);
    a.update(loadout(0), 1 / 60, world, true);
    expect(slung(inst)).toEqual({});
  });
});

describe('a rig without the sling sockets (#95)', () => {
  it('hangs nothing on the back or the thigh; the hip and side points are its own', () => {
    const holster = rig(false);
    new Avatar(holster as never, 0, new AvatarKit(toonRamp()), 1).update(loadout(0), 1 / 60, world, true);
    expect(slung(holster)).toEqual({}); // the Hammer: no holster to hang in
    const inst = rig(false);
    const a = new Avatar(inst as never, 0, new AvatarKit(toonRamp()), 1);
    a.update(loadout(1), 1 / 60, world, true);
    expect(slung(inst)).toEqual({}); // the K-47: nothing on the back
    a.update(loadout(1, { shield: 'back' }), 1 / 60, world, true);
    expect(slung(inst)).toEqual({ 'side-sling': 1 }); // the K-47 at the side
    a.update(loadout(1, { weapons: [{ def: MACHETE.index, mag: 0, reserve: 0, reloadTicks: 0 }, { def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }] }), 1 / 60, world, true);
    expect(slung(inst)).toEqual({ 'hip-sling': 1 });
  });
});
