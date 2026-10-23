/**
 * Locomotion (docs/11 §4 "1D locomotion blend by speed; state machine for air/jet/crouch"): which of W8's clips
 * play, how much, and how fast, so the feet keep pace with the ground at every speed.
 *
 * - **Ground:** a base pose (idle, or crouch_idle when crouched) plus the gait cycle on top as an *additive* layer:
 *   the walk and run clips relative to the standing pose (`deltaClip`). The cycle's strength is the step
 *   amplitude: tiny speeds take small careful steps at a steady cadence instead of a slow-motion walk (no
 *   timeScale near 0), and the walk → run blend, the cadence and a stride stretch at speed come from the
 *   measured stride of each clip (`measureCycle`), so the foot sweep matches the ground speed. One shared gait
 *   phase drives every cycle clip, so they stay in step through the blend: walk_slow's careful steps at the
 *   slowest speeds, then W8's walk, then the run. The Forge's planted cycles (#61: walk_slow, run, crouch_walk,
 *   phase 0 = the left foot touching down) are measured for their stance: how far a planted foot travels per cycle
 *   and for how long it is down. Crouch walk is crouch_walk over crouch_idle (on an older rig, the walk cycle over
 *   crouch_idle).
 * - **Air:** jet_ascend, jet_hover and fall, blended by vertical speed.
 * - **Landing:** the land clip as an additive dip, scaled by the impact (motion.ts adds the squash).
 * All actions are driven by hand (time and weight each frame), so the mixer never cross-fades on its own.
 * The pure parts (state machine, gait maths, facing) are unit-tested; Avatar maps them onto the skeleton.
 */
import {
  AnimationClip,
  AnimationMixer,
  AdditiveAnimationBlendMode,
  KeyframeTrack,
  NumberKeyframeTrack,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type AnimationAction,
  type Interpolant,
  type Object3D,
} from 'three';
import { defaultTuning } from '@military-forge/content';
import { createRayHit, type CollisionWorld } from '@military-forge/sim';
import type { CharacterInstance } from './character';
import { solveTwoBone } from './ik';

export type LocoState = 'idle' | 'walk' | 'run' | 'crouch' | 'jet' | 'hover' | 'fall';

export interface LocoInput {
  grounded: boolean;
  crouched: boolean;
  jetting: boolean;
  vx: number;
  vy: number;
}

/** grounded speed (m/s) to start running / to stop again (hysteresis keeps it from flickering) */
export const RUN_ENTER = 0.6;
export const RUN_EXIT = 0.3;
/** airborne this long before 'fall' plays, so step-ups and slope crests don't flash it */
export const FALL_DELAY = 0.12;

/** The coarse state, for whoever needs one name (footstep audio, VFX); the blend itself is continuous. */
export class Locomotion {
  state: LocoState = 'idle';
  private airTime = 0;

  update(p: LocoInput, dt: number): LocoState {
    this.airTime = p.grounded ? 0 : this.airTime + dt;
    const prev = this.state;
    let next: LocoState;
    if (p.grounded) {
      const speed = Math.abs(p.vx);
      if (p.crouched) next = 'crouch';
      else if (speed > (prev === 'run' || prev === 'walk' ? RUN_EXIT : RUN_ENTER)) next = speed >= GAIT.runFrom ? 'run' : 'walk';
      else next = 'idle';
    } else if (p.jetting) {
      next = p.vy > (prev === 'jet' ? 0 : 1) ? 'jet' : 'hover';
    } else if (this.airTime >= FALL_DELAY || p.vy < -2 || prev === 'jet' || prev === 'hover' || prev === 'fall') {
      next = 'fall';
    } else next = prev;
    this.state = next;
    return next;
  }

  /** seconds since the feet left the ground (0 while grounded) */
  get airborne(): number {
    return this.airTime;
  }
}

// ------------------------------------------------------------------ facing and aim

/** Which way the body faces: the same rule the sim uses for the shoulder (cos(aim) ≥ 0 → right). */
export function facingOf(aim: number): 1 | -1 {
  return Math.cos(aim) >= 0 ? 1 : -1;
}

/** Yaw that shows the side view turned this far toward the camera (docs/04 §4.2 "3/4 view"). */
export const TOWARD_CAMERA = (30 * Math.PI) / 180;
/** docs/04 §4.2: a full 180° turn takes 120 ms (the old constant-rate turn; TurnClock eases it instead) */
export const TURN_RATE = Math.PI / 0.12;

export function facingYaw(facing: 1 | -1): number {
  return facing * (Math.PI / 2 - TOWARD_CAMERA);
}

/** Turns `yaw` toward `target` at TURN_RATE; the path passes through facing the camera (yaw 0). */
export function stepYaw(yaw: number, target: number, dt: number): number {
  const step = TURN_RATE * dt;
  return Math.abs(target - yaw) <= step ? target : yaw + Math.sign(target - yaw) * step;
}

/**
 * The facing turn with a step (docs/design/character-feel-research.md §3.4, §5.1 C): the yaw eases in and out (a
 * smootherstep, so it starts and stops at rest) over TURN.seconds for the full 120° through facing the camera, still
 * under 6 frames; standing, the feet step to their new spots over TURN.stepSeconds (FootPlanter), the hips dip
 * TURN.dip, and the spine and head lead the hips with a little overshoot (MotionLayer).
 */
export const TURN = {
  seconds: 0.1,
  /** standing, the feet step within this long after the turn starts (s), each lifted this high (m) at mid-step */
  stepSeconds: 0.2,
  lift: 0.04,
  /** and the hips dip this much (m) over the steps */
  dip: 0.015,
  /** a turn on the spot: below this ground speed (m/s); faster, the gait's planting carries the feet round */
  standing: 0.3,
};

export const smootherstep = (u: number): number => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * t * (t * (6 * t - 15) + 10);
};

/** The eased facing turn: `update` each frame with the yaw the facing wants; `yaw` is what the body shows. */
export class TurnClock {
  yaw: number | null = null;
  /** the turn under way: from, to, and how far through it (0…1; 1 = none) */
  from = 0;
  to = 0;
  t = 1;
  private seconds = TURN.seconds;

  update(target: number, dt: number): number {
    if (this.yaw === null) {
      this.yaw = this.from = this.to = target;
      return target;
    }
    if (target !== this.to) {
      // a new turn (or a turn back mid-turn) from wherever the body is, its length in proportion to the angle
      this.from = this.yaw;
      this.to = target;
      this.t = 0;
      this.seconds = TURN.seconds * Math.max(0.4, Math.abs(target - this.from) / (2 * facingYaw(1)));
    }
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.seconds);
      this.yaw = this.from + (this.to - this.from) * smootherstep(this.t);
    }
    return this.yaw;
  }

  /** A turn is under way. */
  get turning(): boolean {
    return this.t < 1;
  }
}

/** Aim angle above the horizontal on the side the player faces, −π/2…π/2. */
export function aimElevation(aim: number): number {
  return Math.atan2(Math.sin(aim), Math.abs(Math.cos(aim)));
}

// ------------------------------------------------------------------ gait maths

export const GAIT = {
  /** the body is turned 30° toward the camera, so only sin(60°) of a stride runs along the gameplay plane */
  planeShare: Math.sin(Math.PI / 2 - TOWARD_CAMERA),
  /** below this (m/s) the feet stand still */
  stillBelow: 0.03,
  /** gait cycles per second never drop below this while moving: slower speeds take shorter steps instead */
  minCadence: 1.25,
  /** a cadence the eye reads as hurried but not frantic; above it the stride stretches first */
  comfortCadence: 3.0,
  maxCadence: 5.5,
  /** stride stretch at speed: the cycle's leg swing is amplified up to this */
  maxWarp: 1.45,
  /** careful steps (walk_slow) → walk cross-blend (m/s): walk_slow is authored for 0.5 m/s */
  slowTo: [0.5, 0.9] as const,
  /** walk → run cross-blend (m/s) */
  runFrom: 1.4,
  runTo: 2.8,
  /** a run never steps slower than this (cycles/s): below its stride's speed it takes shorter strides instead of
   *  floating in slow motion */
  runMinCadence: 2.4,
  /** and stretches its stride only above this cadence (the Forge's run is authored at 3 cycles/s for 5 m/s, a
   *  little more along the gameplay plane) */
  runComfortCadence: 3.5,
  /** crouch walk is a shorter-legged walk */
  crouchStride: 0.8,
  /** if a clip's measured sweep is below this (m), it isn't a stepping clip: use FALLBACK_SWEEP */
  minSweep: 0.06,
  fallbackSweep: 0.3,
  /** a foot within this (m) of its lowest is on the ground (measureCycle) */
  contact: 0.01,
};

