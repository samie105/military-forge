/**
 * Bot difficulty tiers (docs/08 §9: reaction 250–600 ms, aim error, jetpack competence). The feel
 * targets they're tuned to are in NOTES §23 and checked by `pnpm --filter @military-forge/bots feel`.
 */

export type BotLevelId = 'easy' | 'normal' | 'hard';

export interface BotLevel {
  id: BotLevelId;
  label: string;
  /** seconds from first seeing a target to the first shot at it */
  reaction: number;
  /** seconds: how fast the aim catches up with where it wants to be (time constant) */
  aimLag: number;
  /** fastest aim turn, rad/s */
  turnRate: number;
  /** aim wobble at the target, metres: a slow drift (1σ) and a fast tremor (1σ) */
  aimError: number;
  aimJitter: number;
  /** wobble × this while the bot itself moves fast, and again for a target moving fast across the aim */
  moveError: number;
  /** how much of a moving target's velocity it leads, × its reaction time */
  lead: number;
  /** fires only while the aim is within this × the target's half-width of its centre */
  fireCone: number;
  /** automatic weapons: shots per burst (0 = hold the trigger) and the pause between bursts, s */
  burst: number;
  burstPause: number;
  /** falls back to cover below this HP, until it has regenerated past `recoverHp` */
  retreatHp: number;
  recoverHp: number;
  /** chance to dash away when hit (the dash cooldown and fuel permitting) */
  dodge: number;
  /** 0 never throws … 1 throws whenever a throw is good */
  grenades: number;
  /** keeps moving in a fight: strafes, and jet-hops if `hops` */
  strafe: number;
  hops: boolean;
  /** swaps to the loaded gun instead of reloading in a fight */
  quickSwap: boolean;
  /** jetpack skill: avoids routes that need more than this fraction of a full tank */
  jetSkill: number;
  /** sees this fraction of the human view rect */
  view: number;
}

export const BOT_LEVELS: Readonly<Record<BotLevelId, BotLevel>> = {
  easy: {
    id: 'easy',
    label: 'Easy',
    reaction: 0.6,
    aimLag: 0.28,
    turnRate: 5,
    aimError: 1.3,
    aimJitter: 1.8,
    moveError: 1.5,
    lead: 0,
    fireCone: 4.5,
    burst: 0,
    burstPause: 0,
    retreatHp: 20,
    recoverHp: 60,
    dodge: 0.1,
    grenades: 0.15,
    strafe: 0.3,
    hops: false,
    quickSwap: false,
    jetSkill: 0.7,
    view: 0.85,
  },
  normal: {
    id: 'normal',
    label: 'Normal',
    reaction: 0.4,
    aimLag: 0.16,
    turnRate: 8,
    aimError: 0.8,
    aimJitter: 1.0,
    moveError: 1.4,
    lead: 0.5,
    fireCone: 3.2,
    burst: 6,
    burstPause: 0.6,
    retreatHp: 35,
    recoverHp: 80,
    dodge: 0.35,
    grenades: 0.5,
    strafe: 0.7,
    hops: true,
    quickSwap: false,
    jetSkill: 0.9,
    view: 1,
  },
  hard: {
    id: 'hard',
    label: 'Hard',
    reaction: 0.25,
    aimLag: 0.09,
    turnRate: 12,
    aimError: 0.35,
    aimJitter: 0.4,
    moveError: 1.3,
    lead: 0.9,
    fireCone: 1.8,
    burst: 8,
    burstPause: 0.2,
    retreatHp: 40,
    recoverHp: 85,
    dodge: 0.6,
    grenades: 0.9,
    strafe: 1,
    hops: true,
    quickSwap: true,
    jetSkill: 1,
    view: 1,
  },
};

/** `?botlevel=` and replay specs: unknown values fall back to Normal. */
export function botLevel(id: string | null | undefined): BotLevel {
  return id && Object.hasOwn(BOT_LEVELS, id) ? BOT_LEVELS[id as BotLevelId] : BOT_LEVELS.normal;
}
