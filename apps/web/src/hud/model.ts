/**
 * The HUD's numbers, as pure functions of the frame, the tuning and recent events, so they're
 * testable without a DOM. hud.ts turns them into elements.
 */
import { FRAG, HitZone, NO_WEAPON, RIOT_SHIELD, pickups as pickupDefs, weapons, type Tuning } from '@military-forge/content';
import { DamageSource, type SimEvent } from '@military-forge/sim';
import type { PickupView, PlayerView, WeaponView } from '../view';
import { nearbyWeaponPrompt, takePrompt, weaponUnderfoot } from '../weaponItems';

/**
 * What arsenal-b's PlayerView adds (#40 grenade belt, #44 flashbang, #47 EMP grenade; see
 * arsenal-b-interfaces.md). Absent until those land: the HUD reads them when they're there.
 */
export interface ArsenalFields {
  /** the selected grenade type (cycled with Btn.CycleGrenade) */
  grenadeType: number;
  /** grenades carried, by type: 0 frag, 1 smoke, 2 gas, 3 flashbang, 4 mine, 5 EMP */
  grenadeCounts: readonly number[];
  /** flashbang blindness 0..1 */
  blind: number;
  /** ticks of toxic-gas cough left */
  gasTicks: number;
  /** ticks the EMP grenade keeps the jetpack dead */
  jetDisabledTicks: number;
}

export type HudPlayer = PlayerView & Partial<ArsenalFields>;

export interface FeedEntry {
  key: number;
  killer: string;
  victim: string;
  /** what did it: a weapon name, "melee", "frag", "fell" */
  how: string;
  headshot: boolean;
  suicide: boolean;
  /** this player was in it */
  mine: 'killer' | 'victim' | null;
}

export function damageSourceName(source: number): string {
  if (source === DamageSource.Grenade) return 'frag';
  if (source === DamageSource.World) return 'fell';
  if (source === DamageSource.Melee) return 'melee';
  return weapons[source]?.name ?? '?';
}

/**
 * Kill-feed lines from one batch of sim events (deaths, with the headshot from a head hit on the
 * same victim earlier in the batch). `nextKey` numbers them for the DOM.
 */
export function feedFromEvents(events: readonly SimEvent[], localId: number, names: ReadonlyMap<number, string>, nextKey: () => number): FeedEntry[] {
  const headHit = new Set<number>();
  const out: FeedEntry[] = [];
  const name = (id: number) => (id < 0 ? 'world' : (names.get(id) ?? `Player ${id + 1}`));
  for (const e of events) {
    if (e.type === 'hit') {
      if (e.zone === HitZone.Head) headHit.add(e.target);
      else headHit.delete(e.target);
    } else if (e.type === 'death') {
      const suicide = e.killer === e.victim || e.killer < 0;
      out.push({
        key: nextKey(),
        killer: suicide ? name(e.victim) : name(e.killer),
        victim: name(e.victim),
        how: damageSourceName(e.source),
        headshot: headHit.has(e.victim) && !suicide,
        suicide,
        mine: e.killer === localId && !suicide ? 'killer' : e.victim === localId ? 'victim' : null,
      });
    }
  }
  return out;
}

/**
 * Screen angle (radians, 0 = right, clockwise: screen y points down) from `me` to a world point.
 * The damage arc points this way.
 */
export function screenAngle(me: { x: number; y: number }, at: { x: number; y: number }): number {
  return Math.atan2(-(at.y - me.y), at.x - me.x);
}

export interface HealthView {
  /** 0..1 */
  fill: number;
  hp: number;
  /** seconds until regeneration starts (0 when it runs or isn't needed) */
  regenIn: number;
  regenerating: boolean;
  low: boolean;
}

/**
 * Health with the regen delay (docs/03: `healthRegenDelay` after the last hit, then
 * `healthRegen` HP/s). `sinceHitS` = seconds since this player last took damage.
 */
