import { AnimationClip, AnimationMixer, Bone, Group, QuaternionKeyframeTrack, Quaternion, VectorKeyframeTrack } from 'three';
import { describe, expect, it } from 'vitest';
import {
  FALL_DELAY,
  FEET,
  GAIT,
  Locomotion,
  RUN_ENTER,
  Spring,
  TURN_RATE,
  TurnClock,
  aimElevation,
  deltaClip,
  facingOf,
  facingYaw,
  gaitFor,
  measureCycle,
  planeStride,
  plantWeight,
  softPlus,
  restPoses,
  stanceAt,
  stepYaw,
  type Cycle,
  type LocoInput,
} from '../locomotion';

const ground = (vx = 0, crouched = false): LocoInput => ({ grounded: true, crouched, jetting: false, vx, vy: 0 });
const air = (vy: number, jetting = false): LocoInput => ({ grounded: false, crouched: false, jetting, vx: 0, vy });

/** the measured W8 cycles (rookie_anims.glb after clip repair) */
const WALK: Cycle = { sweep: 0.286, leftFront: 0.02 };
const RUN: Cycle = { sweep: 0.408, leftFront: 0 };

describe('locomotion state machine', () => {
  it('walks, then runs, above the enter speed and stops below the exit speed (no flicker in between)', () => {
    const l = new Locomotion();
    expect(l.update(ground(0.5), 1 / 60)).toBe('idle');
    expect(l.update(ground(RUN_ENTER + 0.1), 1 / 60)).toBe('walk');
    expect(l.update(ground(5), 1 / 60)).toBe('run');
    expect(l.update(ground(0.4), 1 / 60)).toBe('walk');
    expect(l.update(ground(-0.4), 1 / 60)).toBe('walk');
    expect(l.update(ground(0.2), 1 / 60)).toBe('idle');
    expect(l.update(ground(3, true), 1 / 60)).toBe('crouch');
  });

  it('jets while thrusting upward, hovers when the climb stops', () => {
    const l = new Locomotion();
    expect(l.update(air(0.5, true), 1 / 60)).toBe('hover');
    expect(l.update(air(1.5, true), 1 / 60)).toBe('jet');
    expect(l.update(air(0.3, true), 1 / 60)).toBe('jet');
    expect(l.update(air(-0.2, true), 1 / 60)).toBe('hover');
    expect(l.update(air(-1), 1 / 60)).toBe('fall');
  });

  it('waits FALL_DELAY before falling off a step, unless dropping fast', () => {
    const l = new Locomotion();
    l.update(ground(2), 1 / 60);
    expect(l.update(air(-0.5), FALL_DELAY / 2)).toBe('run');
    expect(l.update(air(-0.5), FALL_DELAY / 2)).toBe('fall');
    const fast = new Locomotion();
    expect(fast.update(air(-3), 1 / 60)).toBe('fall');
    expect(fast.update(ground(0), 1 / 60)).toBe('idle');
  });
});

describe('gait: the 1D speed blend', () => {
  const speeds = [0, 0.05, 0.2, 0.4, 0.8, 1.2, 1.6, 2.2, 2.8, 3.5, 5];

  it('stands still at 0, takes small careful steps at low speed, full steps by ~0.6 m/s', () => {
    expect(gaitFor(0, WALK, RUN).amplitude).toBe(0);
    const amps = speeds.map((v) => gaitFor(v, WALK, RUN).amplitude);
    for (let i = 1; i < amps.length; i++) expect(amps[i]).toBeGreaterThanOrEqual(amps[i - 1]!);
    expect(gaitFor(0.1, WALK, RUN).amplitude).toBeLessThan(0.25);
    expect(gaitFor(0.7, WALK, RUN).amplitude).toBe(1);
  });

  it('never steps slower than minCadence while moving (no timeScale near 0), and never frantically', () => {
    for (const v of speeds.slice(1)) {
      const g = gaitFor(v, WALK, RUN);
      expect(g.cadence, `${v} m/s`).toBeGreaterThanOrEqual(GAIT.minCadence);
      expect(g.cadence, `${v} m/s`).toBeLessThanOrEqual(GAIT.maxCadence);
    }
  });

  it('cross-blends walk → run between runFrom and runTo, and stretches the stride at speed', () => {
    expect(gaitFor(1, WALK, RUN).run).toBe(0);
    expect(gaitFor(2, WALK, RUN).run).toBeGreaterThan(0);
    expect(gaitFor(2, WALK, RUN).run).toBeLessThan(1);
    expect(gaitFor(3, WALK, RUN).run).toBe(1);
    expect(gaitFor(1, WALK, RUN).warp).toBe(1);
    expect(gaitFor(5, WALK, RUN).warp).toBeGreaterThan(1.3);
    expect(gaitFor(5, WALK, RUN).warp).toBeLessThanOrEqual(GAIT.maxWarp);
    expect(gaitFor(2.2, WALK, RUN, true).run).toBe(0); // crouch walks
  });

  it('matches foot sweep to ground speed: amplitude × stride × cadence = speed at every speed', () => {
    for (const v of speeds.slice(1)) {
      const g = gaitFor(v, WALK, RUN);
      expect(g.amplitude * g.stride * g.cadence, `${v} m/s`).toBeCloseTo(v, 6);
    }
  });

  it('a clip that barely moves its feet borrows a plausible stride instead of a frantic cadence', () => {
    const shuffle: Cycle = { sweep: 0.01, leftFront: 0 };
    expect(planeStride(shuffle)).toBeCloseTo(2 * GAIT.fallbackSweep * GAIT.planeShare, 9);
  });
});

