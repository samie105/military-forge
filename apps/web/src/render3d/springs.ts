/**
 * Spring chains: secondary motion (docs/design/character-feel-research.md §3.6, §5.1 F), after the VRM SpringBone 1.0
 * algorithm: each joint's tail is a point integrated by Verlet (inertia with drag), pulled back toward the joint's
 * rest direction (stiffness) and down (gravity), held at the bone's length, and the joint turned to point at it.
 *
 * The skeleton has no strap, pouch, tank or hair bones yet (an ask for the Forge: animation-feel.md), so today the
 * chains swing what already hangs free: the guns slung on the body. Bones the Forge adds later (`strap_*`, `pouch_*`,
 * `hair_*`, `tank_*`, optional in shared-v1's name list) take the same `SpringChain` with their own joints.
 * Every joint stays within `maxAngle` of its rest direction, so a chain's tip never leaves the docs/04 §1 envelope.
 */
import { Quaternion, Vector3, type Object3D } from 'three';

export interface SpringSettings {
  /** pull back toward the rest direction (1/s², per metre of tail offset) */
  stiffness: number;
  /** share of the tail's velocity lost per second-ish (0 none … 1 all; VRM's dragForce) */
  drag: number;
  /** gravity on the tail (m/s²) */
  gravity: number;
  /** the most a joint turns from its rest direction (rad) */
  maxAngle: number;
}

export const SLUNG_GUN: SpringSettings = { stiffness: 140, drag: 0.35, gravity: 4, maxAngle: (22 * Math.PI) / 180 };

const _rest = new Vector3();
const _head = new Vector3();
const _next = new Vector3();
const _q = new Quaternion();
const _pq = new Quaternion();
const _down = new Vector3(0, -1, 0);

interface Joint {
  node: Object3D;
  /** the tail in the joint's own space at rest (direction × length) */
  tail: Vector3;
  length: number;
  /** its rest rotation (local) */
  rest: Quaternion;
  /** the simulated tail as an offset from its joint, now and one step ago; the joint last step, and how far it moved */
  current: Vector3;
  previous: Vector3;
  head: Vector3;
  moved: Vector3;
}

/** A chain of joints (parent first) whose tails swing. `update(dt)` after their parents have their pose. */
export class SpringChain {
  private readonly joints: Joint[];
  private fresh = true;

  constructor(
    nodes: readonly Object3D[],
    /** each joint's tail in its own space (the next joint's position, or for the last one a length along an axis) */
    tails: readonly Vector3[],
    readonly settings: SpringSettings,
    /** each joint's rest rotation (local; default: as it is now) */
    rests?: readonly Quaternion[],
  ) {
    this.joints = nodes.map((node, i) => ({
      node,
      tail: tails[i]!.clone(),
      length: tails[i]!.length(),
      rest: (rests?.[i] ?? node.quaternion).clone(),
      current: new Vector3(),
      previous: new Vector3(),
      head: new Vector3(),
      moved: new Vector3(),
    }));
  }

  /** Back to rest (a respawn, a teleport, a new mount). */
  reset(): void {
    this.fresh = true;
  }

  /** The joints' current turn away from rest, the largest (rad). */
  get swing(): number {
    let most = 0;
    for (const j of this.joints) most = Math.max(most, 2 * Math.acos(Math.min(1, Math.abs(j.node.quaternion.dot(j.rest)))));
    return most;
  }

  update(dt: number): void {
    const s = this.settings;
    const h = Math.min(dt, 1 / 30);
    for (const j of this.joints) {
      const node = j.node;
      node.quaternion.copy(j.rest);
      node.updateMatrixWorld(true);
      node.getWorldPosition(_head);
      // where the tail sits at rest, now (the body has moved it)
      _rest.copy(j.tail).applyMatrix4(node.matrixWorld);
      if (this.fresh || dt > 0.25) {
        j.current.copy(_rest).sub(_head);
        j.previous.copy(j.current);
        j.head.copy(_head);
        j.moved.set(0, 0, 0);
        continue;
      }
      // Verlet on the tail's offset from its joint: its own velocity (less drag), the joint's acceleration felt the
      // other way (a body speeding up leaves the tail behind; moving steadily carries it along), stiffness toward rest,
      // gravity
      const moved = _head.clone().sub(j.head);
      j.head.copy(_head);
      _rest.sub(_head);
      _next
        .copy(j.current)
        .addScaledVector(j.previous, -1)
        .multiplyScalar(1 - s.drag)
        .add(j.current)
        .sub(moved.clone().sub(j.moved))
        .addScaledVector(_rest.clone().sub(j.current), Math.min(1, s.stiffness * h * h))
        .addScaledVector(_down, s.gravity * h * h);
      j.moved.copy(moved);
      j.previous.copy(j.current);
      _rest.add(_head);
      _next.add(_head);
      // the bone's length, and within maxAngle of the rest direction
      _next.sub(_head).normalize();
      const restDir = _rest.clone().sub(_head).normalize();
      const angle = _next.angleTo(restDir);
      if (angle > s.maxAngle) {
        const axis = restDir.clone().cross(_next).normalize();
        _next.copy(restDir).applyAxisAngle(axis, s.maxAngle);
      }
      _next.multiplyScalar(j.length).add(_head);
      j.current.copy(_next).sub(_head);
      // turn the joint from its rest direction to the tail (in its parent's space)
      _q.setFromUnitVectors(restDir, _next.clone().sub(_head).normalize());
      node.parent!.getWorldQuaternion(_pq);
      node.quaternion.premultiply(_pq).premultiply(_q).premultiply(_pq.invert());
      node.updateMatrixWorld(true);
    }
    this.fresh = false;
  }
}
