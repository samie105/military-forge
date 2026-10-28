/**
 * Which sounds each weapon, grenade and projectile uses. Guns share a family's sounds with a pitch
 * and level of their own (the Hawk .50 is a deeper pistol, the Bullpup a brighter rifle).
 */
import { PROJECTILE_TYPE_BASE, weapons, type WeaponDef } from '@military-forge/content';
import { isSoundId, type SoundId } from './sounds';

export type Family = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'lmg' | 'beam' | 'rocket' | 'popper' | 'flame' | 'ripper' | 'pulse' | 'melee';

/** One reload step: a sound at a fraction of the reload time. */
export interface ReloadStep {
  id: SoundId;
  at: number;
}

export interface WeaponSounds {
  family: Family;
  /** one shot (absent: the weapon's fire is a loop or a projectile handled elsewhere) */
  fire: SoundId | null;
  /** a loop while the trigger is held (beam, flamethrower) instead of a sound per shot */
  fireLoop?: { start: SoundId; loop: SoundId; stop: SoundId };
  /** the weapon winding up (minigun spin, a charge) */
  windup?: { start: SoundId; loop?: SoundId; stop?: SoundId };
  reload: readonly ReloadStep[];
  /** a shotgun loads one shell per missing round, then pumps */
  perRound?: { id: SoundId; end: SoundId };
  /** after each shot (a bolt or a pump), seconds later */
  cycle?: { id: SoundId; after: number };
  /** the spent case hitting the ground (brass, or a shotgun's hull) */
  brass?: SoundId;
  empty: SoundId;
  draw: SoundId;
  /** pitch and level of this gun on the family's sounds */
  rate: number;
  gain: number;
}

const MAG = (fam: 'pistol' | 'smg' | 'rifle' | 'sniper' | 'lmg', rack: SoundId | null): ReloadStep[] => [
  { id: `${fam}.magout` as SoundId, at: 0.08 },
  { id: `${fam}.magin` as SoundId, at: 0.55 },
  ...(rack ? [{ id: rack, at: 0.82 }] : []),
];

const BASE: Record<Family, Omit<WeaponSounds, 'rate' | 'gain'>> = {
  pistol: { family: 'pistol', brass: 'brass.tinkle', fire: 'pistol.fire', reload: MAG('pistol', 'pistol.slide'), empty: 'pistol.empty', draw: 'pistol.draw' },
  smg: { family: 'smg', brass: 'brass.tinkle', fire: 'smg.fire', reload: MAG('smg', 'smg.bolt'), empty: 'smg.empty', draw: 'smg.draw' },
  rifle: { family: 'rifle', brass: 'brass.tinkle', fire: 'rifle.fire', reload: MAG('rifle', 'rifle.bolt'), empty: 'rifle.empty', draw: 'rifle.draw' },
  shotgun: { family: 'shotgun', brass: 'shell.hull', fire: 'shotgun.fire', reload: [], perRound: { id: 'shotgun.shell', end: 'shotgun.pump' }, cycle: { id: 'shotgun.pump', after: 0.32 }, empty: 'shotgun.empty', draw: 'shotgun.draw' },
  sniper: { family: 'sniper', brass: 'brass.tinkle', fire: 'sniper.fire', reload: MAG('sniper', 'sniper.bolt'), cycle: { id: 'sniper.bolt', after: 0.45 }, empty: 'sniper.empty', draw: 'sniper.draw' },
  lmg: { family: 'lmg', brass: 'brass.tinkle', fire: 'lmg.fire', windup: { start: 'lmg.spinup', loop: 'lmg.spin', stop: 'lmg.spindown' }, reload: MAG('lmg', null), empty: 'lmg.empty', draw: 'lmg.draw' },
  beam: { family: 'beam', fire: null, fireLoop: { start: 'beam.start', loop: 'beam.loop', stop: 'beam.stop' }, reload: [{ id: 'beam.recharge', at: 0.95 }], empty: 'beam.empty', draw: 'beam.draw' },
  rocket: { family: 'rocket', fire: 'rocket.fire', reload: [{ id: 'launcher.load', at: 0.4 }], empty: 'launcher.empty', draw: 'launcher.draw' },
  popper: { family: 'popper', fire: 'popper.fire', reload: [{ id: 'launcher.load', at: 0.3 }, { id: 'launcher.load', at: 0.7 }], empty: 'launcher.empty', draw: 'launcher.draw' },
  flame: { family: 'flame', fire: null, fireLoop: { start: 'flame.start', loop: 'flame.loop', stop: 'flame.stop' }, reload: [], empty: 'flame.empty', draw: 'flame.draw' },
  ripper: { family: 'ripper', fire: 'ripper.fire', windup: { start: 'ripper.charge' }, reload: [{ id: 'charge.load', at: 0.4 }], empty: 'charge.empty', draw: 'charge.draw' },
  pulse: { family: 'pulse', fire: 'pulse.fire', windup: { start: 'pulse.charge' }, reload: [{ id: 'charge.load', at: 0.4 }], empty: 'charge.empty', draw: 'charge.draw' },
  melee: { family: 'melee', fire: null, reload: [], empty: 'melee.draw', draw: 'melee.draw' },
};

