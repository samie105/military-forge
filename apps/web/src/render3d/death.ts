/**
 * The death beat (docs/design/character-feel-research.md §5.1 D, §6 ask 2): a soldier no longer vanishes on the
 * frame it dies. By default (the doc's recommendation (a), the orchestrator's default pending the owner) it collapses
 * in 0.4 s, knees first, then the torso and head, with a small settle, and fades out over 0.25 s: war tone, no gore.
 * One setting (`DeathStyle`, AvatarKit.deathStyle) switches it back to the instant vanish; the docs/04 ragdoll would
 * be a third style.
 */
export type DeathStyle = 'collapse' | 'vanish';

const DEG = Math.PI / 180;

export const DEATH = {
  /** the default style (the owner decides: §6 ask 2) */
  style: 'collapse' as DeathStyle,
  /** the collapse, then the fade (s) */
  collapse: 0.4,
  fade: 0.25,
  /** the hips come down this far (m) as the knees give (the legs fold over planted feet) */
  kneel: 0.17,
  /** the torso folds forward this far (rad, split over spine1 and spine2), and the head drops this much more */
  slump: 26 * DEG,
  head: 24 * DEG,
  /** the arms hang forward this far (rad) as the body folds */
  arms: 30 * DEG,
  /** the gun in hand dips this far, muzzle down (rad) */
  gunDip: 70 * DEG,
  /** a settle at the bottom: the share the knees and torso dip past, then come back */
  settle: 0.08,
  /** a soldier killed in the air drops to the floor under it at this gravity (m/s²) */
  gravity: 20,
};

/** smooth 0 → 1 between `a` and `b` */
const ease = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** A dip past 1 and back over [a, b]: 0 at both ends, `size` in the middle. */
const settle = (a: number, b: number, t: number, size: number) => {
  const u = (t - a) / (b - a);
  return u <= 0 || u >= 1 ? 0 : size * Math.sin(Math.PI * u);
};

/** How far into each part of the collapse the body is at `t` s after death (0 … ~1). */
export interface CollapsePose {
  /** the knees giving: 0 standing … 1 kneeling (the hips down DEATH.kneel) */
  kneel: number;
  /** the torso folding forward, 0 … 1 (× DEATH.slump) */
  slump: number;
  /** the head dropping, 0 … 1 (× DEATH.head) */
  head: number;
  /** the arms hanging forward, 0 … 1 (× DEATH.arms) */
  arms: number;
  /** the dissolve, 0 whole … 1 gone */
  fade: number;
}

/**
 * The collapse at `t` s: the knees go first (an accelerating drop, 0–0.2 s), the torso follows (0.08–0.3 s) and the
 * head trails it (0.14–0.34 s), everything dips a little past and settles (to 0.4 s); then the fade.
 */
export function collapseAt(t: number, out: CollapsePose): CollapsePose {
  const k = Math.min(1, Math.max(0, t / 0.2));
  out.kneel = k * k + settle(0.2, DEATH.collapse, t, DEATH.settle);
  out.slump = ease(0.08, 0.3, t) + settle(0.26, DEATH.collapse, t, DEATH.settle * 1.5);
  out.head = ease(0.14, 0.34, t) + settle(0.3, DEATH.collapse, t, DEATH.settle * 2);
  out.arms = ease(0.05, 0.32, t);
  out.fade = ease(DEATH.collapse, DEATH.collapse + DEATH.fade, t);
  return out;
}

/** The whole beat's length (s): after it the soldier is hidden until it respawns. */
export function deathSeconds(style: DeathStyle): number {
  return style === 'collapse' ? DEATH.collapse + DEATH.fade : 0;
}
