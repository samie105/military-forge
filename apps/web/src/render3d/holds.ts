/**
 * How each kind of weapon is held (the owner: "they should hold different guns, not holding the guns
 * the same way"). A hold profile per family places the gun hand relative to the shoulder and along
 * the aim, bends the elbow, leans the spine and tilts the head, and gives the support hand a target
 * on the weapon:
 * - pistol (and one-handed SMGs like the Buzz): one hand, arm out;
 * - rifle: two hands, the stock at the shoulder;
 * - shotgun: the same, the support hand forward on the pump;
 * - sniper: tucked in tight, head down to the scope;
 * - heavy: carried at the hip;
 * - launcher: the tube on the shoulder;
 * - melee: the blade raised in a fighting stance.
 *
 * The family comes from the Forge's sockets.json (`family`) or the weapon's class. When the rig
 * carries W8's aim poses (`aim_<pistol|dual|rifle>_<down90…up90>`, after the animation stream moves
 * the game onto W8's rig), `AimClips` blends the two around the aim angle on the upper body, and
 * the gun is then only turned onto the exact aim.
 */
import type { WeaponDef } from '@military-forge/content';
import type { AnimationAction, AnimationClip, AnimationMixer } from 'three';

export type HoldFamily = 'pistol' | 'rifle' | 'shotgun' | 'sniper' | 'heavy' | 'launcher' | 'melee';
export type AimPose = 'pistol' | 'dual' | 'rifle';

export interface HoldProfile {
  /** the gun hand along the aim from the shoulder, as a share of the arm's reach */
  reach: number;
  /** the gun hand below (+) or above (−) the shoulder, m */
  drop: number;
  /** the gun hand toward the body's middle, m (a rifle in front of the chest) */
  inward: number;
  /** elbow pole: down, out to its own side, back along the aim (m from the shoulder) */
  elbowDown: number;
  elbowOut: number;
  elbowBack: number;
  /** the gun pitched up from the aim (rad): a raised blade */
  pitch: number;
  /** extra forward lean of the spine (rad, + = into the gun), and the head down toward the sights */
  lean: number;
  head: number;
  /** support hand in the weapon frame when the model has no `offhand` socket; null = one-handed */
  offhand: readonly [number, number, number] | null;
  /** pushed along the barrel (+Y, m) from the socket: a shotgun's pump */
  offhandForward: number;
  /** W8's aim-pose clip set */
  aimPose: AimPose;
}

const BASE: HoldProfile = {
  reach: 0.9,
  drop: 0,
  inward: 0,
  elbowDown: 0.5,
  elbowOut: 0.3,
  elbowBack: 0.2,
  pitch: 0,
  lean: 0,
  head: 0,
  offhand: null,
  offhandForward: 0,
  aimPose: 'pistol',
};

export const HOLDS: Readonly<Record<HoldFamily, HoldProfile>> = {
  pistol: BASE,
  rifle: { ...BASE, reach: 0.55, drop: 0.04, inward: 0.07, elbowOut: 0.35, elbowBack: 0.1, lean: 0.04, head: 0.05, offhand: [0, 0.3, -0.03], aimPose: 'rifle' },
  shotgun: { ...BASE, reach: 0.55, drop: 0.05, inward: 0.07, elbowOut: 0.35, elbowBack: 0.1, lean: 0.06, offhand: [0, 0.34, -0.05], offhandForward: 0.12, aimPose: 'rifle' },
  sniper: { ...BASE, reach: 0.42, drop: -0.03, inward: 0.1, elbowDown: 0.6, elbowOut: 0.12, elbowBack: 0.15, lean: 0.12, head: 0.28, offhand: [0, 0.32, -0.04], aimPose: 'rifle' },
  heavy: { ...BASE, reach: 0.4, drop: 0.3, inward: 0.04, elbowDown: 0.3, elbowOut: 0.25, elbowBack: 0.35, lean: -0.06, offhand: [0, 0.2, 0.07], aimPose: 'rifle' },
  launcher: { ...BASE, reach: 0.2, drop: -0.13, inward: -0.02, elbowDown: 0.6, elbowOut: 0.15, elbowBack: 0.05, head: 0.12, offhand: [0, 0.26, -0.05], aimPose: 'rifle' },
  melee: { ...BASE, reach: 0.7, drop: -0.04, elbowDown: 0.45, elbowOut: 0.35, elbowBack: 0.25, pitch: 0.7, lean: 0.05 },
};

