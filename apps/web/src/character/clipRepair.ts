/**
 * Repairs W8's clip library at load time. `rookie_anims.glb` is exported unsampled from Blender as CUBICSPLINE,
 * but the exporter wrote nearly every quaternion tangent as an identity quaternion (x, y, z, w) = (1, 0, 0, 0)
 * instead of a derivative. three.js follows the glTF spline maths, so every rotated bone wobbles between keys
 * (the idle's pelvis bows ±11° between keys a second apart). Until the export is fixed (asked in the notes),
 * the tangents are rebuilt the way Blender draws its default auto-clamped Bézier keys (flat at a component's
 * extremes, Catmull-Rom slope elsewhere, wrapping round on loops), and each track is resampled at the clip rate
 * into a linear track, which every consumer (mixer, additive deltas) handles exactly.
 */
import { AnimationClip, KeyframeTrack, NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';

/** W8 authors at 30 fps (art/pipeline/clips.py FPS). */
export const CLIP_FPS = 30;

type Interpolating = KeyframeTrack & { createInterpolant: { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } };

const isCubic = (t: KeyframeTrack) => !!(t as Interpolating).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline;

/** Key values without the cubic-spline tangents: n keys × size components. */
function keyValues(track: KeyframeTrack, size: number): Float32Array {
  const out = new Float32Array(track.times.length * size);
  for (let k = 0; k < track.times.length; k++) out.set(track.values.subarray(k * size * 3 + size, k * size * 3 + 2 * size), k * size);
  return out;
}

/** Auto-clamped slopes per key and component: 0 at an extreme or an end, Catmull-Rom otherwise (cyclic when it loops). */
export function autoClampedSlopes(times: ArrayLike<number>, values: ArrayLike<number>, size: number, duration: number): Float32Array {
  const n = times.length;
  const slopes = new Float32Array(n * size);
  if (n < 2) return slopes;
  let loops = Math.abs(times[0]!) < 1e-6 && Math.abs(times[n - 1]! - duration) < 1e-4;
  for (let c = 0; c < size && loops; c++) loops = Math.abs(values[c]! - values[(n - 1) * size + c]!) < 1e-4;
  for (let k = 0; k < n; k++) {
    // neighbours (wrapping round a loop: the last key repeats the first)
    let p = k - 1;
    let q = k + 1;
    let tp = times[p] ?? 0;
    let tq = times[q] ?? 0;
    if (k === 0) {
      if (!loops) continue;
      p = n - 2;
      tp = times[p]! - duration;
    }
    if (k === n - 1) {
      if (!loops) continue;
      q = 1;
      tq = times[q]! + duration;
    }
    for (let c = 0; c < size; c++) {
      const a = values[p * size + c]!;
      const v = values[k * size + c]!;
      const b = values[q * size + c]!;
      slopes[k * size + c] = (v - a) * (b - v) <= 0 ? 0 : (b - a) / (tq - tp);
    }
  }
  return slopes;
}

/** Hermite between keys with the given slopes, sampled every 1/fps (and at every key), as plain values. */
function resample(times: ArrayLike<number>, values: ArrayLike<number>, slopes: ArrayLike<number>, size: number, duration: number, fps: number): { times: number[]; values: number[] } {
  const n = times.length;
  const outTimes: number[] = [];
  const outValues: number[] = [];
  const end = Math.max(duration, times[n - 1]!);
  const steps = Math.max(1, Math.round(end * fps));
  let k = 0;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * end;
    while (k < n - 2 && t > times[k + 1]!) k++;
    outTimes.push(t);
    if (n === 1 || t <= times[0]!) {
      for (let c = 0; c < size; c++) outValues.push(values[c]!);
      continue;
    }
    if (t >= times[n - 1]!) {
      for (let c = 0; c < size; c++) outValues.push(values[(n - 1) * size + c]!);
      continue;
    }
    const t0 = times[k]!;
    const td = times[k + 1]! - t0;
    const s = (t - t0) / td;
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    for (let c = 0; c < size; c++) {
      outValues.push(h00 * values[k * size + c]! + h10 * td * slopes[k * size + c]! + h01 * values[(k + 1) * size + c]! + h11 * td * slopes[(k + 1) * size + c]!);
    }
  }
  return { times: outTimes, values: outValues };
}

const _q = new Quaternion();

/** Negates every quaternion key (4 components) whose dot product with the key before it is negative. */
export function sameHemisphere(values: Float32Array | number[]): void {
  for (let k = 4; k + 3 < values.length; k += 4) {
    const dot = values[k]! * values[k - 4]! + values[k + 1]! * values[k - 3]! + values[k + 2]! * values[k - 2]! + values[k + 3]! * values[k - 1]!;
    if (dot < 0) for (let c = 0; c < 4; c++) values[k + c] = -values[k + c]!;
  }
}

/** A clip with every cubic-spline track rebuilt as a dense linear track (linear tracks are kept as they are). */
export function repairClip(clip: AnimationClip, fps = CLIP_FPS): AnimationClip {
  const tracks = clip.tracks.map((track) => {
    if (!isCubic(track)) return track;
    const size = track.getValueSize() / 3;
    const values = keyValues(track, size);
    // q and −q are the same rotation; interpolating across a sign flip takes the long way round (melee, reload and
    // throw spun up to 4,700°/s): keep each key in its predecessor's hemisphere
    if (track instanceof QuaternionKeyframeTrack) sameHemisphere(values);
    const slopes = autoClampedSlopes(track.times, values, size, clip.duration);
    const dense = resample(track.times, values, slopes, size, clip.duration, fps);
    if (track instanceof QuaternionKeyframeTrack) {
      for (let i = 0; i < dense.values.length; i += 4) _q.fromArray(dense.values, i).normalize().toArray(dense.values, i);
      return new QuaternionKeyframeTrack(track.name, dense.times, dense.values);
    }
    return size === 1 ? new NumberKeyframeTrack(track.name, dense.times, dense.values) : new VectorKeyframeTrack(track.name, dense.times, dense.values);
  });
  const out = new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
  out.userData = clip.userData;
  return out;
}

export function repairClips(clips: readonly AnimationClip[], fps = CLIP_FPS): AnimationClip[] {
  return clips.map((c) => repairClip(c, fps));
}
