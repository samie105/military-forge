/**
 * The 18+ step (the owner, 28 Oct 2026: Military Forge is for adults). One question, asked once on
 * this device: by the age gate before its first online room (create, join, watch, a local room:
 * controller.ts), or by "Save your account" or the store's claim when the player gets there first
 * (they show the same question: AgeGate.tsx's AgeQuestion). The answer kept here is what a save
 * or a claim sends, so the API (auth/accountRoutes.ts) checks it without asking again. Training
 * against bots is not asked.
 *
 * Kept on this device only, and only what the rule needs: the birth year and when it was given,
 * never a date of birth (NDPA data minimisation). A player born in the year they turn 18 also says
 * whether they've had that birthday (`turned18`). An under-18 answer is kept too, so the step
 * doesn't just ask again until another year comes back.
 */
import { MAX_AGE, birthYearAnswer, turns18This } from '@military-forge/shared';

export const AGE_KEY = 'mf.age.v1';

/** `turned18`: born the year they turn 18, and said they've had that birthday (only then) */
export type AgeRecord = { adult: true; birthYear: number; at: number; turned18?: true } | { adult: false; at: number };

/** for browsers that refuse localStorage: this visit only */
let memory: AgeRecord | null = null;

function parse(raw: string | null): AgeRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<{ adult: unknown; birthYear: unknown; at: unknown; turned18: unknown }>;
    const at = typeof r.at === 'number' ? r.at : 0;
    if (r.adult === false) return { adult: false, at };
    const year = new Date().getUTCFullYear();
    if (r.adult === true && typeof r.birthYear === 'number' && birthYearAnswer(r.birthYear, year) === 'adult') {
      // the year they turn 18 without their word on the birthday (a record from before it was asked): ask again
      if (!turns18This(r.birthYear, year)) return { adult: true, birthYear: r.birthYear, at };
      if (r.turned18 === true) return { adult: true, birthYear: r.birthYear, at, turned18: true };
    }
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

/** The year picked is the year they turn 18: the question also asks about the birthday. */
export const asksBirthday = (birthYear: number, now = Date.now()): boolean => turns18This(birthYear, new Date(now).getUTCFullYear());

/**
 * The player's answer: their birth year, and (only for the year they turn 18) whether they've had
 * that birthday. 'invalid' = not an answer yet: a year that isn't a player's (a typo), or that
 * year without the birthday answered (asked again); otherwise the record kept (adult or not).
 */
export function answerAge(birthYear: number, now = Date.now(), turned18?: boolean): AgeRecord | 'invalid' {
  const answer = birthYearAnswer(birthYear, new Date(now).getUTCFullYear());
  if (answer === 'invalid') return 'invalid';
  let record: AgeRecord;
  if (answer === 'minor') record = { adult: false, at: now };
  else if (!asksBirthday(birthYear, now)) record = { adult: true, birthYear, at: now };
  else if (turned18 === undefined) return 'invalid';
  else record = turned18 ? { adult: true, birthYear, at: now, turned18: true } : { adult: false, at: now };
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