/** What a gait cycle clip does with the feet, measured from its keys. */
export interface Cycle {
  /** front-to-back foot travel (m, along the body's forward axis), averaged over both feet */
  sweep: number;
  /** cycle phase (0..1) where the left foot is furthest forward */
  leftFront: number;
  /** a clip with a real stance (the Forge's planted cycles): how far a planted foot travels back per cycle (m, along
   *  the body's forward axis), the share of the cycle each foot is down, and the phase the left foot touches down.
   *  W8's older cycles keep a foot lowest at the front of its swing and have none of these. */
  stance?: { stride: number; share: number; touchDown: number };
}

export interface Gait {
  /** strength of the stepping layer, 0 (standing) … 1 (full steps) */
  amplitude: number;
  /** run share of the cycle, 0 walk … 1 run */
  run: number;
  /** share of the walk that is careful steps (walk_slow), 0 … 1 */
  slow?: number;
  /** stride stretch, ≥ 1 (the cycle's leg swing amplified) */
  warp: number;
  /** gait cycles per second (≥ minCadence while moving) */
  cadence: number;
  /** ground covered per cycle along the gameplay plane at this blend (m) */
  stride: number;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Distance along the gameplay plane one full cycle of `c` covers when the planted foot doesn't slide. */
export function planeStride(c: Cycle): number {
  if (c.stance) return c.stance.stride * GAIT.planeShare;
  const sweep = c.sweep >= GAIT.minSweep ? c.sweep : GAIT.fallbackSweep;
  return 2 * sweep * GAIT.planeShare;
}

/** `a` turned a share `t` of the shorter way toward `b`, both cycle phases (0..1). */
export function blendPhase(a: number, b: number, t: number): number {
  const d = ((((b - a) % 1) + 1.5) % 1) - 0.5;
  return (((a + d * t) % 1) + 1) % 1;
}

/**
 * The gait for a ground speed (m/s, ≥ 0): a planted foot sweeps back at amplitude × warp × stride × cadence,
 * which equals `speed` except where the cadence clamps (above maxCadence at full stretch).
 */
export function gaitFor(speed: number, walk: Cycle, run: Cycle, crouch: Cycle | boolean = false, slow: Cycle | null = null, blendSpeed = speed): Gait {
  const crouched = crouch !== false;
  // which cycles blend follows `blendSpeed` (the avatar eases it, so a wall stopping a run doesn't swap the run pose
  // for the walk's in one frame); the cadence below keeps the feet on the true speed whatever the blend
  const r = crouched ? 0 : smoothstep(GAIT.runFrom, GAIT.runTo, blendSpeed);
  const sl = slow && !crouched ? 1 - smoothstep(GAIT.slowTo[0], GAIT.slowTo[1], blendSpeed) : 0;
  const walking = (slow ? planeStride(slow) * sl : 0) + planeStride(walk) * (1 - sl);
  // crouched: the crouch cycle's own stride, or (an older rig) a shorter-legged walk
  const base = crouched ? (typeof crouch === 'object' ? planeStride(crouch) : planeStride(walk) * GAIT.crouchStride) : walking * (1 - r) + planeStride(run) * r;
  const minCadence = GAIT.minCadence + (GAIT.runMinCadence - GAIT.minCadence) * r;
  const comfort = GAIT.comfortCadence + (GAIT.runComfortCadence - GAIT.comfortCadence) * r;
  if (speed < GAIT.stillBelow) return { amplitude: 0, run: r, slow: sl, warp: 1, cadence: minCadence, stride: base };
  const warp = Math.min(GAIT.maxWarp, Math.max(1, speed / (comfort * base)));
  const stride = base * warp;
  const amplitude = Math.min(1, speed / (minCadence * stride));
  const cadence = Math.min(GAIT.maxCadence, Math.max(minCadence, speed / stride));
  return { amplitude, run: r, slow: sl, warp, cadence, stride };
}

// ------------------------------------------------------------------ clip preparation

/** Upper-body bones (W8 rookie.json `upperBodyBones`): what the aim poses own when armed. */
export const UPPER_BODY = ['spine1', 'spine2', 'neck', 'head', 'clavicle_L', 'clavicle_R', 'upperarm_L', 'upperarm_R', 'forearm_L', 'forearm_R', 'hand_L', 'hand_R'];

const boneOf = (track: KeyframeTrack) => track.name.slice(0, track.name.lastIndexOf('.'));

/** KeyframeTrack's runtime interpolant factory (three sets it per interpolation; the typings leave it out). */
type Interpolating = KeyframeTrack & { createInterpolant: (() => Interpolant) & { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } };

/** Components per key (W8 exports CUBICSPLINE: in-tangent, value, out-tangent per key). */
function componentSize(track: KeyframeTrack): number {
  return track.getValueSize() / ((track as Interpolating).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline ? 3 : 1);
}

/** A linear copy of a track's values at its own key times (cubic-spline tangents dropped; keys are 30 fps). */
function linearValues(track: KeyframeTrack): Float32Array {
  const size = componentSize(track);
  const interpolant = (track as Interpolating).createInterpolant();
  const out = new Float32Array(track.times.length * size);
  track.times.forEach((t, i) => out.set(interpolant.evaluate(t).subarray(0, size), i * size));
  return out;
}

const _q = new Quaternion();
const _r = new Quaternion();

/**
 * `clip` relative to a reference pose, as an additive clip: quaternion keys become ref⁻¹ × q and vector keys
 * v − ref, where ref is `reference`'s first frame for the bones it keys and the rest pose for the others
 * (three's makeClipAdditive leaves tracks the reference doesn't key absolute, and it ignores cubic-spline
 * tangents). `keep` filters the bones (upper body off when the aim layer owns it).
 */
export function deltaClip(clip: AnimationClip, reference: AnimationClip, rest: (bone: string) => RestPose | undefined, keep: (bone: string) => boolean = () => true): AnimationClip {
  const refFirst = new Map(reference.tracks.map((t) => [t.name, Array.from(linearValues(t).subarray(0, componentSize(t)))]));
  const tracks: KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const bone = boneOf(track);
    if (!keep(bone)) continue;
    const pose = rest(bone);
    const property = track.name.slice(track.name.lastIndexOf('.') + 1) as keyof RestPose;
    const values = linearValues(track);
    const ref = refFirst.get(track.name) ?? pose?.[property];
    if (!ref) continue; // a property we can't reference: leave it to the base layer
    if (track instanceof QuaternionKeyframeTrack) {
      _r.fromArray(ref).normalize().invert();
      for (let i = 0; i < values.length; i += 4) _q.fromArray(values, i).premultiply(_r).toArray(values, i);
      tracks.push(new QuaternionKeyframeTrack(track.name, Array.from(track.times), Array.from(values)));
    } else {
      for (let i = 0; i < values.length; i++) values[i]! -= ref[i % ref.length]!;
      const Track = track instanceof VectorKeyframeTrack ? VectorKeyframeTrack : NumberKeyframeTrack;
      tracks.push(new Track(track.name, Array.from(track.times), Array.from(values)));
    }
  }
  const out = new AnimationClip(`${clip.name}_delta`, clip.duration, tracks);
  out.blendMode = AdditiveAnimationBlendMode;
  return out;
}