/** thigh + calf + foot per side under a pelvis, and a clip swinging the left thigh by ±30° */
function legRig() {
  const root = new Group();
  const bone = (name: string, parent: Bone | Group, y: number, x = 0) => {
    const b = Object.assign(new Bone(), { name });
    b.position.set(x, y, 0);
    parent.add(b);
    return b;
  };
  const pelvis = bone('pelvis', root, 0.47);
  for (const [side, x] of [['L', 0.14], ['R', -0.14]] as const) bone(`foot_${side}`, bone(`calf_${side}`, bone(`thigh_${side}`, pelvis, 0, x), -0.17), -0.17);
  const q = (deg: number) => new Quaternion().setFromAxisAngle({ x: 1, y: 0, z: 0 } as never, (deg * Math.PI) / 180).toArray();
  const swing = new AnimationClip('walk', 1, [
    new QuaternionKeyframeTrack('thigh_L.quaternion', [0, 0.25, 0.5, 0.75, 1], [...q(-30), ...q(0), ...q(30), ...q(0), ...q(-30)]),
    new QuaternionKeyframeTrack('thigh_R.quaternion', [0, 0.25, 0.5, 0.75, 1], [...q(30), ...q(0), ...q(-30), ...q(0), ...q(30)]),
    new VectorKeyframeTrack('pelvis.position', [0, 0.5, 1], [0, 0.47, 0, 0, 0.49, 0, 0, 0.47, 0]),
  ]);
  return { root, swing };
}

describe('clip measurement and additive deltas', () => {
  it('measures how far a cycle sweeps the feet and when the left foot is in front, then puts the skeleton back', () => {
    const { root, swing } = legRig();
    const before = root.getObjectByName('thigh_L')!.quaternion.clone();
    const c = measureCycle(swing, root);
    // ±30° on a 0.34 m leg: the ankle travels 2·0.34·sin 30° along z
    expect(c.sweep).toBeCloseTo(0.34, 2);
    // this rig's thighs hang along −Y unrotated, so −30° about +X puts the left ankle in front (+Z) at phase 0
    expect(c.leftFront).toBeCloseTo(0, 1);
    expect(root.getObjectByName('thigh_L')!.quaternion.equals(before)).toBe(true);
  });

  it('a delta clip is identity at the reference pose and replays the clip on top of it (unkeyed bones: rest pose)', () => {
    const { root, swing } = legRig();
    const rest = restPoses(root);
    const reference = new AnimationClip('idle', 1, [new VectorKeyframeTrack('pelvis.position', [0], [0, 0.47, 0])]);
    const delta = deltaClip(swing, reference, (b) => rest.get(b));
    // no reference track for the thighs: relative to the rest pose (identity here), so the delta equals the swing
    const thigh = delta.tracks.find((t) => t.name === 'thigh_L.quaternion')!;
    Array.from(thigh.values.slice(0, 4)).forEach((v, i) => expect(v).toBeCloseTo(swing.tracks[0]!.values[i]!, 6));
    // the pelvis height becomes an offset from the reference
    const pelvis = delta.tracks.find((t) => t.name === 'pelvis.position')!;
    expect(pelvis.values[4]).toBeCloseTo(0.02, 6);
    // on a base holding the reference pose, the additive layer reproduces the clip
    const mixer = new AnimationMixer(root);
    mixer.clipAction(reference).play();
    const add = mixer.clipAction(delta).play();
    add.time = 0.5;
    add.timeScale = 0;
    mixer.update(0);
    expect(root.getObjectByName('pelvis')!.position.y).toBeCloseTo(0.49, 6);
    expect(root.getObjectByName('thigh_L')!.quaternion.angleTo(new Quaternion().fromArray(swing.tracks[0]!.values, 8))).toBeLessThan(1e-3); // float32 keys
  });

  it('a critically damped spring settles without overshoot', () => {
    const s = new Spring(0, 12);
    let max = 0;
    for (let i = 0; i < 120; i++) max = Math.max(max, s.step(1, 1 / 60));
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    expect(s.x).toBeCloseTo(1, 4);
  });
});

