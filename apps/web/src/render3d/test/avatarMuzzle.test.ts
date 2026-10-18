import { BUZZ, HAMMER, movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp } from '../character';
import { aimRig as rig, playerView } from './helpers';

const world = new CollisionWorld(movementTestMap);
const kit = new AvatarKit(toonRamp());

describe('Avatar muzzles (gunfire VFX)', () => {
  it('the right gun’s muzzle, ahead of the hand along the aim', () => {
    const inst = rig();
    const a = new Avatar(inst, 0, kit, 1);
    const aim = 0.3;
    for (let i = 0; i < 10; i++) a.update(playerView({ x: 20, aim, weapons: [{ def: HAMMER.index, mag: 6, reserve: 30, reloadTicks: 0 }, { def: BUZZ.index, mag: 40, reserve: 250, reloadTicks: 0 }] }), 1 / 60, world, true);
    const out = new Vector3();
    const dir = new Vector3();
    expect(a.muzzle(HAMMER.index, out, dir)).toBe(true);
    expect(dir.dot(new Vector3(Math.cos(aim), Math.sin(aim), 0))).toBeCloseTo(1, 5);
    const hand = inst.bone('socket_weapon_R')!.getWorldPosition(new Vector3());
    const ahead = out.clone().sub(hand);
    expect(ahead.dot(dir)).toBeCloseTo(kit.weapon(HAMMER.index).muzzle.y, 5); // the model's muzzle, along the barrel
    // the Buzz isn't in a hand (not dual): no muzzle for it
    expect(a.muzzle(BUZZ.index, out, dir)).toBe(false);
  });

  it('dual guns: each fires from its own hand, and the same gun in both hands takes turns', () => {
    const inst = rig();
    const a = new Avatar(inst, 0, kit, 1);
    const dual = (w0: number, w1: number) => playerView({ x: 20, aim: 0, dual: true, weapons: [{ def: w0, mag: 6, reserve: 30, reloadTicks: 0 }, { def: w1, mag: 6, reserve: 30, reloadTicks: 0 }] });
    a.update(dual(HAMMER.index, BUZZ.index), 1 / 60, world, true);
    const out = new Vector3();
    const dir = new Vector3();
    const handOf = (side: 'L' | 'R') => inst.bone(`socket_weapon_${side}`)!.getWorldPosition(new Vector3());
    a.muzzle(BUZZ.index, out, dir);
    expect(out.distanceTo(handOf('L'))).toBeLessThan(out.distanceTo(handOf('R')));
    a.muzzle(HAMMER.index, out, dir);
    expect(out.distanceTo(handOf('R'))).toBeLessThan(out.distanceTo(handOf('L')));
    a.update(dual(HAMMER.index, HAMMER.index), 1 / 60, world, true);
    const first = new Vector3();
    a.muzzle(HAMMER.index, first, dir);
    a.muzzle(HAMMER.index, out, dir);
    expect(out.distanceTo(first)).toBeGreaterThan(0.05);
    // a peek (a flash riding its gun) finds the gun that fired last and takes no turn
    const peeked = new Vector3();
    a.muzzle(HAMMER.index, peeked, dir, true);
    expect(peeked.distanceTo(out)).toBeLessThan(1e-9);
    a.muzzle(HAMMER.index, peeked, dir, true);
    expect(peeked.distanceTo(out)).toBeLessThan(1e-9);
    a.muzzle(HAMMER.index, peeked, dir);
    expect(peeked.distanceTo(first)).toBeLessThan(1e-9); // the next shot: the other hand again
  });

  it('a dead player has no muzzle', () => {
    const a = new Avatar(rig(), 0, kit, 1);
    a.update(playerView({ alive: false }), 1 / 60, world, true);
    expect(a.muzzle(HAMMER.index, new Vector3(), new Vector3())).toBe(false);
  });

  it('the eject port of the gun in the hand (casings), its throw and its bore', () => {
    const inst = rig();
    const a = new Avatar(inst, 0, kit, 1);
    a.update(playerView({ x: 20, aim: 0 }), 1 / 60, world, true);
    const out = new Vector3();
    const dir = new Vector3();
    const bore = new Vector3();
    expect(a.eject(HAMMER.index, out, dir, bore)).toBe(true);
    expect(out.distanceTo(inst.bone('socket_weapon_R')!.getWorldPosition(new Vector3()))).toBeLessThan(0.15);
    expect(dir.length()).toBeCloseTo(1, 5);
    expect(bore.x).toBeCloseTo(1, 1); // aiming right
    expect(a.eject(BUZZ.index, out, dir, bore)).toBe(false); // not in a hand
  });
});
