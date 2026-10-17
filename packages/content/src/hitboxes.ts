/**
 * Damage hitboxes, relative to the player's feet (docs/02 §6). Separate from the collision
 * capsule and identical for every cosmetic. Crouching tucks the head: the head zone is removed
 * and hits there count as torso (×1.0).
 */
export interface CircleBox {
  y: number;
  r: number;
}

export interface CapsuleBox {
  y0: number;
  y1: number;
  r: number;
}

export interface HitboxLayout {
  head: CircleBox;
  /** false while crouched: the head circle still exists but deals torso damage */
  headIsHeadshot: boolean;
  torso: CapsuleBox;
  legs: CapsuleBox;
}

export const STANDING_HITBOXES: HitboxLayout = {
  head: { y: 1.24, r: 0.24 },
  headIsHeadshot: true,
  torso: { y0: 0.45, y1: 0.95, r: 0.3 },
  legs: { y0: 0.1, y1: 0.45, r: 0.22 },
};

export const CROUCHED_HITBOXES: HitboxLayout = {
  head: { y: 0.84, r: 0.22 },
  headIsHeadshot: false,
  torso: { y0: 0.32, y1: 0.7, r: 0.3 },
  legs: { y0: 0.1, y1: 0.32, r: 0.22 },
};

export const HitZone = {
  None: 0,
  Head: 1,
  Torso: 2,
  Legs: 3,
} as const;
export type HitZone = (typeof HitZone)[keyof typeof HitZone];