/** sockets.json families (docs/04 §4.2) and content classes → the hold. */
const BY_NAME: Readonly<Record<string, HoldFamily>> = {
  pistol: 'pistol',
  sidearm: 'pistol',
  smg: 'pistol',
  thrown: 'pistol',
  rifle: 'rifle',
  dmr: 'rifle',
  shotgun: 'shotgun',
  sniper: 'sniper',
  heavy: 'heavy',
  launcher: 'launcher',
  special: 'launcher',
  melee: 'melee',
};

/**
 * The hold for a weapon: the Forge's family when it has one, else the weapon's class. A
 * one-handed weapon never gets a two-handed hold (the Buzz is a one-handed SMG).
 */
export function holdFamily(def: Pick<WeaponDef, 'class' | 'hands'> | undefined, family?: string | null): HoldFamily {
  const f = (family && BY_NAME[family]) || (def && BY_NAME[def.class]) || 'pistol';
  return def?.hands === 1 && f !== 'melee' ? 'pistol' : f;
}

// ---------- W8 aim poses ----------

/** W8's aim angles, low to high (rookie.json `aimAngles`) */
export const AIM_ANGLES = ['down90', 'down45', 'level', 'up45', 'up90'] as const;
const AIM_STEP = Math.PI / 4;

/** The two aim poses around `elevation` (rad, −π/2 … π/2) and the blend toward the upper one. */
export function aimBlend(elevation: number): { lo: number; hi: number; t: number } {
  const u = Math.min(4, Math.max(0, elevation / AIM_STEP + 2));
  const lo = Math.min(3, Math.floor(u));
  return { lo, hi: lo + 1, t: u - lo };
}

/**
 * W8's aim-pose clips on one mixer: a set of five per pose that the rig has (none on the Phase 0
 * Rookie). Weighted each frame toward the pose for the held weapon and the aim angle; the
 * locomotion clips must leave the upper body to them (the animation stream's
 * `LocoLayer.setUpperBody(false)`).
 */
export class AimClips {
  private readonly sets = new Map<AimPose, AnimationAction[]>();
  private active: AimPose | null = null;

  constructor(mixer: AnimationMixer, clips: readonly AnimationClip[]) {
    for (const pose of ['pistol', 'dual', 'rifle'] as const) {
      const found = AIM_ANGLES.map((a) => clips.find((c) => c.name === `aim_${pose}_${a}`));
      if (found.some((c) => !c)) continue;
      this.sets.set(
        pose,
        found.map((clip) => {
          const action = mixer.clipAction(clip!);
          action.setEffectiveWeight(0).play();
          return action;
        }),
      );
    }
  }

  /** the rig has W8's aim poses */
  get available(): boolean {
    return this.sets.size > 0;
  }

  /** Blends `pose` (a missing set falls back: dual → pistol, then rifle) at `elevation`; null lets go. */
  update(pose: AimPose | null, elevation: number): AimPose | null {
    const use = pose && (this.sets.has(pose) ? pose : pose === 'dual' && this.sets.has('pistol') ? 'pistol' : this.sets.has('rifle') ? 'rifle' : null);
    const { lo, hi, t } = aimBlend(elevation);
    for (const [p, actions] of this.sets) {
      for (let i = 0; i < actions.length; i++) {
        const w = p !== use ? 0 : i === lo ? 1 - t : i === hi ? t : 0;
        actions[i]!.setEffectiveWeight(w);
      }
    }
    this.active = use ?? null;
    return this.active;
  }

  /** the pose being shown, or null */
  get pose(): AimPose | null {
    return this.active;
  }
}
