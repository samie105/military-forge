/**
 * Skeleton helpers that run after the AnimationMixer each frame (docs/11 §4): world-space bone
 * rotation for the procedural aim, analytic two-bone IK (cheaper than CCDIKSolver) and socket
 * orientation. They read and write live world matrices, so the chain's matrices must be current.
 */
import { Matrix4, Quaternion, Vector3, type Object3D } from 'three';

const _q = new Quaternion();
const _pq = new Quaternion();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _pd = new Vector3();
const _e = new Vector3();
const _h = new Vector3();
const _u = new Vector3();
const _v = new Vector3();
const _x = new Vector3();
const _m = new Matrix4();

/** Rotates `bone` by `q`, given in world space; children follow. */
export function rotateWorld(bone: Object3D, q: Quaternion): void {
  if (!bone.parent) {
    bone.quaternion.premultiply(q);
  } else {
    bone.parent.getWorldQuaternion(_pq);
    // local' = P⁻¹ · q · P · local
    bone.quaternion.premultiply(_pq).premultiply(q).premultiply(_pq.invert());
  }
  bone.updateMatrixWorld(true);
}

/** Swings `bone` (minimal rotation) so the direction to `tip` points from it to `goal`. */
function swing(bone: Object3D, tip: Vector3, goal: Vector3): void {
  bone.getWorldPosition(_u);
  _v.subVectors(tip, _u).normalize();
  _x.subVectors(goal, _u).normalize();
  rotateWorld(bone, _q.setFromUnitVectors(_v, _x));
}

/**
 * Moves `end` to `target` by turning `upper` and `lower`, the middle joint bending toward `pole`.
 * Out-of-reach targets get a straight chain pointing at them. Returns the reach error (m).
 */
export function solveTwoBone(upper: Object3D, lower: Object3D, end: Object3D, target: Vector3, pole: Vector3): number {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);
  _n.subVectors(target, _a);
  const want = _n.length();
  const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, want));
  _n.divideScalar(want || 1);
  // bend direction: the pole, made perpendicular to the shoulder → target line
  _pd.subVectors(pole, _a);
  _pd.addScaledVector(_n, -_pd.dot(_n));
  if (_pd.lengthSq() < 1e-10) {
    // pole on the line: keep the current bend plane
    _pd.subVectors(_b, _a);
    _pd.addScaledVector(_n, -_pd.dot(_n));
  }
  _pd.normalize();
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  _e.copy(_a).addScaledVector(_n, along).addScaledVector(_pd, out);
  _h.copy(_a).addScaledVector(_n, dist);
  swing(upper, _b, _e);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  swing(lower, _c, _h);
  end.getWorldPosition(_c);
  return _c.distanceTo(target);
}

/**
 * Turns `bone` so its child `socket` points +Y along `forward` with +Z toward `up` (weapon
 * sockets: +Y is the muzzle, +Z the top of the gun; art/README.md conventions).
 */
export function orientSocket(bone: Object3D, socket: Object3D, forward: Vector3, up: Vector3): void {
  _v.copy(forward).normalize();
  _u.copy(up).addScaledVector(_v, -up.dot(_v)).normalize();
  _x.crossVectors(_v, _u);
  _q.setFromRotationMatrix(_m.makeBasis(_x, _v, _u)); // the socket's desired world rotation
  _q.multiply(_pq.copy(socket.quaternion).invert()); // → the bone's world rotation
  if (bone.parent) _q.premultiply(bone.parent.getWorldQuaternion(_pq).invert());
  bone.quaternion.copy(_q);
  bone.updateMatrixWorld(true);
}