/** A bone's rest transform, as flat arrays (what an unkeyed track falls back to). */
export interface RestPose {
  quaternion: number[];
  position: number[];
  scale: number[];
}

/** Every bone's transform under `root` right now: call it before anything animates. */
export function restPoses(root: Object3D): Map<string, RestPose> {
  const out = new Map<string, RestPose>();
  root.traverse((o) => {
    if (o.name && !out.has(o.name)) out.set(o.name, { quaternion: o.quaternion.toArray(), position: o.position.toArray(), scale: o.scale.toArray() });
  });
  return out;
}

/** `clip` without the bones `keep` rejects (a normal-blend copy). */
export function filteredClip(clip: AnimationClip, keep: (bone: string) => boolean): AnimationClip {
  return new AnimationClip(clip.name, clip.duration, clip.tracks.filter((t) => keep(boneOf(t))));
}

const _foot = new Vector3();

/**
 * Plays `clip` once over the skeleton under `root` (sampled, then put back) and measures how far the feet
 * travel along the body's forward axis (+Z), where the left foot is furthest forward, and, for a clip with a real
 * stance, how the planted foot moves while it is down.
 */
export function measureCycle(clip: AnimationClip, root: Object3D, samples = 60): Cycle {
  const feet = ['foot_L', 'foot_R'].map((n) => root.getObjectByName(n) ?? null);
  if (!feet[0] || !feet[1]) return { sweep: 0, leftFront: 0 };
  const saved: { o: Object3D; q: Quaternion; p: Vector3 }[] = [];
  root.traverse((o) => saved.push({ o, q: o.quaternion.clone(), p: o.position.clone() }));
  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip).play();
  const z: number[][] = [[], []];
  const y: number[][] = [[], []];
  for (let i = 0; i < samples; i++) {
    action.time = (i / samples) * clip.duration;
    mixer.update(0);
    root.updateMatrixWorld(true);
    feet.forEach((f, k) => {
      root.worldToLocal(f!.getWorldPosition(_foot));
      z[k]!.push(_foot.z);
      y[k]!.push(_foot.y);
    });
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  for (const s of saved) {
    s.o.quaternion.copy(s.q);
    s.o.position.copy(s.p);
  }
  root.updateMatrixWorld(true);
  const sweep = z.reduce((sum, zs) => sum + Math.max(...zs) - Math.min(...zs), 0) / 2;
  const left = z[0]!;
  const cycle: Cycle = { sweep, leftFront: left.indexOf(Math.max(...left)) / samples };
  // the stance: a foot within GAIT.contact of its lowest is down; while down it moves back at the ground speed
  let share = 0;
  let back = 0;
  let pairs = 0;
  let touchDown = -1;
  for (let k = 0; k < 2; k++) {
    const ys = y[k]!;
    const low = Math.min(...ys) + GAIT.contact;
    for (let i = 0; i < samples; i++) {
      const j = (i + 1) % samples;
      if (ys[i]! > low) continue;
      share += 1 / (2 * samples);
      if (ys[j]! <= low) {
        back += (z[k]![i]! - z[k]![j]!) * samples;
        pairs++;
      }
      if (k === 0 && touchDown < 0 && ys[(i + samples - 1) % samples]! > low) touchDown = i / samples;
    }
  }
  const stride = pairs ? back / pairs : 0;
  // a real stance carries the foot back through most of its sweep while it is down (W8's older walk: a quarter)
  if (touchDown >= 0 && share >= 0.1 && stride * share >= 0.6 * sweep && sweep >= GAIT.minSweep) cycle.stance = { stride, share, touchDown };
  return cycle;
}

// ------------------------------------------------------------------ the blend tree on a mixer

/** Critically damped spring (no overshoot, no lerp jitter): x chases `target` with angular frequency `omega`. */
export class Spring {
  v = 0;
  constructor(
    public x = 0,
    public omega = 12,
  ) {}

  step(target: number, dt: number): number {
    const w = this.omega;
    const e = Math.exp(-w * dt);
    const d = this.x - target;
    const c = this.v + w * d;
    this.x = target + (d + c * dt) * e;
    this.v = (this.v - w * c * dt) * e;
    return this.x;
  }
}

interface Layer {
  action: AnimationAction;
  /** seconds per loop (for the free-running clips) */
  duration: number;
}

/** A jet take-off: for this long (s) the climb pose comes in on a fast spring (rad/s), full at this climb speed (m/s). */
export const TAKEOFF = { seconds: 0.35, omega: 30, full: 1.2 };

/** Ground clips that may be missing from a clip set, with what stands in for them. */
const BASE_CLIPS = {
  idle: ['idle'],
  crouch: ['crouch_idle', 'idle'],
  // the Forge's careful steps for the slowest speeds (#61: "prefer walk_slow at low speed"), then W8's walk
  slow: ['walk_slow'],
  walk: ['walk', 'walk_slow', 'run'],
  run: ['run', 'walk'],
  ascend: ['jet_ascend', 'jet_hover', 'fall', 'idle'],
  hover: ['jet_hover', 'jet_ascend', 'fall', 'idle'],
  fall: ['fall', 'jet_hover', 'idle'],
} as const;

function slotsOf(layers: Record<string, Layer | null>): Map<AnimationAction, { w: number; t: number }> {
  return new Map(Object.values(layers).flatMap((l) => (l ? [[l.action, { w: 0, t: -1 }] as const] : [])));
}

const measured = new WeakMap<AnimationClip, Cycle>();
const lowerBody = new WeakMap<AnimationClip, AnimationClip>();
const deltas = new WeakMap<AnimationClip, Map<string, AnimationClip>>();

/**
 * One character's locomotion on its AnimationMixer. Call update() before mixer.update(); read `state`, `phase`
 * (the gait cycle, 0..1: the left foot is forward near `leftFront`) and `landing` (motion.ts).
 */
export class LocoLayer {
  readonly machine = new Locomotion();
  /** gait cycle phase, 0..1 */
  phase = 0;
  /** the latest gait (amplitude, run share, cadence…) */
  gait: Gait = { amplitude: 0, run: 0, warp: 1, cadence: GAIT.minCadence, stride: 0 };
  /** set for one update when the feet touch down: the vertical speed of the impact (m/s, > 0) */
  landing = 0;
  /** how much the stepping cycle shows (ground share × step amplitude, smoothed), 0..1: foot planting follows it */
  stepWeight = 0;
  /** ground pose share, 0 (air) … 1 (ground) */
  groundWeight = 1;
  /** crouch pose share, 0 … 1 */
  crouchWeight = 0;
  /** share of the cycle each foot is down at this gait, and the phase the left foot touches down (foot planting) */
  stance: number = FEET.stanceWalk;
  touchDown = 0;
  /** how far the stepping cycle lets feet be held (0..1): not on an older rig's crouch walk, which barely moves them */
  plantable = 1;
  /** the body's facing (+1 right, −1 left), set by the avatar each frame: backpedalling runs the cycle in reverse */
  facing: 1 | -1 | null = null;
  readonly walk: Cycle;
  readonly run: Cycle;
  /** the careful-steps cycle (the Forge's walk_slow), or null on an older rig */
  readonly slow: Cycle | null;
  /** the crouch stepping cycle (the Forge's crouch_walk), or null on an older rig */
  readonly crouchWalk: Cycle | null;
  private readonly clips = new Map<string, AnimationClip>();
  /** the skeleton's rest pose, taken before anything animates (the reference for unkeyed delta tracks) */
  private readonly rest: Map<string, RestPose>;
  private layers: Record<'idle' | 'crouch' | 'slow' | 'walk' | 'run' | 'crouchStep' | 'ascend' | 'hover' | 'fall' | 'land', Layer | null>;
  /** this frame's weight and time per distinct action */
  private slots = new Map<AnimationAction, { w: number; t: number }>();
  private upperBody = true;
  private readonly ground = new Spring(1, 22);
  private readonly crouch = new Spring(0, 14);
  private readonly amplitude = new Spring(0, 16);
  /** the speed the walk ↔ run blend follows: eased, so a sudden stop fades the run out instead of cutting it */
  private readonly blendSpeed = new Spring(0, 10);
  private readonly ascend = new Spring(0, 10);
  private readonly fallW = new Spring(0, 10);
  private readonly clock: number[];
  private landT = Infinity;
  private landWeight = 0;
  private wasGrounded = true;
  private lastVy = 0;
  /** seconds since a jet take-off (Infinity on the ground) */
  private sinceTakeoff = Infinity;

