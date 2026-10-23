/**
 * Inertialization on the final bone rotations (docs/design/character-feel-research.md §3.3, §5.1 A): a discrete pose
 * change (a weapon switch, a pick-up or drop, the shield going up, the aim poses swapping sets) no longer shows in
 * one frame. On the frame it happens, each affected bone keeps the rotation it had and takes the difference to its
 * new pose as an offset, which a critically damped spring then decays to nothing (Holden's spring offsets, "Spring-It-On";
 * the idea of inertial blending). Only the new pose is evaluated from then on, and back-to-back changes chain: a new
 * change starts from wherever the bone is.
 *
 * Cost: per bone, two quaternion copies a frame; while an offset decays (≈ 0.25 s after a change), a quaternion
 * exp and multiply. Nothing else.
 */
import { Quaternion, Vector3, type Object3D } from 'three';

export const INERTIA = {
  /** how long an offset takes to halve (s). At 75 ms the largest jump on the rig (the support hand's ~150°) eases at
   *  ≤ 16°/frame at 60 Hz, and 90% of it is gone in 0.21 s */
  halflife: 0.08,
  /** an offset smaller than this (rad) and slower than this (rad/s) is dropped: the bone is back on its pose */
  rest: 0.0015,
  /** a frame longer than this (s: a stalled tab) lets every offset go: the body is shown as it is now */
  maxDt: 0.25,
  /** an aimed gun's hand (WorldEase) gets back onto the aim as fast as this turn a frame allows (rad), within these
   *  half-lives (s): a small change settles in ~0.1 s, the largest in ~0.3 s */
  maxStep: (13 * Math.PI) / 180,
  minHalflife: 0.03,
};

/**
 * The shortest half-life (s) that eases an offset of `angle` (rad) from rest at no more than INERTIA.maxStep a frame
 * at 60 Hz (the spring's fastest turn is angle × rate / e), between INERTIA.minHalflife and INERTIA.halflife.
 */
export function quickestHalflife(angle: number): number {
  const rate = (INERTIA.maxStep * 60 * Math.E) / Math.max(angle, 1e-6);
  return Math.min(INERTIA.halflife, Math.max(INERTIA.minHalflife, (2 * Math.LN2) / rate));
}

/** The decay rate of Holden's critically damped spring for a half-life (s): y = 2 ln 2 / h. */
export function halflifeRate(halflife: number): number {
  return (2 * Math.LN2) / Math.max(halflife, 1e-5);
}

/**
 * One step of a critically damped spring toward 0 (exact for any dt): `x` and `v` are 3-vectors stored at `i` in
 * the arrays, decayed in place at rate `y` (halflifeRate).
 */
export function decay(x: Float64Array, v: Float64Array, i: number, y: number, dt: number): void {
  const e = Math.exp(-y * dt);
  for (let k = i; k < i + 3; k++) {
    const j1 = v[k]! + x[k]! * y;
    x[k] = e * (x[k]! + j1 * dt);
    v[k] = e * (v[k]! - j1 * y * dt);
  }
}

/** A rotation as its rotation vector (axis × angle, rad), the short way round. */
export function rotationVector(q: Quaternion, out: Vector3): Vector3 {
  const sign = q.w < 0 ? -1 : 1;
  const x = q.x * sign;
  const y = q.y * sign;
  const z = q.z * sign;
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return out.set(2 * x, 2 * y, 2 * z);
  const k = (2 * Math.atan2(s, q.w * sign)) / s;
  return out.set(x * k, y * k, z * k);
}

/** The rotation of a rotation vector (axis × angle, rad). */
export function fromRotationVector(x: number, y: number, z: number, out: Quaternion): Quaternion {
  const angle = Math.hypot(x, y, z);
  if (angle < 1e-9) return out.set(x / 2, y / 2, z / 2, 1).normalize();
  const s = Math.sin(angle / 2) / angle;
  return out.set(x * s, y * s, z * s, Math.cos(angle / 2));
}

const _q = new Quaternion();
const _v = new Vector3();

/**
 * Spring offsets on a set of bones' local rotations. Each frame, after the whole pose is built: `apply(dt)`, then
 * `record()` once anything that pins a bone (an aimed gun's hand) has run. Every bone here must be put back to its
 * animation pose before the mixer runs (the avatar's `posed` list), or the offsets would pile up.
 */
export class Inertializer {
  /** the halving time of an offset (s) */
  halflife = INERTIA.halflife;
  /** offsets as rotation vectors in each bone's parent space (3 per bone), and their rates (rad/s) */
  private readonly off: Float64Array;
  private readonly vel: Float64Array;
  /** each bone's final rotation last frame */
  private readonly last: Quaternion[];
  /** a pose change this frame (apply() takes it), and the bones easing now */
  private readonly changed: Uint8Array;
  private readonly live: Uint8Array;
  private easing = 0;
  private anyPending = false;
  private fresh = true;

  constructor(readonly bones: readonly Object3D[]) {
    this.off = new Float64Array(bones.length * 3);
    this.vel = new Float64Array(bones.length * 3);
    this.last = bones.map((b) => b.quaternion.clone());
    this.changed = new Uint8Array(bones.length);
    this.live = new Uint8Array(bones.length);
  }

  /** Bones easing out of an offset now. */
  get active(): number {
    return this.easing;
  }

