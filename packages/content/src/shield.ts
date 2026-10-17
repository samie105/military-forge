/**
 * Riot shield (docs/03 §5, §9, §11): an off-hand pickup that blocks bullets.
 *
 * Carry modes: raised in front of the body (blocks from the front, slows you), or slung on the back
 * (blocks from behind, no weight). It comes up only with a one-handed weapon in hand and no dual
 * pair; a two-handed weapon or dual-wielding slings it, and the shield key toggles between the two.
 * On its way up it blocks neither way.
 *
 * The blocking surface is a vertical segment that follows the facing and the crouch: in front of
 * the torso when raised, behind it when slung. A bullet that strikes it from within ±arcDeg of that
 * side takes shield HP instead of body HP and bounces off (ricochet) with part of its damage.
 * Flames, explosions, melee and saws ignore it (docs/03 §9).
 */
export interface ShieldDef {
  id: string;
  name: string;
  /** hit points: bullets that strike it wear it down; at 0 it breaks */
  hp: number;
  /** ± degrees around the facing that a bullet may come from and still be blocked */
  arcDeg: number;
  /** the blocking segment's distance in front of the body's centre line while raised (m) */
  forward: number;
  /** …and behind it while slung (m): where the slung shield hangs, behind the jetpack */
  backOffset: number;
  /** length of the blocking segment (m) */
  height: number;
  /** bottom of the segment above the feet, standing and crouched (m); the same raised or slung */
  bottomStand: number;
  bottomCrouch: number;
  /** seconds to bring it up: it blocks once it is all the way up */
  raiseTime: number;
  /** a melee swing with the shield up is a shield bash */
  bashDamage: number;
  /** weight while it is up (docs/03 §9: the heaviest item in hand sets the speed) */
  moveSpeedMul: number;
  /** weight while it is slung on the back */
  slungSpeedMul: number;
  /** a bullet that bounces off keeps this share of its damage */
  ricochetDamageMul: number;
  /** most bounces per bullet or pellet; a bullet out of bounces is stopped by the next shield it meets */
  maxBounces: number;
}

export const RIOT_SHIELD: ShieldDef = {
  id: 'riot_shield',
  name: 'Riot Shield',
  hp: 300,
  arcDeg: 60,
  // 0.12 m in front of the torso hitbox (r 0.3): frontal bullets meet it first
  forward: 0.42,
  // slung: 0.1 m behind the torso hitbox, where the 3D back socket puts it on screen (shield-sockets.md)
  backOffset: 0.4,
  height: 0.9,
  // standing it covers 0.35–1.25 m (torso, most of the head); crouched 0.12–1.02 (nearly everything)
  bottomStand: 0.35,
  bottomCrouch: 0.12,
  raiseTime: 0.25,
  bashDamage: 25,
  moveSpeedMul: 0.75,
  // docs/03 §9 weighs what is held: on the back it is carried, not held
  slungSpeedMul: 1,
  ricochetDamageMul: 0.6,
  maxBounces: 1,
};