  constructor(
    private readonly mixer: AnimationMixer,
    private readonly inst: Pick<CharacterInstance, 'root' | 'clips' | 'bone'>,
    seed: number,
  ) {
    for (const c of inst.clips) this.clips.set(c.name, c);
    this.rest = restPoses(inst.root);
    const pick = (names: readonly string[]) => names.map((n) => this.clips.get(n)).find((c) => c) ?? null;
    const walk = pick(BASE_CLIPS.walk);
    const run = pick(BASE_CLIPS.run);
    this.walk = walk ? this.measure(walk) : { sweep: 0, leftFront: 0 };
    this.run = run ? this.measure(run) : this.walk;
    const slow = pick(BASE_CLIPS.slow);
    this.slow = slow && slow !== walk ? this.measure(slow) : null;
    const crouchWalk = this.clips.get('crouch_walk');
    const measuredCrouch = crouchWalk && this.clips.has('crouch_idle') ? this.measure(crouchWalk) : null;
    this.crouchWalk = measuredCrouch?.stance ? measuredCrouch : null;
    // dummies standing side by side shouldn't breathe in sync
    this.clock = Array.from({ length: 8 }, (_, i) => ((seed + 1) * 0.37 * (i + 1)) % 7);
    this.layers = this.build();
    this.slots = slotsOf(this.layers);
  }

  get state(): LocoState {
    return this.machine.state;
  }

  /** Locomotion with or without its upper-body tracks (off when the aim poses own the upper body, as in W8's viewer). */
  setUpperBody(on: boolean): void {
    if (on === this.upperBody) return;
    this.upperBody = on;
    for (const l of Object.values(this.layers)) {
      if (!l) continue;
      l.action.stop();
      this.mixer.uncacheAction(l.action.getClip());
    }
    this.layers = this.build();
    this.slots = slotsOf(this.layers);
  }

  update(p: LocoInput, dt: number): LocoState {
    const state = this.machine.update(p, dt);
    const speed = Math.abs(p.vx);
    // ground ↔ air: hold the ground pose through step-ups and slope crests (FALL_DELAY)
    const onGround = p.grounded || (!p.jetting && this.machine.airborne < FALL_DELAY && p.vy > -2);
    const g = this.ground.step(onGround ? 1 : 0, dt);
    const c = this.crouch.step(p.crouched && p.grounded ? 1 : 0, dt);
    this.gait = gaitFor(speed, this.walk, this.run, c > 0.5 && (this.crouchWalk ?? true), this.slow, this.blendSpeed.step(speed, dt));
    const a = this.amplitude.step(this.gait.amplitude, dt);
    this.groundWeight = g;
    this.crouchWeight = c;
    this.stepWeight = g * a;
    // where the feet are down in this blend of cycles (planted feet follow it)
    const cw = this.crouchWalk ? c : 0;
    const sl = this.gait.slow ?? 0;
    const walkOnly = this.walk.stance?.share ?? FEET.stanceWalk;
    const walkShare = walkOnly + ((this.slow?.stance?.share ?? walkOnly) - walkOnly) * sl;
    const runShare = this.run.stance?.share ?? FEET.stanceRun;
    this.stance = (walkShare + (runShare - walkShare) * this.gait.run) * (1 - cw) + (this.crouchWalk?.stance?.share ?? 0) * cw;
    const walkDown = this.walk.stance?.touchDown ?? this.walk.leftFront;
    const walkingDown = this.slow ? blendPhase(walkDown, this.slow.stance?.touchDown ?? this.slow.leftFront, sl) : walkDown;
    const uprightDown = blendPhase(walkingDown, this.run.stance?.touchDown ?? this.run.leftFront, this.gait.run);
    this.touchDown = this.crouchWalk ? blendPhase(uprightDown, this.crouchWalk.stance!.touchDown, cw) : uprightDown;
    this.plantable = this.crouchWalk ? 1 : 1 - smoothstep(0.1, 0.9, c);
    // a planted foot sweeps back while moving forward: run the cycle backwards when backpedalling
    const dir = p.vx === 0 ? 0 : Math.sign(p.vx) * (this.facing ?? Math.sign(p.vx));
    this.phase = (((this.phase + this.gait.cadence * dt * dir) % 1) + 1) % 1;

    // air: ascend while thrusting up, fall when dropping, hover in between. Off the ground on the jet the climb pose
    // comes in fast (TAKEOFF): it's there within ~0.2 s, not after the body is already flying
    this.sinceTakeoff = p.grounded ? Infinity : this.wasGrounded && p.jetting ? 0 : this.sinceTakeoff + dt;
    const takingOff = this.sinceTakeoff < TAKEOFF.seconds;
    this.ascend.omega = takingOff ? TAKEOFF.omega : 10;
    const up = this.ascend.step(p.jetting ? smoothstep(takingOff ? 0.05 : 0.2, takingOff ? TAKEOFF.full : 2.5, p.vy) : 0, dt);
    const down = this.fallW.step(p.jetting ? 0 : smoothstep(0.5, -2.5, p.vy), dt);
    const hover = Math.max(0, 1 - up - down);

    // landing: the vertical speed just before touch-down
    this.landing = p.grounded && !this.wasGrounded ? Math.max(0, -this.lastVy) : 0;
    if (this.landing > 0) {
      this.landT = 0;
      this.landWeight = Math.min(0.6, 0.35 + this.landing / 14);
    }
    this.wasGrounded = p.grounded;
    this.lastVy = p.vy;
    this.landT += dt;

    const L = this.layers;
    for (const slot of this.slots.values()) {
      slot.w = 0;
      slot.t = -1;
    }
    for (let i = 0; i < this.clock.length; i++) this.clock[i]! += dt;
    this.drive(L.idle, g * (1 - c), this.clock[0]!);
    this.drive(L.crouch, g * c, this.clock[1]!);
    this.drive(L.ascend, (1 - g) * up, this.clock[2]!);
    this.drive(L.hover, (1 - g) * hover, this.clock[3]!);
    this.drive(L.fall, (1 - g) * down, this.clock[4]!);
    // the stepping layer, phase-locked (every cycle shares the phase; a missing run reuses walk). Crouched, the
    // crouch cycle steps over crouch_idle instead (an older rig: the walk over crouch_idle)
    const step = g * a * this.gait.warp;
    const upright = L.crouchStep ? 1 - c : 1;
    const careful = L.slow ? (this.gait.slow ?? 0) : 0;
    if (L.run === L.walk) this.drive(L.walk, step * upright * (1 - careful), this.phase * (L.walk?.duration ?? 0));
    else {
      this.drive(L.walk, step * upright * (1 - this.gait.run) * (1 - careful), this.phase * (L.walk?.duration ?? 0));
      this.drive(L.run, step * upright * this.gait.run, this.phase * (L.run?.duration ?? 0));
    }
    this.drive(L.slow, step * upright * (1 - this.gait.run) * careful, this.phase * (L.slow?.duration ?? 0));
    this.drive(L.crouchStep, step * (1 - upright), this.phase * (L.crouchStep?.duration ?? 0));
    // the land clip is a dip from and back to its first frame: a constant weight, faded out over its last frames
    // (it comes in over the landing's attack, 3 frames, so the knees don't snap: motion.ts SQUASH.attack)
    const land = L.land && this.landT < L.land.duration ? this.landWeight * Math.min(1, this.landT / 0.05) * (1 - smoothstep(0.8 * L.land.duration, L.land.duration, this.landT)) : 0;
    this.drive(L.land, land, Math.min(this.landT, L.land?.duration ?? 0));
    for (const [action, slot] of this.slots) {
      action.setEffectiveWeight(slot.w);
      if (slot.t >= 0) action.time = slot.t;
    }
    return state;
  }

