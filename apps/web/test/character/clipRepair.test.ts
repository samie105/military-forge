import { AnimationClip, InterpolateLinear, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import { describe, expect, it } from 'vitest';
import { autoClampedSlopes, repairClip, sameHemisphere } from '../../src/character/clipRepair';

/** A track as GLTFLoader builds CUBICSPLINE: (in-tangent, value, out-tangent) per key, flagged on its factory. */
function cubic<T extends QuaternionKeyframeTrack | VectorKeyframeTrack>(track: T): T {
  // the repair reads key values out of the triples itself; the factory only has to carry the flag
  const factory = Object.assign(() => null, { isInterpolantFactoryMethodGLTFCubicSpline: true });
  (track as unknown as { createInterpolant: unknown }).createInterpolant = factory;
  return track;
}

describe('clip repair', () => {
  it('auto-clamped slopes: flat at a component extreme and at the ends, Catmull-Rom between', () => {
    const slopes = autoClampedSlopes([0, 1, 2, 3], [0, 1, 3, 2], 1, 3);
    expect(Array.from(slopes)).toEqual([0, 1.5, 0, 0]);
  });

  it('wraps round a loop (the last key repeats the first)', () => {
    const slopes = autoClampedSlopes([0, 1, 2, 3, 4], [0, 1, 0, -1, 0], 1, 4);
    expect(slopes[0]).toBeCloseTo(1, 9); // (1 − (−1)) / 2 across the wrap
    expect(slopes[4]).toBeCloseTo(1, 9);
  });

  it("W8's identity-quaternion tangents no longer wobble a held bone, and the result is a dense linear track", () => {
    const id = [0, 0, 0, 1];
    const bogus = [1, 0, 0, 0]; // what the export wrote as a "tangent"
    const values = [0, 1, 2].flatMap(() => [...bogus, ...id, ...bogus]);
    const track = cubic(new QuaternionKeyframeTrack('pelvis.quaternion', [0, 1, 2], values));
    const fixed = repairClip(new AnimationClip('idle', 2, [track]), 30);
    const out = fixed.tracks[0]!;
    expect(out.getInterpolation()).toBe(InterpolateLinear);
    expect(out.times.length).toBe(61);
    const q = new Quaternion();
    for (let i = 0; i < out.times.length; i++) expect(q.fromArray(out.values, i * 4).angleTo(new Quaternion())).toBeLessThan(1e-6);
  });

  it('keeps the keyed values exactly and moves smoothly between them', () => {
    const v = (y: number) => [0, 0, 0, 0, y, 0, 0, 0, 0];
    const track = cubic(new VectorKeyframeTrack('pelvis.position', [0, 0.5, 1], [...v(0.47), ...v(0.5), ...v(0.47)]));
    const fixed = repairClip(new AnimationClip('walk', 1, [track]), 30).tracks[0]!;
    const y = (i: number) => fixed.values[i * 3 + 1]!;
    expect(y(0)).toBeCloseTo(0.47, 6);
    expect(y(15)).toBeCloseTo(0.5, 6);
    expect(y(30)).toBeCloseTo(0.47, 6);
    for (let i = 1; i <= 15; i++) expect(y(i)).toBeGreaterThanOrEqual(y(i - 1) - 1e-7);
  });

  it('keeps quaternion keys in one hemisphere, so a sign flip between keys never spins the bone the long way', () => {
    const a = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.2);
    const b = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    const keys = [...a.toArray(), ...b.toArray().map((v) => -v)]; // b stored as −b
    sameHemisphere(keys);
    expect(new Quaternion().fromArray(keys, 4).dot(a)).toBeGreaterThan(0);
    // through the repair: half way between the keys is half way between the angles, not a near-full turn
    const track = cubic(new QuaternionKeyframeTrack('forearm_R.quaternion', [0, 1], [...[0, 0, 0, 0], ...a.toArray(), ...[0, 0, 0, 0], ...[0, 0, 0, 0], ...b.toArray().map((v) => -v), ...[0, 0, 0, 0]]));
    const out = repairClip(new AnimationClip('melee', 1, [track]), 30).tracks[0]!;
    const mid = new Quaternion().fromArray(out.values, 15 * 4);
    expect(mid.angleTo(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3))).toBeLessThan(0.02);
  });
});
