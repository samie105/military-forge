import { Object3D, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { orientSocket, rotateWorld, solveTwoBone } from '../ik';

/** shoulder → elbow 0.162 m → wrist 0.108 m (the Rookie's arm), under a yawed, pitched parent */
function arm() {
  const root = new Object3D();
  root.position.set(3, 1, 0);
  root.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 1.05).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3));
  const upper = new Object3D();
  upper.position.set(0.2, 0.8, 0);
  const lower = new Object3D();
  lower.position.set(0, -0.162, 0);
  const hand = new Object3D();
  hand.position.set(0, -0.108, 0);
  const socket = new Object3D();
  socket.position.set(0, 0.05, 0);
  socket.quaternion.setFromAxisAngle(new Vector3(0.3, 0.2, 0.9).normalize(), 1.1);
  root.add(upper);
  upper.add(lower);
  lower.add(hand);
  hand.add(socket);
  root.updateMatrixWorld(true);
  return { root, upper, lower, hand, socket };
}

const world = (o: Object3D) => o.getWorldPosition(new Vector3());

describe('two-bone IK', () => {
  it('puts the hand on a reachable target with the elbow bent toward the pole', () => {
    const { upper, lower, hand } = arm();
    const shoulder = world(upper);
    const target = shoulder.clone().add(new Vector3(0.18, 0.1, 0.05));
    const pole = shoulder.clone().add(new Vector3(0, -1, 0));
    const err = solveTwoBone(upper, lower, hand, target, pole);
    expect(err).toBeLessThan(1e-6);
    expect(world(hand).distanceTo(target)).toBeLessThan(1e-6);
    // bone lengths are preserved
    expect(world(upper).distanceTo(world(lower))).toBeCloseTo(0.162, 6);
    expect(world(lower).distanceTo(world(hand))).toBeCloseTo(0.108, 6);
    // the elbow sits on the pole's side of the shoulder → target line
    const line = target.clone().sub(shoulder).normalize();
    const elbow = world(lower).sub(shoulder);
    const off = elbow.sub(line.multiplyScalar(elbow.dot(line)));
    expect(off.y).toBeLessThan(0);
  });

  it('points a straight arm at a target out of reach', () => {
    const { upper, lower, hand } = arm();
    const shoulder = world(upper);
    const dir = new Vector3(1, 0.5, 0).normalize();
    const target = shoulder.clone().addScaledVector(dir, 1);
    const err = solveTwoBone(upper, lower, hand, target, shoulder.clone().add(new Vector3(0, -1, 0)));
    expect(err).toBeCloseTo(1 - 0.27, 3);
    const reach = world(hand).sub(shoulder);
    expect(reach.length()).toBeCloseTo(0.27, 3);
    expect(reach.normalize().dot(dir)).toBeGreaterThan(0.9999);
  });
});

describe('socket orientation and world rotation', () => {
  it('turns the hand so the weapon socket points +Y along the aim with +Z up', () => {
    const { hand, socket } = arm();
    const forward = new Vector3(Math.cos(2.5), Math.sin(2.5), 0);
    const up = new Vector3(Math.sin(2.5), -Math.cos(2.5), 0); // facing left: the gun stays upright
    orientSocket(hand, socket, forward, up);
    const q = socket.getWorldQuaternion(new Quaternion());
    expect(new Vector3(0, 1, 0).applyQuaternion(q).dot(forward)).toBeCloseTo(1, 9);
    expect(new Vector3(0, 0, 1).applyQuaternion(q).dot(up)).toBeCloseTo(1, 9);
  });

  it('rotates a bone about a world axis, whatever its parents are doing', () => {
    const { upper, lower } = arm();
    const pivot = world(upper);
    const before = world(lower).sub(pivot);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7);
    rotateWorld(upper, q);
    const after = world(lower).sub(pivot);
    expect(after.distanceTo(before.clone().applyQuaternion(q))).toBeLessThan(1e-9);
  });
});
