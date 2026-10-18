/**
 * The Armory's stats card: rows read from packages/content (damage, fire rate, range, weight…).
 * Pure functions, so the card is testable without a renderer. Weapons that only exist as art
 * so far get `null` and the card says so.
 */
import { FRAG, RIOT_SHIELD, defaultTuning, shotDamage, timeToKill, weapons, type GrenadeDef, type ShieldDef, type WeaponDef } from '@military-forge/content';

export interface StatRow {
  label: string;
  value: string;
  /** 0..1 bar fill, comparable across weapons; omitted = no bar */
  bar?: number;
}

export interface StatsCard {
  title: string;
  subtitle: string;
  rows: StatRow[];
}

/** grenades with a blast (GrenadeDef is a union by effect since grenade variety: smoke, gas, … have no explosion) */
type BlastGrenade = GrenadeDef & { effect: 'explode' };
const grenades: readonly BlastGrenade[] = [FRAG];

const round = (v: number, digits = 1) => Number(v.toFixed(digits)).toString();
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function weaponDef(id: string): WeaponDef | undefined {
  return weapons.find((w) => w.id === id);
}

function weaponCard(def: WeaponDef): StatsCard {
  const hp = defaultTuning.healthMax;
  const melee = def.fireMode === 'melee';
  const ttk = timeToKill(def, hp);
  const perShot = shotDamage(def);
  const rpm = Math.round(60 / def.interval);
  const rows: StatRow[] = [
    {
      label: melee ? 'Damage per swing' : 'Damage per shot',
      value: def.pellets > 1 ? `${perShot} (${def.pellets} × ${def.damage})` : `${perShot}`,
      bar: clamp01(perShot / hp),
    },
    { label: melee ? 'Swings per minute' : 'Fire rate', value: `${rpm} rpm${melee ? '' : ` · ${def.fireMode}`}`, bar: clamp01(rpm / 900) },
    {
      label: 'Range',
      value: melee ? `${round(def.range)} m reach` : `${round(def.range, 0)} m (falloff from ${round(def.falloffStart, 0)} m)`,
      bar: clamp01(def.range / 60),
    },
    { label: `Time to kill (${hp} HP)`, value: `${ttk.shots} ${ttk.shots === 1 ? 'hit' : 'hits'} · ${round(ttk.seconds, 2)} s`, bar: clamp01(1 - ttk.seconds / 2) },
    { label: 'Move speed', value: `${Math.round(def.moveSpeedMul * 100)} %`, bar: clamp01((def.moveSpeedMul - 0.6) / 0.45) },
  ];
  if (!melee) {
    rows.push(
      { label: 'Magazine', value: `${def.mag} / ${def.reserve}` },
      { label: 'Reload', value: `${round(def.reload, 2)} s` },
      { label: 'Zoom', value: `up to ${def.zoomMax}×` },
    );
  }
  return { title: def.name, subtitle: `${def.class} · ${def.hands === 2 ? 'two-handed' : 'one-handed'}`, rows };
}

function grenadeCard(def: BlastGrenade): StatsCard {
  const e = def.explosion;
  return {
    title: def.id === 'frag' ? 'Frag grenade' : def.id,
    subtitle: 'thrown',
    rows: [
      { label: 'Max damage', value: `${e.maxDamage}`, bar: clamp01(e.maxDamage / defaultTuning.healthMax) },
      { label: 'Blast radius', value: `${round(e.radius)} m (full damage within ${round(e.core)} m)`, bar: clamp01(e.radius / 6) },
      { label: 'Launch', value: `${e.impulse} m/s at the centre`, bar: clamp01(e.impulse / 30) },
      { label: 'Fuse', value: `${round(def.fuse)} s` },
      { label: 'Carried', value: `${def.spawnCount} (max ${def.maxCount})` },
    ],
  };
}

function shieldCard(def: ShieldDef): StatsCard {
  return {
    title: def.name,
    subtitle: 'off-hand shield',
    rows: [
      { label: 'Shield HP', value: `${def.hp}`, bar: clamp01(def.hp / (2 * defaultTuning.healthMax)) },
      { label: 'Blocks', value: `bullets within ±${def.arcDeg}° of its face` },
      { label: 'Raise', value: `${round(def.raiseTime, 2)} s` },
      { label: 'Move speed', value: `${Math.round(def.moveSpeedMul * 100)} % raised · ${Math.round(def.slungSpeedMul * 100)} % slung`, bar: clamp01((def.moveSpeedMul - 0.6) / 0.45) },
      { label: 'Bash', value: `${def.bashDamage}` },
      { label: 'Ricochet', value: `keeps ${Math.round(def.ricochetDamageMul * 100)} % of the damage` },
    ],
  };
}

/** The card for an art weapon id, or null when packages/content has no entry for it yet. */
export function statsCard(id: string): StatsCard | null {
  const w = weaponDef(id);
  if (w) return weaponCard(w);
  if (id === RIOT_SHIELD.id) return shieldCard(RIOT_SHIELD);
  const g = grenades.find((d) => d.id === id);
  return g ? grenadeCard(g) : null;
}
