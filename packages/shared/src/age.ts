/**
 * The game is for adults (the owner, 28 Oct 2026): the age rule the web's age step and the API's
 * account save share. Only the birth year is asked (NDPA data minimisation: no full date of birth),
 * with the player's "I am 18 or older": a year that makes them under 18 all of this year is a
 * minor for certain; the year they turn 18 is settled by their own answer.
 */
export const ADULT_AGE = 18;
/** a birth year further back than this is a typo, not a player */
export const MAX_AGE = 120;

export type BirthYearAnswer = 'adult' | 'minor' | 'invalid';

/** What a birth year says in `year` (this year, UTC: the caller reads its clock): see the file comment. */
export function birthYearAnswer(birthYear: number, year: number): BirthYearAnswer {
  if (!Number.isInteger(birthYear) || birthYear > year || birthYear < year - MAX_AGE) return 'invalid';
  return year - birthYear < ADULT_AGE ? 'minor' : 'adult';
}
