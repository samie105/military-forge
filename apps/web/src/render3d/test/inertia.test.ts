import { Object3D, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { INERTIA, Inertializer, WorldEase, decay, fromRotationVector, halflifeRate, quickestHalflife, rotationVector } from '../inertia';

const DEG = Math.PI / 180;
const angle = (a: Quaternion, b: Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
const about = (axis: Vector3, rad: number) => new Quaternion().setFromAxisAngle(axis.clone().normalize(), rad);

describe('the critically damped spring (Holden)', () => {
  it('decays an offset from rest as x0 (1 + y t) e^(−y t), exactly for any step', () => {
    const y = halflifeRate(0.08);
    for (const steps of [1, 7, 60]) {
      const x = new Float64Array([1, -2, 0.5]);
      const v = new Float64Array(3);
      for (let i = 0; i < steps; i++) decay(x, v, 0, y, 0.3 / steps);
      const k = (1 + y * 0.3) * Math.exp(-y * 0.3);
      expect(x[0]).toBeCloseTo(k, 9);
      expect(x[1]).toBeCloseTo(-2 * k, 9);
      expect(x[2]).toBeCloseTo(0.5 * k, 9);
    }
  });

  it('never overshoots from rest, and is mostly gone within 0.3 s at the default half-life', () => {
    const y = halflifeRate(INERTIA.halflife);
    const x = new Float64Array([1, 0, 0]);
    const v = new Float64Array(3);
    for (let i = 0; i < 18; i++) {
      decay(x, v, 0, y, 1 / 60);
      expect(x[0]).toBeGreaterThan(0);
    }
    expect(x[0]).toBeLessThan(0.05);
  });

  it('turns a 150° jump at no more than 16° a frame at 60 Hz (the fastest it turns is x0 · y / e)', () => {
    expect((150 * halflifeRate(INERTIA.halflife)) / Math.E / 60).toBeLessThan(16);
  });
});

describe('rotation vectors', () => {
  it('round-trip, the short way round', () => {
    for (const [axis, rad] of [
      [new Vector3(1, 0, 0), 0.3],
      [new Vector3(0.2, 1, -0.4), 2.9],
      [new Vector3(0, 0, 1), 1e-7],
    ] as const) {
      const q = about(axis, rad);
      const v = rotationVector(q, new Vector3());
      expect(v.length()).toBeCloseTo(rad, 6);
      expect(angle(fromRotationVector(v.x, v.y, v.z, new Quaternion()), q)).toBeLessThan(1e-6);
      // the same rotation with its sign flipped is the same vector
      const n = q.clone().set(-q.x, -q.y, -q.z, -q.w);
      expect(rotationVector(n, new Vector3()).distanceTo(v)).toBeLessThan(1e-9);
    }
  });
});

describe('Inertializer', () => {
  /** A bone whose pose is set each frame, run through the inertializer: its shown rotation per frame. */
  function run(poses: (i: number) => Quaternion, frames: number, triggers: number[]): Quaternion[] {
    const bone = new Object3D();
    const ease = new Inertializer([bone]);
    const shown: Quaternion[] = [];
    for (let i = 0; i < frames; i++) {
      bone.quaternion.copy(poses(i));
      if (triggers.includes(i)) ease.trigger();
      ease.apply(1 / 60);
      ease.record();
      shown.push(bone.quaternion.clone());
    }
    return shown;
  }
  const Y = new Vector3(0, 1, 0);

  it('a jump eases out from where the bone was: no frame turns more than 16°, gone within 0.3 s', () => {
    const before = about(Y, 0);
    const after = about(Y, 150 * DEG);
    const shown = run((i) => (i < 10 ? before : after), 40, [10]);
    for (let i = 1; i < shown.length; i++) expect(angle(shown[i]!, shown[i - 1]!) / DEG).toBeLessThan(16);
    expect(angle(shown[10]!, before) / DEG).toBeLessThan(8); // the change starts from the old pose
    expect(angle(shown[10 + 18]!, after) / DEG).toBeLessThan(8);
    expect(angle(shown[39]!, after) / DEG).toBeLessThan(0.5); // and lands on the new one
  });

  it('a jump with no trigger shows at once (only the changes the avatar names are eased)', () => {
    const shown = run((i) => (i < 10 ? about(Y, 0) : about(Y, 1)), 12, []);
    expect(angle(shown[10]!, about(Y, 1))).toBeLessThan(1e-9);
  });

  it('back-to-back changes chain from wherever the bone is', () => {
    const a = about(Y, 0);
    const b = about(Y, 120 * DEG);
    const c = about(new Vector3(1, 0, 0), -90 * DEG);
    const shown = run((i) => (i < 10 ? a : i < 14 ? b : c), 50, [10, 14]);
    for (let i = 1; i < shown.length; i++) expect(angle(shown[i]!, shown[i - 1]!) / DEG).toBeLessThan(16);
    expect(angle(shown[49]!, c)).toBeLessThan(1e-3);
  });

  it('follows a moving pose under the offset (the new pose keeps playing while the change eases out)', () => {
    const shown = run((i) => about(Y, (i < 10 ? 0 : 1.5) + i * 0.02), 60, [10]);
    expect(angle(shown[59]!, about(Y, 1.5 + 59 * 0.02))).toBeLessThan(1e-3);
  });

  it('reset and pin drop the offset; a long frame (a stalled tab) lets everything go', () => {
    const bone = new Object3D();
    const ease = new Inertializer([bone]);
    ease.record();
    bone.quaternion.copy(about(Y, 2));
    ease.trigger();
    ease.apply(1 / 60);
    expect(ease.active).toBe(1);
    expect(ease.offsetOf(0)).toBeGreaterThan(1.5);
    ease.pin(0);
    expect(ease.active).toBe(0);
    ease.trigger();
    ease.apply(1);
    expect(ease.active).toBe(0);
  });
});

describe('WorldEase (an aimed gun’s hand)', () => {
  it('eases a big change in under half a second and a small one faster, under 13° a frame (16° for the biggest)', () => {
    expect(quickestHalflife(150 * DEG)).toBeLessThanOrEqual(INERTIA.halflife);
    expect(quickestHalflife(10 * DEG)).toBe(INERTIA.minHalflife);
    for (const deg of [10, 60, 150]) {
      const hand = new WorldEase();
      const from = about(new Vector3(0, 0, 1), 0);
      const to = about(new Vector3(0, 0, 1), deg * DEG);
      hand.apply(from.clone(), 1 / 60);
      hand.trigger();
      let last = from.clone();
      let settled = -1;
      for (let i = 0; i < 40; i++) {
        const q = hand.apply(to.clone(), 1 / 60);
        expect(angle(q, last) / DEG).toBeLessThan(deg > 100 ? 16 : 13.5);
        if (settled < 0 && angle(q, to) < 0.5 * DEG) settled = i;
        last = q;
      }
      expect(settled / 60, `${deg}°`).toBeLessThan(deg > 100 ? 0.5 : 0.25);
    }
  });
});