  /** The weight each layer asked for this frame (tests, debugging; a stand-in clip shared by two layers sums them). */
  weights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, l] of Object.entries(this.layers)) if (l) out[k] = this.slots.get(l.action)!.w;
    return out;
  }

  /** Adds `weight` to a layer's action for this frame (a missing clip's stand-in can serve two layers). */
  private drive(layer: Layer | null, weight: number, time: number): void {
    if (!layer) return;
    const slot = this.slots.get(layer.action)!;
    slot.w += weight;
    if (slot.t < 0) slot.t = layer.duration > 0 ? time % layer.duration : 0;
  }

  private measure(clip: AnimationClip): Cycle {
    let m = measured.get(clip);
    if (!m) {
      m = measureCycle(clip, this.inst.root);
      measured.set(clip, m);
    }
    return m;
  }

  /** The additive copy of a cycle clip relative to the standing pose (shared by every avatar with this clip set). */
  private delta(clip: AnimationClip, reference: AnimationClip | null): AnimationClip {
    let byKey = deltas.get(clip);
    if (!byKey) deltas.set(clip, (byKey = new Map()));
    const key = `${reference?.name ?? 'rest'}|${this.upperBody}`;
    let d = byKey.get(key);
    if (!d) {
      const keep = this.upperBody ? () => true : (bone: string) => !UPPER_BODY.includes(bone);
      d = deltaClip(clip, reference ?? new AnimationClip('rest', 0, []), (bone) => this.rest.get(bone), keep);
      byKey.set(key, d);
    }
    return d;
  }

  private build(): LocoLayer['layers'] {
    const pick = (names: readonly string[]) => names.map((n) => this.clips.get(n)).find((c) => c) ?? null;
    const keep = this.upperBody ? null : (bone: string) => !UPPER_BODY.includes(bone);
    const play = (clip: AnimationClip | null): Layer | null => {
      if (!clip) return null;
      let lower = keep && lowerBody.get(clip);
      if (keep && !lower) lowerBody.set(clip, (lower = filteredClip(clip, keep)));
      const action = this.mixer.clipAction(lower || clip);
      action.play();
      action.timeScale = 0; // time is set by hand every frame
      action.setEffectiveWeight(0);
      return { action, duration: clip.duration };
    };
    const additive = (clip: AnimationClip | null, reference: AnimationClip | null): Layer | null => {
      if (!clip) return null;
      const action = this.mixer.clipAction(this.delta(clip, reference));
      action.play();
      action.timeScale = 0;
      action.setEffectiveWeight(0);
      return { action, duration: clip.duration };
    };
    const idle = pick(BASE_CLIPS.idle);
    const walkClip = pick(BASE_CLIPS.walk);
    const runClip = pick(BASE_CLIPS.run);
    const walk = additive(walkClip, idle);
    const land = this.clips.get('land') ?? null;
    const crouchIdle = pick(BASE_CLIPS.crouch);
    return {
      idle: play(idle),
      crouch: play(crouchIdle),
      // (slow is measured in the constructor, before the first build)
      slow: this.slow ? additive(pick(BASE_CLIPS.slow), idle) : null,
      walk,
      run: runClip === walkClip ? walk : additive(runClip, idle),
      // (crouchWalk is measured in the constructor, before the first build)
      crouchStep: this.crouchWalk ? additive(this.clips.get('crouch_walk')!, crouchIdle) : null,
      ascend: play(pick(BASE_CLIPS.ascend)),
      hover: play(pick(BASE_CLIPS.hover)),
      fall: play(pick(BASE_CLIPS.fall)),
      land: additive(land, land),
    };
  }
}

// ------------------------------------------------------------------ planted feet

/**
 * Planted feet. W8's cycles keep a foot lowest at the front of its swing and lift it on the way back, so a
 * cycle alone slides the feet whatever the cadence. While the gait says a foot is down, it is held where it
 * touched the ground: two-bone IK on the leg, the hips dipping a little when a planted leg needs the reach.
 */
export const FEET = {
  /** share of a gait cycle each foot spends planted, for cycles without a measured stance (W8's older clips) */
  stanceWalk: 0.44,
  stanceRun: 0.4,
  /** how firmly a foot plants at a sprint's cadence (cycles/s → strength): a 70 ms stance can't fade in and out over
   *  3–4 frames, so the plant softens rather than snaps */
  sprint: [3, 5, 0.7] as const,
  /** the plant fades in and out over at least this long (s), 4 frames at 60 fps, so a knee never snaps; capped at
   *  half the stance (at a run a stance lasts ~7 frames, so the foot only touches down and lifts) */
  fadeSeconds: 0.07,
  /** how quickly a plant's weight follows stopping, dashing or reaching too far (critically damped, rad/s):
   *  a foot is let go over ~5 frames instead of snapping back to the clip */
  weightOmega: 30,
  /** the hips may dip this far (m) so a planted leg reaches its foot */
  maxDip: 0.08,
  /** on a slope the capsule's rounded bottom (the player's y) sits above the ground under its middle (5 cm at 30°,
   *  13 cm at 45°): the body comes down to the ground by at most this (m) */
  maxSettle: 0.15,
  /** how quickly the body settles onto a slope and back up off it (critically damped, rad/s) */
  settleOmega: 30,
  /** a planted leg straightens to at most this share of its length */
  reach: 0.995,
  /** a planted leg the clip has bent may unbend to this share of its length before the hips dip */
  unbend: 0.9,
  /** a planted foot this far ahead of or behind the hip (share of the leg's length) lets go instead of straightening
   *  the leg: past ~0.7 even the full hip dip can't reach it */
  release: [0.62, 0.72] as const,
  /** a lock this far (m) from where the clip has the foot is stale (a teleport, a respawn): plant afresh */
  stale: 0.6,
  /** a foot whose clip ankle is within this (m) of standing on the floor is down: held from this share of a cycle
   *  before its stance to this share after (contact holds; a foot that lifts lets go over `letGo` s) */
  contact: 0.015,
  early: 0.08,
  late: 0.12,
  /** …and only while the foot is within this share of the release distance (FEET.release[0]) */
  lateReach: 0.8,
  letGo: 0.08,
  letGoSpeed: 1.5,
  letGoMax: 0.25,
  /** a swinging foot is at least this high (m) over the floor at mid-swing */
  clearance: 0.03,
  /** a held foot the full dip falls this much short of (m) is let go (the body has climbed a step away from it) */
  overreach: 0.04,
  /** half a sole's length (m): a foot stands on the highest floor within this of its ankle */
  sole: 0.06,
  /** how fast the floor under a swinging foot may rise or fall: per metre the foot moves along (any walkable slope)
   *  plus per second (m/s), so a step's edge takes a few frames */
  climb: [1.2, 0.6] as const,
  /** how fast (m/s) a swinging foot lifted out of the ground is let back down to the clip's swing */
  letDown: 0.9,
  /** a foot is kept out of the ground softly: over this span (m) around touching it, it eases from following the
   *  clip to following the ground, so it doesn't stop dead on a slope; a foot standing on flat ground is left within
   *  a millimetre of the clip, and none goes more than half of this into the ground */
  soft: 0.015,
  /** how fast (m/s) a swinging foot may be lifted out of the ground: a run's foot meeting a rising slope is
   *  lifted over a few frames rather than in one (it may touch into the slope for a frame or two) */
  liftRate: 3,
  /** and never further than this (m): a step's height and then some */
  maxLift: 0.3,
};