export function healthView(hp: number, t: Pick<Tuning, 'healthMax' | 'healthRegenDelay'>, sinceHitS: number): HealthView {
  const fill = Math.max(0, Math.min(1, hp / t.healthMax));
  const hurt = hp > 0 && hp < t.healthMax;
  const regenIn = hurt ? Math.max(0, t.healthRegenDelay - sinceHitS) : 0;
  return { fill, hp: Math.max(0, Math.ceil(hp)), regenIn, regenerating: hurt && regenIn === 0, low: fill <= 0.35 };
}

export interface FuelView {
  /** 0..1 */
  fill: number;
  /** 0..1 of the bar: the regen delay still to run, drawn right after the fill */
  delay: number;
  /** 0..1 position of the minimum fuel to ignite */
  ignite: number;
  /** below the ignite threshold: the jetpack won't start */
  empty: boolean;
}

/**
 * Fuel with its regen-delay segment: while `fuelRegenDelay` ticks run (local mode and the
 * predicted player online), a segment after the fill shows how much delay is left.
 */
export function fuelView(p: Pick<PlayerView, 'fuel' | 'fuelRegenDelay' | 'grounded'>, t: Pick<Tuning, 'fuelMax' | 'fuelMinIgnite' | 'fuelRegenDelayGround' | 'fuelRegenDelayAir'>): FuelView {
  const fill = Math.max(0, Math.min(1, p.fuel / t.fuelMax));
  const full = (p.grounded ? t.fuelRegenDelayGround : t.fuelRegenDelayAir) * 60;
  const delay = p.fuelRegenDelay > 0 && full > 0 && fill < 1 ? Math.min(1 - fill, 0.25 * Math.min(1, p.fuelRegenDelay / full)) : 0;
  return { fill, delay, ignite: Math.min(1, t.fuelMinIgnite / t.fuelMax), empty: p.fuel < t.fuelMinIgnite };
}

export interface WeaponCard {
  def: number;
  name: string;
  melee: boolean;
  mag: number;
  reserve: number;
  /** reload progress 0..1, or -1 when not reloading */
  reload: number;
  /** held (or both, dual-wielding) */
  active: boolean;
  /** a heavy weapon's speed multiplier (1 = none) */
  speed: number;
  lowAmmo: boolean;
}

export function weaponCards(p: Pick<PlayerView, 'weapons' | 'active' | 'dual'>): WeaponCard[] {
  return p.weapons.flatMap((w: WeaponView, i): WeaponCard[] => {
    if (w.def === NO_WEAPON) return [];
    const def = weapons[w.def];
    if (!def) return [];
    const melee = def.fireMode === 'melee';
    const total = def.reload * 60;
    return [
      {
        def: w.def,
        name: def.name,
        melee,
        mag: w.mag,
        reserve: w.reserve,
        reload: w.reloadTicks > 0 && total > 0 ? Math.max(0, Math.min(1, 1 - w.reloadTicks / total)) : -1,
        active: p.dual || i === p.active,
        speed: def.moveSpeedMul,
        lowAmmo: !melee && w.mag <= Math.max(1, Math.floor(def.mag * 0.2)),
      },
    ];
  });
}

export interface ScoreRow {
  key: number;
  name: string;
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  /** ms, -1 = unknown (local mode, or not reported yet) */
  ping: number;
  you: boolean;
  host: boolean;
  bot: boolean;
  left: boolean;
}

// ---- riot shield, dash, conditions, grenade belt, pickups (docs/02 §21, docs/03 §9, §12, §14) ----

export type ShieldState = 'none' | 'slung' | 'raising' | 'up';

export interface ShieldStatus {
  state: ShieldState;
  hp: number;
  /** 0..1 of a fresh shield */
  fill: number;
}

/** The riot shield as the HUD names it: up (guarding the front), slung (the back), raising, none. */
export function shieldStatus(p: Pick<PlayerView, 'shield' | 'shieldHp'>): ShieldStatus {
  const hp = Math.max(0, Math.ceil(p.shieldHp ?? 0));
  if (!p.shield || hp <= 0) return { state: 'none', hp: 0, fill: 0 };
  const state: ShieldState = p.shield === 'front' ? 'up' : p.shield === 'back' ? 'slung' : 'raising';
  return { state, hp, fill: Math.min(1, hp / RIOT_SHIELD.hp) };
}

