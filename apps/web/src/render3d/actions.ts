/**
 * Upper-body actions (docs/design/character-feel-research.md §3.5, §5.1 D): the Forge's authored reloads and throw
 * played as masked overrides on the upper body, which the game never showed (a reload or a throw drew nothing).
 * - **Reload:** `reload_rifle` (two-handed guns) or `reload_pistol` (one-handed) while the gun in hand reloads, timed
 *   to the weapon's reload: a little faster or slower than authored, or, for a long reload, the clip's start and end
 *   at their own speed with its middle (the hands at the magazine) going back and forth in between.
 * - **Throw:** `throw` on the sim's throw event, at its own speed (0.6 s).
 * - **Throw:** the authored throw is a right-arm throw; it plays mirrored on the left arm and the spine, so the gun
 *   hand stays on the aim.
 * An action owns its bones at full weight from its first frame to its last; the avatar's inertialization eases the
 * body into it and back out to the aim, so there is no cross-fade here.
 */
import { Quaternion, QuaternionKeyframeTrack, type AnimationClip, type Interpolant, type Object3D } from 'three';

export type ActionName = 'reload_rifle' | 'reload_pistol' | 'throw';
const NAMES: readonly ActionName[] = ['reload_rifle', 'reload_pistol', 'throw'];

export const ACTIONS = {
  /** a clip plays between these speeds (× authored) to fit its time; a longer time keeps the ends at this speed and
   *  goes back and forth through the middle */
  minRate: 0.75,
  maxRate: 1.6,
  /** the share of a clip at either end played at its own speed when its middle is drawn out */
  ends: 0.3,
  /** the throw starts this far into its clip (s): the sim's event is the release, so most of the wind-up is skipped
   *  and the arm comes over within ~0.15 s of the grenade leaving */
  throwFrom: 0.12,
};

/**
 * Where in a clip `duration` s long the action is `t` s into a `seconds`-long play (both ends at the clip's ends).
 * Fits by speed within ACTIONS' rates; beyond the slowest, the ends play at that speed and the middle ping-pongs.
 */
export function actionTime(t: number, duration: number, seconds: number): number {
  const u = Math.min(Math.max(t, 0), seconds);
  if (seconds <= duration / ACTIONS.minRate) {
    const rate = Math.min(ACTIONS.maxRate, duration / Math.max(seconds, 1e-6));
    return Math.min(duration, (u * duration) / Math.max(seconds, 1e-6), u * rate);
  }
  // the ends at minRate, the middle back and forth over the rest
  const rate = ACTIONS.minRate;
  const head = ACTIONS.ends * duration;
  const middle = duration - 2 * head;
  const headS = head / rate;
  if (u <= headS) return u * rate;
  if (u >= seconds - headS) return duration - (seconds - u) * rate;
  const span = seconds - 2 * headS;
  // whole passes through the middle (odd, so it leaves at the far end), at about minRate
  const passes = Math.max(1, 2 * Math.round(((span * rate) / middle - 1) / 2) + 1);
  const along = ((u - headS) / span) * passes;
  const pass = Math.min(passes - 1, Math.floor(along));
  const f = along - pass;
  return head + middle * (pass % 2 === 0 ? f : 1 - f);
}

/** The reload clip for a weapon held with `hands`. */
export function reloadClip(hands: 1 | 2 | undefined): ActionName {
  return hands === 2 ? 'reload_rifle' : 'reload_pistol';
}

/** The bones an action poses: the whole upper body, or (a throw, with the other hand) the spine and the left arm. */
const SPINE = ['spine1', 'spine2', 'neck', 'head'];
const ARM = ['clavicle', 'upperarm', 'forearm', 'hand'];

interface Pose {
  bone: Object3D;
  interpolant: Interpolant;
  /** the clip's other side, mirrored onto this bone (x, −y, −z, w: the rig's left and right frames are mirror images) */
  mirror: boolean;
}

interface Action {
  poses: Pose[];
  duration: number;
  /** where in the clip the action starts (s) */
  from: number;
  /** the action poses the gun arm (a reload); else the aim layer keeps it on the aim */
  gunArm: boolean;
}

const _q = new Quaternion();

/**
 * The Forge's upper-body actions, sampled straight onto the bones after the mixer (an override: the aim poses keep
 * whatever the action leaves alone). The throw is the authored right-arm throw mirrored onto the left arm and the
 * spine, so the gun hand stays on the aim.
 */
export class ActionLayer {
  private readonly actions = new Map<ActionName, Action>();
  private playing: ActionName | null = null;
  private t = 0;
  private time = 0;
  private seconds = 0;

  constructor(clips: readonly AnimationClip[], bone: (name: string) => Object3D | null) {
    for (const name of NAMES) {
      const clip = clips.find((c) => c.name === name);
      if (!clip) continue;
      const tracks = new Map(clip.tracks.filter((t) => t instanceof QuaternionKeyframeTrack).map((t) => [t.name.slice(0, t.name.lastIndexOf('.')), t]));
      const poses: Pose[] = [];
      const add = (target: string, source: string, mirror: boolean) => {
        const b = bone(target);
        const track = tracks.get(source);
        if (b && track) poses.push({ bone: b, interpolant: track.InterpolantFactoryMethodLinear(), mirror }); // (quaternion tracks: a slerp)
      };
      const throwing = name === 'throw';
      for (const s of SPINE) add(s, s, throwing);
      if (throwing) for (const a of ARM) add(`${a}_L`, `${a}_R`, true);
      else for (const a of ARM) for (const side of ['L', 'R']) add(`${a}_${side}`, `${a}_${side}`, false);
      const from = throwing ? Math.min(ACTIONS.throwFrom, clip.duration / 2) : 0;
      this.actions.set(name, { poses, duration: clip.duration, from, gunArm: !throwing });
    }
  }

  /** The rig has this clip. */
  has(name: ActionName): boolean {
    return this.actions.has(name);
  }

  /** The action on show, or null. */
  get current(): ActionName | null {
    return this.playing;
  }

  /** The action on show poses the gun arm (else the aim layer keeps it on the aim). */
  get gunArm(): boolean {
    return this.playing !== null && this.actions.get(this.playing)!.gunArm;
  }

  /** How far into the action (s), and its length. */
  get elapsed(): number {
    return this.t;
  }

  get length(): number {
    return this.seconds;
  }

  /** Starts `name` over `seconds` (default: its authored length from where it starts); a missing clip plays nothing. */
  play(name: ActionName, seconds?: number): void {
    const a = this.actions.get(name);
    if (!a) return;
    this.playing = name;
    this.t = 0;
    this.seconds = seconds ?? a.duration - a.from;
  }

  stop(): void {
    this.playing = null;
  }

  /** The action's clock this frame; it ends itself after its length. */
  update(dt: number): ActionName | null {
    if (!this.playing) return null;
    if (this.t >= this.seconds) {
      this.stop();
      return null;
    }
    const a = this.actions.get(this.playing)!;
    this.time = a.from + actionTime(this.t, a.duration - a.from, this.seconds);
    this.t += dt;
    return this.playing;
  }

  /** After the mixer: the action's pose on its bones (they must be put back to the animation pose every frame). */
  apply(): void {
    if (!this.playing) return;
    for (const p of this.actions.get(this.playing)!.poses) {
      _q.fromArray(p.interpolant.evaluate(this.time));
      if (p.mirror) _q.set(_q.x, -_q.y, -_q.z, _q.w);
      p.bone.quaternion.copy(_q.normalize());
    }
  }
}