/** The family a weapon belongs to, by id first (the specials), then by class. */
export function familyOf(def: Pick<WeaponDef, 'id' | 'class' | 'fireMode'>): Family {
  switch (def.id) {
    case 'thumper':
      return 'rocket';
    case 'popper':
      return 'popper';
    case 'dragon':
      return 'flame';
    case 'ripper':
      return 'ripper';
    case 'pulse':
      return 'pulse';
    case 'arc':
      return 'beam';
    case 'shredder':
      return 'lmg';
  }
  switch (def.class) {
    case 'sidearm':
      return 'pistol';
    case 'smg':
      return 'smg';
    case 'rifle':
      return 'rifle';
    case 'dmr':
    case 'sniper':
      return 'sniper';
    case 'shotgun':
      return 'shotgun';
    case 'melee':
      return 'melee';
    case 'heavy':
      return def.fireMode === 'spinup' ? 'lmg' : 'rocket';
    case 'special':
      return def.fireMode === 'beam' ? 'beam' : 'pulse';
  }
}

/** Per gun: pitch and level on its family's sounds. */
const TUNE: Record<string, { rate?: number; gain?: number; noCycle?: boolean }> = {
  hammer44: { rate: 0.92, gain: 1 },
  hawk50: { rate: 0.8, gain: 1.05 },
  buzz: { rate: 1.08, gain: 0.9 },
  rattler: { rate: 1, gain: 0.92 },
  hornet: { rate: 1.16, gain: 0.85 },
  k47: { rate: 0.96 },
  trident: { rate: 1.06, gain: 0.95 },
  bullpup: { rate: 1.1, gain: 0.95 },
  // a DMR: the sniper's crack, lighter, and no bolt between shots
  longbow: { rate: 1.18, gain: 0.85, noCycle: true },
};

const cache = new Map<number, WeaponSounds>();

/** The sounds of weapon `index` (packages/content weapons), or null for none. */
export function weaponSounds(index: number): WeaponSounds | null {
  const hit = cache.get(index);
  if (hit) return hit;
  const def = weapons[index];
  if (!def) return null;
  const base = BASE[familyOf(def)];
  const t = TUNE[def.id] ?? {};
  const out: WeaponSounds = { ...base, rate: t.rate ?? 1, gain: t.gain ?? 1 };
  if (t.noCycle) delete out.cycle;
  cache.set(index, out);
  return out;
}

const skinned = new Map<string, WeaponSounds>();

/**
 * Weapon `index`'s sounds as a skin swaps them (`swaps`: base sound id → the skin's own, packages/content
 * weapon-skins.json `sounds`; docs/17 V11): the same steps, timings, pitch and level, other takes. An id the bank
 * doesn't have stays the base's. `key` names the skin (the cache).
 */