  /** A change waits for apply(). */
  get pending(): boolean {
    return this.anyPending;
  }

  /** The offset bone `i` shows now (rad). */
  offsetOf(i: number): number {
    return Math.hypot(this.off[i * 3]!, this.off[i * 3 + 1]!, this.off[i * 3 + 2]!);
  }

  /** The pose of `indices` (default: every bone) changed discontinuously this frame: they ease from where they were. */
  trigger(indices?: readonly number[]): void {
    if (indices) for (const i of indices) this.changed[i] = 1;
    else this.changed.fill(1);
    this.anyPending = true;
  }

  /** No offsets (a respawn: a teleport, shown as it is). */
  reset(): void {
    this.off.fill(0);
    this.vel.fill(0);
    this.changed.fill(0);
    this.live.fill(0);
    this.easing = 0;
    this.anyPending = false;
    this.fresh = true;
  }

  /** Bone `i` shows its pose exactly from now on (an aimed gun's hand): its offset is dropped. */
  pin(i: number): void {
    if (!(i >= 0) || !this.live[i]) return;
    this.live[i] = 0;
    this.easing--;
    this.off.fill(0, i * 3, i * 3 + 3);
    this.vel.fill(0, i * 3, i * 3 + 3);
  }

  /**
   * After the pose is built: a bone whose pose changed this frame takes the difference from last frame's final
   * rotation as its offset (keeping any rate it had); every offset decays by `dt`; each bone shows offset × pose.
   */
  apply(dt: number): void {
    if (dt > INERTIA.maxDt) this.reset();
    const y = halflifeRate(this.halflife);
    for (let i = 0; i < this.bones.length; i++) {
      const q = this.bones[i]!.quaternion;
      if (this.changed[i]) {
        this.changed[i] = 0;
        if (!this.fresh) {
          // offset = last final × pose⁻¹: the bone shows last frame's rotation, then eases onto its pose
          rotationVector(_q.copy(q).invert().premultiply(this.last[i]!), _v);
          _v.toArray(this.off, i * 3);
          if (!this.live[i]) this.easing++;
          this.live[i] = 1;
        }
      }
      if (!this.live[i]) continue;
      decay(this.off, this.vel, i * 3, y, Math.max(0, dt));
      const o = this.off;
      const v = this.vel;
      const k = i * 3;
      if (Math.hypot(o[k]!, o[k + 1]!, o[k + 2]!) < INERTIA.rest && Math.hypot(v[k]!, v[k + 1]!, v[k + 2]!) < INERTIA.rest * 10) {
        this.pin(i);
        continue;
      }
      q.premultiply(fromRotationVector(o[k]!, o[k + 1]!, o[k + 2]!, _q));
    }
    this.anyPending = false;
  }

  /** Keeps this frame's final rotations (the next change eases from them). Call last, after any pins. */
  record(): void {
    for (let i = 0; i < this.bones.length; i++) this.last[i]!.copy(this.bones[i]!.quaternion);
    this.fresh = false;
  }
}

const _w = new Quaternion();

/**
 * One bone's world rotation eased the same way, for a bone whose world turn matters more than its local one: an aimed
 * gun's hand. Its arm may ease through a change, but the hand turns from where it was straight onto the aim, and
 * then stays exact. Call `apply` each frame with the world rotation the bone should have; `trigger` on a change.
 */
export class WorldEase {
  /** this change's half-life (s): as quick as a turn of at most INERTIA.maxStep a frame allows */
  private halflife = INERTIA.halflife;
  private readonly off = new Float64Array(3);
  private readonly vel = new Float64Array(3);
  private readonly last = new Quaternion();
  private has = false;
  private live = false;
  private changed = false;

  trigger(): void {
    this.changed = true;
  }

  reset(): void {
    this.off.fill(0);
    this.vel.fill(0);
    this.has = this.live = this.changed = false;
  }

  /** Whether an offset is still easing out. */
  get active(): boolean {
    return this.live;
  }

  /** A change waits for apply(). */
  get pending(): boolean {
    return this.changed;
  }

  /** `target` (in/out): the world rotation wanted now, turned by what's left of the change. Records the result. */
  apply(target: Quaternion, dt: number): Quaternion {
    if (dt > INERTIA.maxDt) this.reset();
    if (this.changed && this.has) {
      rotationVector(_w.copy(target).invert().premultiply(this.last), _v);
      _v.toArray(this.off, 0);
      this.live = true;
      this.halflife = quickestHalflife(_v.length());
    }
    this.changed = false;
    if (this.live) {
      decay(this.off, this.vel, 0, halflifeRate(this.halflife), Math.max(0, dt));
      const o = this.off;
      if (Math.hypot(o[0]!, o[1]!, o[2]!) < INERTIA.rest && Math.hypot(this.vel[0]!, this.vel[1]!, this.vel[2]!) < INERTIA.rest * 10) {
        this.off.fill(0);
        this.vel.fill(0);
        this.live = false;
      } else target.premultiply(fromRotationVector(o[0]!, o[1]!, o[2]!, _w));
    }
    this.last.copy(target);
    this.has = true;
    return target;
  }

  /** The bone's world rotation this frame came from elsewhere (it wasn't aimed): the next change eases from it. */
  record(world: Quaternion): void {
    this.last.copy(world);
    this.has = true;
    this.off.fill(0);
    this.vel.fill(0);
    this.live = false;
  }
}
