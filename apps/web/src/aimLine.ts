/**
 * The sniper's aim line (the owner's phone playtest, 25 Oct: "for snipers, show … the line the
 * bullet is going to go"): for the local player only, while a sniper or marksman rifle is in hand,
 * the line a shot fired now would fly, cut at the first solid. The sim computes it (`aimRay`: the
 * shot's own shoulder, muzzle guard, map reach and bullet raycast), from the local game or, online,
 * the predicted one, so the line is the shot's real path. Both views draw it from the Frame (render.ts
 * in 2D, render3d's AimLine in 3D). Nobody else's line is ever drawn: it would give a sniper away.
 */
import { NO_WEAPON, weapons, type WeaponDef } from '@military-forge/content';
import { aimRay, createAimRay, type AimRay, type Game, type PlayerState } from '@military-forge/sim';

/** The line both views draw (Frame.aimLine). */
export interface AimLineView extends AimRay {
  /** the local player, for the drawn muzzle */
  shooter: number;
  /** the gun in hand (content index) */
  weapon: number;
  /** the gun would fire now: not reloading, swapping or cycling (the line burns brighter) */
  ready: boolean;
}

/** spread (±°) past which the shot may stray off the line: the line dims and its wall dot goes */
export const AIM_SURE_SPREAD = 0.25;
/** reloading, swapping or cycling the bolt: the line burns at this share */
export const AIM_NOT_READY = 0.4;

/** How bright the line is now (0..1): dimmer while the gun isn't ready, and while the shot may stray. */
export function aimLineStrength(view: Pick<AimLineView, 'ready' | 'spread'>): number {
  const ready = view.ready ? 1 : AIM_NOT_READY;
  const sure = view.spread <= AIM_SURE_SPREAD ? 1 : Math.max(0.35, 1 - view.spread / 3);
  return ready * sure;
}

/** Guns that show the line: the scoped ones (the Widow, the Longbow). */
export function showsAimLine(def: Pick<WeaponDef, 'class'> | undefined): boolean {
  return def !== undefined && (def.class === 'sniper' || def.class === 'dmr');
}

/** The line for the local player, recomputed each drawn frame while a scoped gun is in hand. */
export class AimLinePreview {
  private readonly view: AimLineView = { ...createAimRay(), shooter: -1, weapon: NO_WEAPON, ready: false };

  /** The line for `me`, or null: dead, dual-wielding, or no scoped gun in hand. */
  update(game: Game | null, me: PlayerState | null): AimLineView | null {
    if (!game || !me || !me.alive || me.dual) return null;
    const slot = me.weapons[me.active];
    if (!slot || slot.def === NO_WEAPON) return null;
    const def = weapons[slot.def];
    if (!def || !showsAimLine(def)) return null;
    aimRay(game, me, slot, def, this.view);
    this.view.shooter = me.id;
    this.view.weapon = def.index;
    this.view.ready = me.swapTicks === 0 && slot.reloadTicks === 0 && slot.cooldown <= 1e-6 && slot.mag > 0 && me.meleeTicks === 0;
    return this.view;
  }
}