export function skinnedWeaponSounds(index: number, key: string, swaps: Readonly<Record<string, string>>): WeaponSounds | null {
  const ws = weaponSounds(index);
  if (!ws) return null;
  const k = `${index}|${key}`;
  const hit = skinned.get(k);
  if (hit) return hit;
  const swap = (id: SoundId): SoundId => {
    const to = swaps[id];
    return to !== undefined && isSoundId(to) ? to : id;
  };
  const out: WeaponSounds = {
    ...ws,
    fire: ws.fire && swap(ws.fire),
    reload: ws.reload.map((step) => ({ ...step, id: swap(step.id) })),
    empty: swap(ws.empty),
    draw: swap(ws.draw),
    ...(ws.cycle ? { cycle: { ...ws.cycle, id: swap(ws.cycle.id) } } : {}),
  };
  skinned.set(k, out);
  return out;
}

/** Every sound the weapons use (warmed for the guns in hand). */
export function weaponSoundIds(w: WeaponSounds): SoundId[] {
  const ids: SoundId[] = [w.empty, w.draw, ...w.reload.map((r) => r.id)];
  if (w.fire) ids.unshift(w.fire);
  if (w.fireLoop) ids.push(w.fireLoop.start, w.fireLoop.loop, w.fireLoop.stop);
  if (w.windup) ids.push(w.windup.start, ...(w.windup.loop ? [w.windup.loop] : []), ...(w.windup.stop ? [w.windup.stop] : []));
  if (w.perRound) ids.push(w.perRound.id, w.perRound.end);
  if (w.cycle) ids.push(w.cycle.id);
  if (w.brass) ids.push(w.brass);
  return [...new Set(ids)];
}

/** Projectile kinds by grenade-pool type (PROJECTILE_TYPE_BASE + index in content projectiles). */
export const PROJECTILE = { rocket: PROJECTILE_TYPE_BASE, shell: PROJECTILE_TYPE_BASE + 1, blade: PROJECTILE_TYPE_BASE + 2, orb: PROJECTILE_TYPE_BASE + 3, flame: PROJECTILE_TYPE_BASE + 4 } as const;

/** Grenade types (content grenades). */
export const GRENADE = { frag: 0, smoke: 1, gas: 2, flash: 3, mine: 4, emp: 5 } as const;

/** What a blast sounds like, by its grenade-pool type (absent: frag), and how big it is (ducking). */
export function blastSound(type: number | undefined): { id: SoundId; big: number } | null {
  switch (type ?? GRENADE.frag) {
    case GRENADE.frag:
      return { id: 'frag.explode', big: 0.7 };
    case GRENADE.smoke:
      return { id: 'smoke.pop', big: 0 };
    case GRENADE.gas:
      return { id: 'gas.pop', big: 0 };
    case GRENADE.flash:
      return { id: 'flash.bang', big: 0.6 };
    case GRENADE.mine:
      return { id: 'mine.explode', big: 0.6 };
    case GRENADE.emp:
      return { id: 'emp.burst', big: 0.35 };
    case PROJECTILE.rocket:
      return { id: 'rocket.explode', big: 0.8 };
    case PROJECTILE.shell:
      return { id: 'shell.explode', big: 0.6 };
    case PROJECTILE.orb:
      return { id: 'orb.burst', big: 0.3 };
    case PROJECTILE.blade:
      return { id: 'shell.explode', big: 0.4 }; // a blade that runs out of life bursts
    default:
      return null; // flames don't blow up
  }
}

/** A projectile's sound while it flies, by type. */
export function flightLoop(type: number): SoundId | null {
  switch (type) {
    case PROJECTILE.rocket:
      return 'rocket.flight';
    case PROJECTILE.blade:
      return 'blade.spin';
    case PROJECTILE.orb:
      return 'orb.hum';
    default:
      return null;
  }
}

/** The weapon that fires a projectile type (to find who launched one seen online). */
export function launcherOf(type: number): string | null {
  switch (type) {
    case PROJECTILE.rocket:
      return 'thumper';
    case PROJECTILE.shell:
      return 'popper';
    case PROJECTILE.blade:
      return 'ripper';
    case PROJECTILE.orb:
      return 'pulse';
    case PROJECTILE.flame:
      return 'dragon';
    default:
      return null;
  }
}
