/**
 * The 18+ step (the owner, 28 Oct 2026: Military Forge is for adults). Asked once on this device,
 * before its first online room (create, join, watch, a local room: controller.ts), and sent again
 * with "Save your account", where the API checks it (apps/api auth/accountRoutes.ts). Training
 * against bots is not asked.
 *
 * Kept on this device only, and only what the rule needs: the birth year and when it was given,
 * never a date of birth (NDPA data minimisation). An under-18 answer is kept too, so the step
 * doesn't just ask again until another year comes back.
 */
import { MAX_AGE, birthYearAnswer } from '@military-forge/shared';

export const AGE_KEY = 'mf.age.v1';

export type AgeRecord = { adult: true; birthYear: number; at: number } | { adult: false; at: number };

/** for browsers that refuse localStorage: this visit only */
let memory: AgeRecord | null = null;

function parse(raw: string | null): AgeRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<{ adult: unknown; birthYear: unknown; at: unknown }>;
    const at = typeof r.at === 'number' ? r.at : 0;
    if (r.adult === false) return { adult: false, at };
    if (r.adult === true && typeof r.birthYear === 'number' && birthYearAnswer(r.birthYear, new Date().getUTCFullYear()) === 'adult') return { adult: true, birthYear: r.birthYear, at };
  } catch {
    /* not ours */
  }
  return null;
}

/** What this device answered, or null: not asked yet. */
export function ageOnDevice(): AgeRecord | null {
  try {
    return parse(localStorage.getItem(AGE_KEY));
  } catch {
    return memory;
  }
}

/** This device said 18 or older. */
export const adultOnDevice = (): boolean => ageOnDevice()?.adult === true;

/**
 * The player's answer: their birth year, and that they are 18 or older. 'invalid' = a year that
 * isn't a player's (a typo: asked again); otherwise the record kept (adult or not).
 */
export function answerAge(birthYear: number, now = Date.now()): AgeRecord | 'invalid' {
  const answer = birthYearAnswer(birthYear, new Date(now).getUTCFullYear());
  if (answer === 'invalid') return 'invalid';
  const record: AgeRecord = answer === 'adult' ? { adult: true, birthYear, at: now } : { adult: false, at: now };
  try {
    localStorage.setItem(AGE_KEY, JSON.stringify(record));
  } catch {
    memory = record;
  }
  return record;
}

/**
 * Years for the birth-year picker, newest first. Neutral (docs/10 §7): young years are in the list
 * too and nothing is picked, so the list never hints which answer gets in.
 */
export function birthYears(now = Date.now()): number[] {
  const year = new Date(now).getUTCFullYear();
  return Array.from({ length: MAX_AGE - 4 }, (_, i) => year - 5 - i);
}