/** max(0, x), rounded off over ±`soft` so what follows it has no corner (C¹). */
export function softPlus(x: number, soft: number): number {
  if (x <= -soft) return 0;
  if (x >= soft) return x;
  return ((x + soft) * (x + soft)) / (4 * soft);
}

/** Share (0..1) of the stance a foot is in at gait `phase`, or −1 while it swings. `front`: its touch-down phase. */
export function stanceAt(phase: number, front: number, stance: number): number {
  const u = (((phase - front) % 1) + 1) % 1;
  return u < stance ? u / stance : -1;
}

/**
 * How firmly a foot is planted at stance share `s` (fades in and out at both ends, whichever way the cycle runs).
 * The fades last FEET.fadeSeconds at this `cadence` (cycles/s), capped at half the stance.
 */
export function plantWeight(s: number, stance: number, cadence: number): number {
  if (s < 0) return 0;
  const edge = Math.min(0.5, (FEET.fadeSeconds * cadence) / stance);
  return smoothstep(0, edge, s) * smoothstep(0, edge, 1 - s);
}

/** One foot's stance: where it was put down, and how firmly it is held there now. */
interface Plant {
  locked: boolean;
  /** where it touched down (world x) */
  x: number;
  /** world height of the floor under it */
  ground: number;
  /** how firmly it may be held: moving, not sprinting, not reaching too far (0..1), eased so stopping, dashing
   *  or reaching too far lets go over a few frames */
  weight: Spring;
  /** how firmly it is held this frame: `weight` through the stance's fades (0..1) */
  held: number;
  /** the floor under the foot as it swings (world height), eased up a step's edge */
  swing: number;
  /** where that was read (world x); NaN: no reading (after time in the air, a teleport) */
  swingX: number;
  /** how far (m) the free foot is lifted to keep it out of the ground */
  push: number;
  /** this frame's ankle target along the ground (world x), and its height held (world y) */
  tx: number;
  ty: number;
  /** how far (m) the hips must dip for this leg to reach where it landed */
  need: number;
  /** how far (m) this leg may reach from the hip to its target */
  reach: number;
  /** held in a stance (or on the floor near one) this frame; where the clip had the ankle last frame (world x) */
  holding: boolean;
  clipX: number;
}

/** What planting reads from a player view. */
export interface PlantInput {
  /** feet height (the ground under a grounded player); without it the avatar's pivot height is used */
  y?: number;
  vx: number;
  /** on the ground this tick (default true): the floor under the feet is only read on the ground */
  grounded?: boolean;
  /** in a dash burst: no planting (docs/02 §21) */
  dashing?: boolean;
}

/** The ground under a foot: CollisionWorld or any stand-in that casts a ray straight down. */
export type GroundWorld = Pick<CollisionWorld, 'raycast' | 'nx' | 'ny'>;

const _hip = new Vector3();
const _ankle = new Vector3();
const _target = new Vector3();
const _pole = new Vector3();
const _normal = new Vector3();
const _swingNormal = new Vector3();
const _footNormal = new Vector3();
const _q2 = new Quaternion();
const _q3 = new Quaternion();
const _down = new Vector3(0, -0.15, 0);
const _fwd = new Vector3();
const _up = new Vector3(0, 1, 0);
const _qi = new Quaternion();
const _ray = createRayHit();
const _to = new Vector3();

export class FootPlanter {
  /** bones it turns (the avatar restores them to the animation pose every frame) */
  readonly bones: Object3D[];
  /** how firmly each foot is held where it landed right now, L and R (0..1) */
  readonly planted = [0, 0];
  private readonly legs: (readonly [Object3D, Object3D, Object3D])[];
  private readonly plants: Plant[] = [0, 1].map(() => ({
    locked: false,
    x: 0,
    ground: 0,
    weight: new Spring(0, FEET.weightOmega),
    held: 0,
    swing: 0,
    swingX: NaN,
    push: 0,
    tx: 0,
    ty: 0,
    need: 0,
    reach: 0,
    holding: false,
    clipX: NaN,
  }));
  /** the ground normal under each planted foot */
  private readonly normals = [new Vector3(0, 1, 0), new Vector3(0, 1, 0)];
  /** how far (m, ≤ 0) the body has come down onto a slope under it */
  private readonly settle = new Spring(0, FEET.settleOmega);
  /** ankle height above the soles in the rest pose (m): how low a swinging foot may go over the ground */
  private readonly ankleHeight: number;
  /** where the player was last frame: a jump further than FEET.stale is a teleport or a respawn */
  private lastX = NaN;
  private lastY = NaN;
  /** the body's yaw last frame: it only changes while turning to face the other way */
  private lastYaw = NaN;
  /** 1 running forward, 0 backpedalling, eased (the swing clearance is for forward gaits) */
  private readonly forward = new Spring(1, 12);
  /** a facing turn on the spot: each foot steps from where it stood to its new spot (TURN); `first` steps first */
  private step: { t: number; from: [Vector3, Vector3]; first: number } | null = null;
  /** where each ankle ended up last frame (world) */
  private readonly lastAnkle = [new Vector3(), new Vector3()];
  private hasLast = false;

  constructor(private readonly inst: Pick<CharacterInstance, 'root' | 'bone'>) {
    const legs = (['L', 'R'] as const).map((s) => [inst.bone(`thigh_${s}`), inst.bone(`calf_${s}`), inst.bone(`foot_${s}`)] as const);
    this.legs = legs.every((l) => l.every((b) => b)) ? (legs as unknown as (readonly [Object3D, Object3D, Object3D])[]) : [];
    this.bones = this.legs.flat();
    inst.root.updateMatrixWorld(true);
    const foot = this.legs[0]?.[2];
    this.ankleHeight = foot ? inst.root.worldToLocal(foot.getWorldPosition(new Vector3())).y : 0;
  }

