/**
 * What a weapon skin changes in a match besides the gun's mesh (docs/17 §3.6–3.7): the tracer's hue, and the
 * kill effect its top tier carries. Both are looked up from the killer's (or shooter's) look, which every
 * client already has from the ROSTER, and the weapon the sim names in the event: nothing extra on the wire,
 * and the game server never knows about effects (it only checks the look is owned, `admitLook`).
 */
import killEffectsJson from '../cosmetics/kill-effects.json';
import { COSMETIC_ENVELOPE_MUL, getCosmetic, weaponSkinSlot, type CosmeticDef, type CosmeticLoadout } from './cosmetics';

/** docs/17 §3.7 and docs/04 §7's kill-effect row. */
export const KILL_EFFECT_LIMITS = {
  /** seconds from the kill event; nothing waits for it */
  maxDurationS: 1,
  /** GPU-instanced quads from the shared kill-effect atlas: one extra draw call */
  maxParticles: 80,
  /** effects playing at once; a fifth plays its still variant */
  maxLive: 4,
  /** the victim's body envelope: the base body box × this (docs/04 §1.2) */
  envelopeMul: COSMETIC_ENVELOPE_MUL,
} as const;

export interface KillEffectDef {
  id: string;
  name: string;
  durationS: number;
  /** stardust quads at most (≤ maxParticles) */
  particles: number;
  /** the shared atlas's cell the quads draw ("star" or "dot") */
  atlasCell: 'star' | 'dot';
  /** the quads' colours (#rrggbb), picked per quad */
  palette: readonly string[];
  /** the colour the victim's body takes as it dissolves: mixed into its toon colour, never added as light */
  bodyTint: string;
  /** metres the dust drifts up over the effect, clamped to the envelope's top */
  rise: number;
  /** Reduce flashes / Reduce motion / the Low preset / a fifth at once: a flat tint fade, no particles */
  still: { tint: string; durationS: number };
  /** a sound id (≤ 1 s, no louder than the base death); null = the base death sound */
  sound: string | null;
}

export const killEffects: readonly KillEffectDef[] = (killEffectsJson.effects as unknown as KillEffectDef[]).map((e) => {
  if (e.atlasCell !== 'star' && e.atlasCell !== 'dot') throw new Error(`kill-effects.json: ${e.id} has an unknown atlas cell`);
  return Object.freeze({ ...e, palette: Object.freeze([...e.palette]), still: Object.freeze({ ...e.still }) });
});

const byId = new Map(killEffects.map((e) => [e.id, e]));

export function getKillEffect(id: string): KillEffectDef | undefined {
  return byId.get(id);
}

/** The skin a look wears on `weaponId`: null for a gun without a skin line, or its base look. */
export function weaponSkinOf(look: CosmeticLoadout | null | undefined, weaponId: string): CosmeticDef | null {
  const slot = weaponSkinSlot(weaponId);
  if (!look || !slot) return null;
  const def = getCosmetic(look.items[slot]);
  return def && def.tier !== 'base' ? def : null;
}

/**
 * The tracer hues (#rrggbb) a look's skin gives `weaponId`'s shots: the bolt's, and its path line's (the bolt's
 * when the skin gives the path none); null = the base tracer.
 */
export function tracerTintOf(look: CosmeticLoadout | null | undefined, weaponId: string): { bolt: string; trail: string } | null {
  const skin = weaponSkinOf(look, weaponId);
  return skin?.tracerTint ? { bolt: skin.tracerTint, trail: skin.tracerTrail ?? skin.tracerTint } : null;
}

/** The kill effect that plays on a kill with `weaponId` by a killer wearing `look`; null = the default death. */
export function killEffectOf(look: CosmeticLoadout | null | undefined, weaponId: string): KillEffectDef | null {
  const id = weaponSkinOf(look, weaponId)?.killEffect;
  return id ? (byId.get(id) ?? null) : null;
}
