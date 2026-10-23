/**
 * The character-feel probe (docs/design/character-feel-research.md §2, §9): drives an Avatar at 60 Hz on the real
 * skeleton and clips (rookieRig) over the movement-test map's flat floor and measures what the eye reads as rough:
 * - `turns`: the largest change of any bone's local rotation between two frames (°/frame), and which bone;
 * - `contactSkate`: how fast the foot on the ground moves, as a share of the ground speed;
 * - foot travel through a standing facing turn, the take-off pose's delay, a landing's knee.
 * The tests in feel.test.ts turn §9's acceptance criteria into pass/fail numbers on these.
 */
import { movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { Quaternion, Vector3, type Bone } from 'three';
import type { PlayerView } from '../../view';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp } from '../character';
import { playerView } from './helpers';
import { rookieRig } from './rookieRig';

export const DT = 1 / 60;
export const world = new CollisionWorld(movementTestMap);
export const kit = new AvatarKit(toonRamp());
/** the movement-test map's long flat floor (x 116–142, y 0) */
export const FLAT_X = 118;
/** the rest pose's ankle height above the soles (m) */
export const ANKLE = 0.12;

export async function feelAvatar(seed = 1): Promise<Avatar> {
  return new Avatar(await rookieRig(), 0, kit, seed);
}

/** Every bone under the character's root. */
export function bonesOf(av: Avatar): Bone[] {
  const out: Bone[] = [];
  av.inst.root.traverse((o) => {
    if ((o as Bone).isBone) out.push(o as Bone);
  });
  return out;
}

const angle = (a: Quaternion, b: Quaternion) => (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;

export interface Turn {
  /** the largest local rotation change between this frame and the last (°) */
  deg: number;
  bone: string;
}

/**
 * Per frame of `views`: the largest change of any bone's local rotation since the frame before (°/frame).
 * `onFrame` sees the avatar after each update (measure more there).
 */
export function turns(av: Avatar, views: Iterable<PlayerView>, onFrame?: (av: Avatar, i: number, p: PlayerView) => void, skip: (bone: Bone) => boolean = () => false): Turn[] {
  const bones = bonesOf(av).filter((b) => !skip(b));
  const last = bones.map((b) => b.quaternion.clone());
  const out: Turn[] = [];
  let i = 0;
  for (const p of views) {
    av.update(p, DT, world, false);
    let deg = 0;
    let bone = '';
    bones.forEach((b, k) => {
      const d = i === 0 ? 0 : angle(b.quaternion, last[k]!);
      if (d > deg) [deg, bone] = [d, b.name];
      last[k]!.copy(b.quaternion);
    });
    out.push({ deg, bone });
    onFrame?.(av, i, p);
    i++;
  }
  return out;
}

/** The largest turn in `frames` from index `from` (to `to`). */
export function peak(frames: readonly Turn[], from = 0, to = frames.length): Turn {
  let best: Turn = { deg: 0, bone: '' };
  for (let i = from; i < to; i++) if (frames[i]!.deg > best.deg) best = frames[i]!;
  return best;
}

/** Views standing (or moving at vx) with `over` from frame `at` on and `before` until then. */
export function* timeline(frames: number, at: number, before: Partial<PlayerView>, after: Partial<PlayerView>, vx = 0, x0 = FLAT_X): Generator<PlayerView> {
  let x = x0;
  for (let i = 0; i < frames; i++) yield playerView({ aim: 0.15, ...(i < at ? before : after), x: (x += vx * DT), vx });
}

/** World positions of both ankles. */
export function feet(av: Avatar): [Vector3, Vector3] {
  return [av.inst.bone('foot_L')!.getWorldPosition(new Vector3()), av.inst.bone('foot_R')!.getWorldPosition(new Vector3())];
}

/**
 * Walking steadily at `speed` on the flat floor: the mean speed of the foot on the ground (the lower ankle, within
 * 1.5 cm of standing height, both this frame and the last) as a share of the ground speed. `frames` after a 90-frame
 * settle.
 */
export async function contactSkate(speed: number, frames = 240, seed = 1): Promise<{ share: number; contact: number }> {
  const av = await feelAvatar(seed);
  let x = FLAT_X;
  let prev: [Vector3, Vector3] | null = null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 90 + frames; i++) {
    av.update(playerView({ x: (x += speed * DT), vx: speed, aim: 0.15 }), DT, world, false);
    const f = feet(av);
    if (i >= 90 && prev) {
      const k = f[0].y <= f[1].y ? 0 : 1;
      if (f[k].y <= ANKLE + 0.015 && prev[k].y <= ANKLE + 0.015) {
        sum += Math.abs(f[k].x - prev[k].x) / DT;
        n++;
      }
    }
    prev = f;
  }
  return { share: n ? sum / n / speed : 0, contact: n / frames };
}