export interface DashStatus {
  /** ready; cooldown (recharging); spent (this flight's air dash is used; back on landing) */
  state: 'ready' | 'cooldown' | 'spent';
  /** 0..1 of the cooldown still to run */
  fill: number;
  /** seconds of cooldown left */
  seconds: number;
}

export function dashStatus(p: Pick<PlayerView, 'dashCooldown' | 'airDashUsed' | 'grounded'>, t: Pick<Tuning, 'dashCooldown'>): DashStatus {
  const left = Math.max(0, p.dashCooldown ?? 0);
  const total = t.dashCooldown * 60;
  const fill = total > 0 ? Math.min(1, left / total) : 0;
  if (left > 0) return { state: 'cooldown', fill, seconds: left / 60 };
  return { state: p.airDashUsed && !p.grounded ? 'spent' : 'ready', fill: 0, seconds: 0 };
}

export interface Conditions {
  /** the jetpack is dead: an EMP zone or storm (map), or the EMP grenade's lockout */
  emp: boolean;
  /** seconds of the EMP grenade's lockout left; 0 = the map's EMP (as long as you stay in it) */
  empSeconds: number;
  /** flashbang blindness 0..1 */
  blind: number;
  inGas: boolean;
}

export function conditions(p: HudPlayer): Conditions {
  const lockout = Math.max(0, p.jetDisabledTicks ?? 0);
  return {
    emp: !!p.jetDisabled || lockout > 0,
    empSeconds: lockout / 60,
    blind: Math.max(0, Math.min(1, p.blind ?? 0)),
    inGas: (p.gasTicks ?? 0) > 0,
  };
}

/** The grenade belt's types (arsenal-b's content `grenades`, by type id); frags only until #40 lands. */
export const BELT: readonly { id: string; name: string; max: number }[] = [
  { id: 'frag', name: 'Frag', max: FRAG.maxCount },
  { id: 'smoke', name: 'Smoke', max: 2 },
  { id: 'gas', name: 'Gas', max: 2 },
  { id: 'flash', name: 'Flash', max: 2 },
  { id: 'mine', name: 'Mine', max: 2 },
  { id: 'emp', name: 'EMP', max: 2 },
];

export interface BeltSlot {
  id: string;
  name: string;
  count: number;
  max: number;
  selected: boolean;
  /** this build has the type (arsenal-b's belt), so the slot shows */
  present: boolean;
}

export function grenadeBelt(p: HudPlayer): BeltSlot[] {
  const counts = p.grenadeCounts;
  const selected = p.grenadeType ?? 0;
  return BELT.map((b, i) => {
    const present = counts ? i < counts.length : i === 0;
    const count = counts ? (counts[i] ?? 0) : i === 0 ? p.frags : 0;
    return { ...b, count, selected: present && i === selected, present };
  });
}

/** Within this far (m) of an item you're told how to take it. */
export const PICKUP_PROMPT_RANGE = 3;

/**
 * "Riot Shield: walk over to take" when an item lies close by, the nearest first; '' when none.
 * Weapon crates (more guns): standing on a gun you don't hold, `[E] take Widow (swaps your
 * Hammer .44)`; close by, how to take it, or that walking over it is ammo for one you hold.
 */
export function pickupPrompt(me: Pick<PlayerView, 'x' | 'y' | 'alive'> & Partial<Pick<PlayerView, 'weapons' | 'active'>>, items: readonly PickupView[] | undefined): string {
  if (!me.alive || !items?.length) return '';
  const held = { weapons: me.weapons ?? [], active: me.active ?? 0 };
  const under = weaponUnderfoot(items, { x: me.x, y: me.y, weapons: held.weapons });
  if (under && !under.held) return takePrompt(under, held);
  let best: PickupView | null = null;
  let bestD = PICKUP_PROMPT_RANGE;
  for (const k of items) {
    const d = Math.hypot(k.x - me.x, (k.y - me.y) * 0.75);
    if (d <= bestD) {
      best = k;
      bestD = d;
    }
  }
  const def = best ? pickupDefs[best.def] : undefined;
  if (def?.kind === 'weapon') return nearbyWeaponPrompt(def, held);
  return def ? `${def.name}: walk over to take` : '';
}