describe('facing and aim', () => {
  it('faces the side the sim puts the shoulder on (cos(aim) ≥ 0 → right)', () => {
    expect(facingOf(0)).toBe(1);
    expect(facingOf(Math.PI / 2 - 0.01)).toBe(1);
    expect(facingOf(Math.PI / 2 + 0.01)).toBe(-1);
    expect(facingOf(-Math.PI + 0.1)).toBe(-1);
  });

  it('turns (never mirrors) through facing the camera at 180° per 120 ms', () => {
    let yaw = facingYaw(1);
    expect(yaw).toBeCloseTo((60 * Math.PI) / 180, 9);
    const target = facingYaw(-1);
    let t = 0;
    let passedCamera = false;
    while (yaw !== target) {
      yaw = stepYaw(yaw, target, 1 / 240);
      t += 1 / 240;
      if (Math.abs(yaw) < 0.05) passedCamera = true;
    }
    expect(passedCamera).toBe(true);
    expect(t).toBeCloseTo((2 * facingYaw(1)) / TURN_RATE, 2); // 120° → 80 ms
  });

  it('TurnClock eases the 120° turn over 0.1 s through facing the camera, starting and stopping at rest', () => {
    const turn = new TurnClock();
    turn.update(facingYaw(1), 1 / 60);
    const yaws: number[] = [];
    for (let i = 0; i < 10; i++) yaws.push(turn.update(facingYaw(-1), 1 / 60));
    expect(yaws[5]).toBeCloseTo(facingYaw(-1), 9); // 6 frames
    expect(yaws.some((y) => Math.abs(y) < 0.05 || (y > 0 && yaws[yaws.indexOf(y) + 1]! < 0))).toBe(true);
    const steps = [facingYaw(1), ...yaws].slice(1).map((y, i) => Math.abs(y - [facingYaw(1), ...yaws][i]!));
    expect(steps[0]! * (180 / Math.PI)).toBeLessThan(5); // eases in
    expect(steps[5]! * (180 / Math.PI)).toBeLessThan(5); // and out
    expect(Math.max(...steps) * (180 / Math.PI)).toBeLessThan(40);
    expect(turn.turning).toBe(false);
    // turning back mid-turn starts from where the body is
    turn.update(facingYaw(1), 1 / 60);
    const mid = turn.update(facingYaw(1), 1 / 60);
    turn.update(facingYaw(-1), 1 / 60);
    expect(Math.abs(turn.yaw! - mid)).toBeLessThan(0.2);
  });

  it('measures elevation on the facing side', () => {
    expect(aimElevation(0.3)).toBeCloseTo(0.3, 9);
    expect(aimElevation(Math.PI - 0.3)).toBeCloseTo(0.3, 9);
    expect(aimElevation(-Math.PI + 0.2)).toBeCloseTo(-0.2, 9);
  });
});

describe('planted feet: stance windows', () => {
  it('softPlus is max(0, x) with its corner rounded off (no kink for what follows it)', () => {
    expect(softPlus(-0.05, 0.02)).toBe(0);
    expect(softPlus(0.05, 0.02)).toBe(0.05);
    expect(softPlus(0, 0.02)).toBeCloseTo(0.005, 9);
    // continuous with a continuous slope at both ends of the rounding
    for (const edge of [-0.02, 0.02]) {
      const h = 1e-6;
      expect(Math.abs(softPlus(edge + h, 0.02) - softPlus(edge - h, 0.02))).toBeLessThan(3e-6);
      const slope = (x: number) => (softPlus(x + h, 0.02) - softPlus(x - h, 0.02)) / (2 * h);
      expect(Math.abs(slope(edge - 1e-4) - slope(edge + 1e-4))).toBeLessThan(0.02);
    }
  });

  it('each foot is down for a stance share of the cycle, half a cycle apart, fading in and out', () => {
    expect(stanceAt(0.1, 0, 0.4)).toBeCloseTo(0.25, 9);
    expect(stanceAt(0.5, 0, 0.4)).toBe(-1);
    expect(stanceAt(0.6, 0.5, 0.4)).toBeCloseTo(0.25, 9);
    expect(stanceAt(0.95, 0.9, 0.4)).toBeCloseTo(0.125, 9); // wraps round
    expect(plantWeight(-1, 0.4, 2)).toBe(0);
    expect(plantWeight(0, 0.4, 2)).toBe(0);
    expect(plantWeight(0.5, 0.4, 2)).toBe(1);
    expect(plantWeight(1, 0.4, 2)).toBe(0);
    // the fades take FEET.fadeSeconds whatever the cadence (4 frames at 60 fps), up to half the stance
    expect(FEET.fadeSeconds).toBeGreaterThanOrEqual(4 / 60);
    const stanceSeconds = (cadence: number) => 0.4 / cadence;
    for (const cadence of [1.25, 2, 2.5]) {
      const fadeShare = FEET.fadeSeconds / stanceSeconds(cadence);
      expect(fadeShare).toBeLessThan(0.5);
      expect(plantWeight(fadeShare * 0.999, 0.4, cadence)).toBeLessThan(1);
      expect(plantWeight(fadeShare * 1.001, 0.4, cadence)).toBe(1);
    }
    expect(plantWeight(0.5, 0.3, 6)).toBe(1); // a sprint's short stance still peaks, fading in and out over half each
  });
});
