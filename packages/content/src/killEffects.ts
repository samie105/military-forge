/**
 * What a weapon skin changes in a match besides the gun's mesh (docs/17 §3.6–3.7): the tracer's glow, and
 * the kill effect its top tier carries. Both are looked up from the killer's (or shooter's) look, which every
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

/** One phase's quads: how many, their size and life ranges, and their colours (#rrggbb, picked per quad). */
export interface KillEffectPhase {
  count: number;
  /** quad width, min and max (m) */
  sizeM: readonly [number, number];
  lifeS: readonly [number, number];
  palette: readonly string[];
}

export interface KillEffectDef {
  id: string;
  name: string;
  durationS: number;
  /** quads at most over the whole effect: shards + sparkles + swirl (≤ maxParticles) */
  particles: number;
  /** crystal cubes where the body stood: they burst out at up to this speed, tumble and shrink away */
  shards: KillEffectPhase & { burstMps: number };
  /** star sparkles in two waves, the second this long after the kill */
  sparkles: KillEffectPhase & { secondWaveS: number };
  /** the stardust swirl: from `atS`, a two-strand spiral of `radiusM`, `turns` times round, rising `riseM` */
  swirl: KillEffectPhase & { atS: number; radiusM: number; turns: number; riseM: number };
  /** the colour the victim's body takes as it shatters: mixed into its toon colour, never added as light */
  bodyTint: string;
  /** when the body dissolves (seconds after the kill, from–to), leaving its shards where it stood */
  dissolveS: readonly [number, number];
  /** Reduce flashes / Reduce motion / the Low preset / a fifth at once: a flat tint fade, no particles */
  still: { tint: string; durationS: number };
  /** a sound id (≤ 1 s, no louder than the base death); null = the base death sound */
  sound: string | null;
}

/** Every colour an effect draws (its phases' palettes, the body tint, the still tint). */
export function killEffectColours(e: KillEffectDef): string[] {
  return [...e.shards.palette, ...e.sparkles.palette, ...e.swirl.palette, e.bodyTint, e.still.tint];
}

const phase = <P extends KillEffectPhase>(id: string, name: string, p: P): P => {
  if (!p || !(p.count >= 0) || !p.palette?.length || p.sizeM[0] > p.sizeM[1] || p.lifeS[0] > p.lifeS[1]) throw new Error(`kill-effects.json: ${id} has a malformed ${name}`);
  return Object.freeze({ ...p, sizeM: Object.freeze([...p.sizeM]), lifeS: Object.freeze([...p.lifeS]), palette: Object.freeze([...p.palette]) }) as P;
};

export const killEffects: readonly KillEffectDef[] = (killEffectsJson.effects as unknown as KillEffectDef[]).map((e) => {
  const def = {
    ...e,
    shards: phase(e.id, 'shards', e.shards),
    sparkles: phase(e.id, 'sparkles', e.sparkles),
    swirl: phase(e.id, 'swirl', e.swirl),
    dissolveS: Object.freeze([e.dissolveS[0], e.dissolveS[1]] as const),
    still: Object.freeze({ ...e.still }),
  };
  if (def.shards.count + def.sparkles.count + def.swirl.count !== def.particles) throw new Error(`kill-effects.json: ${e.id}'s phases don't add up to its particles`);
  return Object.freeze(def);
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
 * The glow gradient (#rrggbb, from the bolt's head back to the muzzle) a look's skin gives `weaponId`'s tracers:
 * the glow around the bolt and its path line. The bolt's core is always the base's. null = the base tracer.
 */
export function tracerGlowOf(look: CosmeticLoadout | null | undefined, weaponId: string): readonly string[] | null {
  return weaponSkinOf(look, weaponId)?.tracerGlow ?? null;
}

/** The kill effect that plays on a kill with `weaponId` by a killer wearing `look`; null = the default death. */
export function killEffectOf(look: CosmeticLoadout | null | undefined, weaponId: string): KillEffectDef | null {
  const id = weaponSkinOf(look, weaponId)?.killEffect;
  return id ? (byId.get(id) ?? null) : null;
}