  /**
   * After the mixer and the body lean, before the aim layer. A foot entering its stance (from either end:
   * backpedalling runs the cycle backwards) is held along the ground where it stopped moving with the body, until
   * the stance ends.
   * - A held foot stands at the clip's own height (a heel-strike walk, a forefoot run) over the floor under it
   *   (steps and slopes, from `world`), turned onto its slope. A swinging foot keeps the clip's swing, lifted only to
   *   stay out of the ground. On a slope the whole body comes down onto the ground the capsule stands over.
   * - The hold fades in after touch-down and out before lift-off over FEET.fadeSeconds (≥ 4 frames), and stopping,
   *   dashing or reaching too far lets go over a few frames, so nothing moves in one frame.
   * - The hips dip as far as the most demanding held leg needs to keep the clip's knee bend, scaled by its hold, so
   *   they ease down and up with it. A target still out of reach (the dip is capped) is pulled in rather than
   *   straightening the leg: a knee never snaps straight.
   * - On an older rig crouched feet aren't held (W8's walk over the crouch pose barely moves them).
   * - `drop` (m) lowers the hips for a landing squash with the feet left on the ground: the knees take it.
   */
  update(
    p: PlantInput,
    yaw: number,
    loco: Pick<LocoLayer, 'phase' | 'gait' | 'stance' | 'touchDown' | 'plantable' | 'groundWeight'>,
    dt: number,
    world: GroundWorld | null = null,
    drop = 0,
    toYaw: number | null = null,
  ): void {
    if (!this.legs.length) return;
    const root = this.inst.root;
    const stance = loco.stance;
    const grounded = loco.groundWeight;
    if (root.parent) root.parent.getWorldPosition(_hip);
    else _hip.set(0, 0, 0);
    const px = _hip.x;
    const py = p.y ?? _hip.y;
    if (!(Math.hypot(px - this.lastX, py - this.lastY) < FEET.stale)) this.reset();
    this.lastX = px;
    this.lastY = py;
    // on a slope the capsule's rounded bottom (the player's y) rests above the ground under its middle: bring the body
    // down onto it, by no more than the slope accounts for (the floor below a step's edge isn't a slope)
    const onGround = (p.grounded ?? true) && grounded > 0;
    let settle = 0;
    if (world && onGround && world.raycast(px, py + 0.3, 0, -1, 0.3 + FEET.maxSettle, 0, _ray)) {
      const ny = world.ny[_ray.seg]!;
      if (ny > 0.5) settle = -Math.min(Math.max(0, py - _ray.y), defaultTuning.capsuleRadius * (1 / ny - 1));
    }
    settle = this.settle.step(settle * grounded, dt);
    const floor = py + settle;
    // measure from the settled body, lowered by a landing squash (`drop`, m), not yet dipped
    root.position.y = settle - drop;
    root.updateMatrixWorld(true);
    // small steps plant as firmly as big ones: what fades the planting out is stopping, not step size. On an older
    // rig crouched feet don't plant (`plantable`): W8's walk over the crouch pose sweeps the feet 5 cm a cycle, so a
    // crouch foot held down would be left a body length behind in one stance
    const turning = Math.abs(yaw - this.lastYaw) > 1e-4;
    this.lastYaw = yaw;
    this.forward.step(p.vx * Math.sin(yaw) < 0 ? 0 : 1, dt);
    // a facing turn on the spot steps the feet round (TURN): the one already toward the new facing stays down while
    // the other steps, then it steps too, each lifted, so neither slides
    const standing = (p.grounded ?? true) && grounded > 0.5 && Math.abs(p.vx) < TURN.standing && !p.dashing;
    if (this.step) {
      this.step.t += dt;
      if (this.step.t >= TURN.stepSeconds || !standing) {
        this.step = null;
        for (const plant of this.plants) plant.locked = false;
      }
    }
    if (!this.step && toYaw !== null && standing && this.hasLast && Math.abs(toYaw - yaw) > 0.3) {
      const toward = Math.sin(toYaw) >= 0 ? 1 : -1; // +x for a body turning to face right
      const first = (this.lastAnkle[0].x - this.lastAnkle[1].x) * toward > 0 ? 1 : 0;
      this.step = { t: 0, from: [this.lastAnkle[0].clone(), this.lastAnkle[1].clone()], first };
    }
    const step = this.step;
    const moving = grounded * smoothstep(0.02, 0.1, Math.abs(p.vx)) * loco.plantable * (p.dashing || turning ? 0 : 1);
    const strength = 1 - (1 - FEET.sprint[2]) * smoothstep(FEET.sprint[0], FEET.sprint[1], loco.gait.cadence);
    let dip = 0;
    this.legs.forEach(([thigh, calf, foot], k) => {
      const plant = this.plants[k]!;
      if (step) {
        // stepping round: nothing is held by the gait (the step places the feet; the plants start afresh after)
        plant.locked = false;
        plant.held = 0;
        plant.weight.x = plant.weight.v = 0;
        plant.swingX = NaN;
        return;
      }
      const s = stanceAt(loco.phase, loco.touchDown + k * 0.5, stance);
      foot.getWorldPosition(_ankle);
      thigh.getWorldPosition(_hip);
      const len = (calf.position.length() + foot.position.length()) * FEET.reach;
      // a bent leg (a crouch) may unbend to reach; one the clip has near straight (a walk, a run) keeps the clip's
      // bend and the hips come down instead (a leg locked straight looks stiff, and near straight a millimetre of
      // reach is degrees of knee)
      plant.reach = Math.min(len, Math.max(_hip.distanceTo(_ankle), len * FEET.unbend));
      if (p.dashing || turning) {
        // a dash moves the body ~25 cm a frame, and turning to face the other way swings the feet round the body:
        // a foot held through either would be left behind, so it is let go at once, while it is still near the clip's
        plant.weight.x = plant.weight.v = 0;
      }
      // a foot on the floor near its stance is held whatever the phase says: one landing early (a sprint's foot comes
      // down a frame before its stance) or lifting late (a walk's long stance through the walk-run blend) would
      // otherwise slide along the floor (docs/design/character-feel-research.md §3.4)
      const floorAt = plant.locked ? plant.ground : Number.isNaN(plant.swingX) ? floor : plant.swing;
      const contact = _ankle.y + drop - (floorAt + this.ankleHeight) < FEET.contact;
      // (backpedalling runs the cycle backwards: the foot comes down at the stance's far end)
      const [before, after] = p.vx * Math.sin(yaw) < 0 ? [FEET.late, FEET.early] : [FEET.early, FEET.late];
      const near = stanceAt(loco.phase, loco.touchDown + k * 0.5 - before, stance + before + after) >= 0;
      // (on flat ground only: on a slope or a step's edge the floor under a foot isn't the floor the clip stands it
      // on, and the stance's own timing holds it better)
      const flat = Math.abs(floorAt - floor) < 0.02 && this.normals[k]!.y > 0.97;
      // (past its stance, a held foot is kept only while the leg still reaches it comfortably: a foot left far behind
      // would pull the hips down after it)
      const comfortable = !plant.locked || Math.hypot(plant.x - _hip.x, _ankle.z - _hip.z) / len < FEET.release[0] * FEET.lateReach;
      const touching = contact && near && flat && moving > 0.5 && (s >= 0 || comfortable);
      const inHold = s >= 0 || touching;
      let target = 0;
      if (inHold) {
        // a foot is put down where it stops moving along with the body: while the clip still carries it forward
        // above the floor (a cycle blending in from a standstill) the plant goes with it; on the floor it stays
        const fresh = !plant.holding || !plant.locked;
        const ahead = (!contact || plant.weight.x < 0.9) && s >= 0 && s < 0.5 && (_ankle.x - plant.x) * Math.sign(p.vx) > 0;
        if (fresh || ahead || Math.abs(plant.x - _ankle.x) > FEET.stale) {
          plant.locked = true;
          plant.x = _ankle.x;
          plant.ground = this.footGround(world, _ankle.x, floor, this.normals[k]!);
        }
        // held, a foot stands at the clip's height over the floor where it landed (world-fixed: the hips dip to it,
        // and a landing squash only bends the knees), never in it (a leaning run's front foot reaches below the floor)
        plant.ty = Math.max(_ankle.y + drop + (plant.ground - floor), plant.ground + this.ankleHeight - FEET.soft / 2);
        // the dip this leg needs to reach where it landed. A foot too far ahead or behind (flat), or left below by a
        // body climbing a step (the dip runs out), lets go rather than being reached for
        const flat = Math.hypot(plant.x - _hip.x, _ankle.z - _hip.z);
        plant.need = _hip.y - plant.ty - Math.sqrt(Math.max(0, plant.reach * plant.reach - flat * flat));
        const reachable = (1 - smoothstep(FEET.release[0], FEET.release[1], flat / len)) * (1 - smoothstep(0, FEET.overreach, plant.need - FEET.maxDip));
        const weight = plant.weight.step(moving * strength * reachable, dt);
        // on the floor, held at once (a foot stops where it lands; the lock is where it is); the stance's ends off the
        // floor fade as before
        const fade = touching ? 1 : plantWeight(s, stance, loco.gait.cadence);
        target = weight > 1e-3 ? Math.min(1, weight) * fade : 0;
      } else {
        // letting go, the foot follows the clip's lift (it is off the floor by now) and its swing: the gap to where the
        // clip has it closes at the let-go's pace, not at the swing's (a swing is fast; a held foot left behind it
        // would catch up in a jump)
        plant.ty = _ankle.y + drop + ((plant.locked ? plant.ground : floor) - floor);
        if (plant.locked && Number.isFinite(plant.clipX)) plant.x += _ankle.x - plant.clipX;
        plant.weight.step(moving * strength, dt);
      }
      plant.clipX = _ankle.x;
      plant.holding = inHold;
      // a hold comes in at once and goes no faster than over FEET.letGo (from full; a facing turn, which swings the feet
      // round the body, twice as fast): the foot moves from where it stood to where the clip has it over a few frames,
      // in the air. A dash lets go at once
      // (a wide gap closes at FEET.letGoSpeed at most, however short the let-go, within FEET.letGoMax)
      const gap = Math.abs(plant.x - _ankle.x);
      const rate = Math.max(1 / FEET.letGoMax, Math.min(1 / (turning ? FEET.letGo / 2 : FEET.letGo), FEET.letGoSpeed / Math.max(gap, 1e-3)));
      plant.held = target >= plant.held || p.dashing ? target : Math.max(target, plant.held - dt * rate);
      if (plant.held <= 1e-3) {
        plant.held = 0;
        if (!inHold) plant.locked = false;
      }
      const held = plant.held;
      plant.tx = _ankle.x + (plant.x - _ankle.x) * held;
      // the dip, scaled by the hold (a swinging foot over lower ground doesn't pull the hips down). As the hold fades
      // the target eases back to the clip's ankle, which needs no dip; on the way it never needs more than this
      // share of the full dip (the need is convex in the hold)
      if (held > 0) dip = Math.max(dip, held * Math.min(FEET.maxDip, plant.need));
      // the floor under a swinging foot, eased up a step's edge rather than popping (read on the ground only: in
      // the air there's no floor under the feet, and the first reading after landing is taken as it is)
      if (onGround && world) {
        const g = this.groundUnder(world, plant.tx, floor, _swingNormal);
        const moved = Math.abs(plant.tx - plant.swingX);
        if (!(moved < FEET.stale)) plant.swing = g;
        // as fast as the foot moves over any walkable slope, so a step's edge takes a few frames
        else plant.swing += Math.sign(g - plant.swing) * Math.min(Math.abs(g - plant.swing), moved * FEET.climb[0] + dt * FEET.climb[1]);
        plant.swingX = plant.tx;
      } else plant.swingX = NaN;
    });
    dip = Math.max(0, dip);
    if (step) dip = TURN.dip * Math.sin(Math.PI * Math.min(1, step.t / TURN.stepSeconds));
    root.position.y = settle - drop - dip;
    root.updateMatrixWorld(true);
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.legs.forEach(([thigh, calf, foot], k) => {
      const plant = this.plants[k]!;
      const held = (this.planted[k] = plant.held);
      foot.getWorldPosition(_ankle);
      // free, a foot goes where the clip has it on the dipped body, only kept out of the ground (up a slope, over a
      // step): lifted quickly, let down gently (off a step's edge); held, it stays on its floor
      // (the clip's ankle on the dipped body: a landing squash doesn't take the feet down with the hips)
      const clip = _ankle.y + drop;
      const push = Number.isNaN(plant.swingX) ? 0 : softPlus(plant.swing + this.ankleHeight - clip - FEET.soft / 2, FEET.soft);
      plant.push = Math.min(FEET.maxLift, push >= plant.push ? Math.min(push, plant.push + dt * FEET.liftRate) : Math.max(push, plant.push - dt * FEET.letDown));
      let free = clip + plant.push;
      // a swinging foot clears the floor by FEET.clearance at mid-swing: a blend of two cycles (walk into run) can
      // otherwise carry it forward along the floor
      const u = (((loco.phase - (loco.touchDown + k * 0.5)) % 1) + 1) % 1;
      if (u >= stance && !step) {
        // (eased in with the swing and out with any hold still letting go, so the lift never jumps; not backpedalling,
        // where the cycle runs backwards and the clip's own feet come down where the lift would hold them up)
        const lift = FEET.clearance * Math.sin((Math.PI * (u - stance)) / (1 - stance)) * (1 - held) ** 3 * Math.min(1, moving) * this.forward.x;
        free = Math.max(free, (Number.isNaN(plant.swingX) ? floor : plant.swing) + this.ankleHeight + lift);
      }      _target.set(plant.tx, free + (plant.ty - free) * held, _ankle.z);
      if (step) {
        // this foot's window in the step: the first foot early, the second late, overlapping a little
        const span = TURN.stepSeconds;
        const [a, b] = k === step.first ? [0, 0.5 * span] : [0.3 * span, span];
        const u = Math.min(1, Math.max(0, (step.t - a) / (b - a)));
        // its new spot: where the clip has it now, turned on round the pivot to the turn's end, on the floor
        root.parent!.getWorldPosition(_pole);
        _to.copy(_ankle).sub(_pole).applyAxisAngle(_up, (toYaw ?? yaw) - yaw).add(_pole);
        _to.y = Math.max(clip, floor + this.ankleHeight);
        _target.copy(step.from[k]!).lerp(_to, smootherstep(u));
        _target.y += TURN.lift * Math.sin(Math.PI * u);
        this.planted[k] = u <= 0 || u >= 1 ? 1 : 0;
      }
      // nothing to do where the target is where the clip has the ankle (a swing over flat ground)
      if (held <= 0 && !step && _target.distanceToSquared(_ankle) < 1e-8) return;
      // out of reach (the dip is capped): pull the target in instead of straightening the leg
      thigh.getWorldPosition(_hip);
      const d = _target.distanceTo(_hip);
      if (d > plant.reach) _target.sub(_hip).multiplyScalar(plant.reach / d).add(_hip);
      foot.getWorldQuaternion(_q3);
      // the knee bends forward
      solveTwoBone(thigh, calf, foot, _target, _pole.copy(_hip).addScaledVector(_fwd, 0.6).add(_down));
      // the foot keeps the clip's turn (heel strike, roll, toe-off); a held one tilts onto the slope under it
      _q2.setFromUnitVectors(_up, this.normals[k]!).slerp(_qi, 1 - held).multiply(_q3);
      foot.parent!.getWorldQuaternion(_q3).invert();
      foot.quaternion.copy(_q3.multiply(_q2));
      thigh.updateMatrixWorld(true);
    });
    this.legs.forEach(([, , foot], k) => foot.getWorldPosition(this.lastAnkle[k]!));
    this.hasLast = true;
  }

