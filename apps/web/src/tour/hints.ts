/**
 * Contextual hints (docs/design/onboarding-research.md §3.6), the pure engine: signals from play go in
 * (a death and its cause, a fall out of fuel, damage, a spawn, the match starting), at most one hint
 * comes out when it may be shown. The rules, all here and unit-tested:
 * - one hint per life; none in the first 5 s after a spawn; none within 3 s of taking or dealing damage;
 *   none in the countdown;
 * - each hint at most its Max, ever on this device (the counts persist: `mf.hints.v1`);
 * - "Don't show tips" turns them all off.
 * Hints never blame: "The middle kills", not "You keep dying to gas". The runtime is tour/hintsRun.ts.
 */
import type { ActionId } from '../shell/controls';
import type { Facts } from './facts';
import type { DeathCause } from './log';

export type HintId = 'gas' | 'fuel' | 'dash' | 'grenade' | 'own-grenade';

export interface HintDef {
  id: HintId;
  title: string;
  body: string;
  /** the keys after the body (the player's own) */
  keys: readonly ActionId[];
  /** the HUD plate it rings (`data-tour`), if any */
  hud: 'fuel' | 'dash' | 'belt' | null;
  /** at most this many times, ever */
  max: number;
}

export const HINTS: Readonly<Record<HintId, HintDef>> = {
  gas: { id: 'gas', title: 'Gas.', body: 'The middle kills. Cross the edge fast, or fly over.', keys: [], hud: null, max: 2 },
  fuel: { id: 'fuel', title: 'Fuel.', body: 'Refills on the ground, faster than in the air.', keys: [], hud: 'fuel', max: 2 },
  dash: { id: 'dash', title: 'Dash.', body: 'Dodges fire. Costs fuel.', keys: ['dash'], hud: 'dash', max: 2 },
  grenade: { id: 'grenade', title: 'Grenade.', body: 'Tap to throw, hold to aim.', keys: ['grenade'], hud: 'belt', max: 2 },
  'own-grenade': { id: 'own-grenade', title: 'Hold to aim.', body: 'The arc shows where it lands.', keys: ['grenade'], hud: 'belt', max: 1 },
};

export const SPAWN_QUIET_S = 5;
export const DAMAGE_QUIET_S = 3;
/** a hint shows this long unless done first (it never blocks play) */
export const HINT_SHOW_MS = 7000;
export const HINTS_KEY = 'mf.hints.v1';

export interface HintMemory {
  counts: Partial<Record<HintId, number>>;
  off: boolean;
}

export class HintEngine {
  private pending: HintId[] = [];
  private spawnAt = -Infinity;
  private damageAt = -Infinity;
  private shownThisLife = false;
  private alive = false;
  private countdown = false;
  private gasDeaths = 0;
  private fuelFalls = 0;

  constructor(readonly memory: HintMemory = { counts: {}, off: false }) {}

  private want(id: HintId): void {
    if (this.memory.off || (this.memory.counts[id] ?? 0) >= HINTS[id].max || this.pending.includes(id)) return;
    this.pending.push(id);
  }

  /** A match begins (GO): the per-match counts restart; moves never used across 2+ matches are wanted. */
  matchStart(f: Facts): void {
    this.gasDeaths = 0;
    this.fuelFalls = 0;
    const played = f.matches.local + f.matches.online;
    if (played >= 2 && f.moves.dash === 0) this.want('dash');
    if (played >= 2 && f.moves.grenade === 0) this.want('grenade');
  }

  setCountdown(on: boolean): void {
    this.countdown = on;
  }

  spawn(t: number): void {
    this.alive = true;
    this.spawnAt = t;
    this.shownThisLife = false;
  }

  damage(t: number): void {
    this.damageAt = t;
  }

  death(cause: DeathCause): void {
    this.alive = false;
    if (cause === 'gas' && ++this.gasDeaths >= 2) this.want('gas');
    if (cause === 'self') this.want('own-grenade');
  }

  /** Out of fuel in the air, falling (once per fall: the caller sends it on the change). */
  fuelOut(): void {
    if (++this.fuelFalls >= 2) this.want('fuel');
  }

  /** A move was used: a hint about it is no longer wanted. */
  used(id: HintId): void {
    this.pending = this.pending.filter((p) => p !== id);
  }

  /** The hint to show now (and counted as shown), or null. */
  next(t: number): HintDef | null {
    if (this.memory.off || !this.pending.length || !this.alive || this.countdown || this.shownThisLife) return null;
    if (t - this.spawnAt < SPAWN_QUIET_S || t - this.damageAt < DAMAGE_QUIET_S) return null;
    const id = this.pending.shift()!;
    this.shownThisLife = true;
    this.memory.counts[id] = (this.memory.counts[id] ?? 0) + 1;
    return HINTS[id];
  }
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

export function loadHintMemory(storage: KeyValue | null): HintMemory {
  try {
    const v = JSON.parse(storage?.getItem(HINTS_KEY) ?? 'null') as Partial<HintMemory> | null;
    return { counts: typeof v?.counts === 'object' && v.counts ? { ...v.counts } : {}, off: v?.off === true };
  } catch {
    return { counts: {}, off: false };
  }
}

export function saveHintMemory(storage: KeyValue | null, m: HintMemory): void {
  try {
    storage?.setItem(HINTS_KEY, JSON.stringify(m));
  } catch {
    /* private mode */
  }
}