  /** Nothing held, nothing settled or lifted: a fresh start (a teleport, a respawn; review L4, L5). */
  reset(): void {
    this.step = null;
    this.hasLast = false;
    for (const plant of this.plants) {
      plant.locked = plant.holding = false;
      plant.clipX = NaN;
      plant.held = plant.weight.x = plant.weight.v = plant.push = 0;
      plant.swingX = NaN;
    }
    this.settle.x = this.settle.v = 0;
  }

  /**
   * Height of the floor a foot put down at `x` stands on: the floor under its ankle, unless its heel or toe reaches
   * over a step's edge onto higher floor (a slope rising under the sole doesn't count: the foot tilts onto it);
   * writes that floor's normal.
   */
  private footGround(world: GroundWorld | null, x: number, floor: number, normal: Vector3): number {
    let best = this.groundUnder(world, x, floor, normal);
    // the slope under the ankle carried along the sole
    const rise = normal.y > 0.3 ? -normal.x / normal.y : 0;
    for (const dx of [-FEET.sole, FEET.sole]) {
      const g = this.groundUnder(world, x + dx, floor, _footNormal) - rise * dx;
      if (g > best + 0.01) {
        best = g;
        normal.copy(_footNormal);
      }
    }
    return best;
  }

  /** Height of the floor under `x` near `floor` (the player's feet height); writes the floor's normal. */
  private groundUnder(world: GroundWorld | null, x: number, floor: number, normal: Vector3): number {
    normal.set(0, 1, 0);
    if (!world || !world.raycast(x, floor + 0.6, 0, -1, 1.4, 0, _ray)) return floor;
    normal.set(world.nx[_ray.seg]!, world.ny[_ray.seg]!, 0).normalize();
    // keep the foot flat on gentle ground, tilt it up to 35° on steeper slopes
    if (normal.y < Math.cos((35 * Math.PI) / 180)) normal.lerp(_normal.set(0, 1, 0), 0.4).normalize();
    return _ray.y;
  }
}
