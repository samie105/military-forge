/**
 * The game is for adults (the owner, 28 Oct 2026): the age rule the web's age step and the API's
 * account save share. Only the birth year is asked (NDPA data minimisation: no full date of birth).
 * A year that makes them under 18 all of this year is a minor for certain, and an earlier one an
 * adult. The one year the year can't settle is the year they turn 18: the age step asks those
 * players alone whether they've had that birthday yet (`turns18This`), and the API takes their
 * word as `adult: true` (audit 28 Oct: one age question, asked once).
 */
export const ADULT_AGE = 18;
/** a birth year further back than this is a typo, not a player */
export const MAX_AGE = 120;

export type BirthYearAnswer = 'adult' | 'minor' | 'invalid';

/** Born in the year they turn 18 (`year`): the year alone can't say whether they are 18 yet. */
export function turns18This(birthYear: number, year: number): boolean {
  return year - birthYear === ADULT_AGE;
}

/** What a birth year says in `year` (this year, UTC: the caller reads its clock): see the file comment. */
export function birthYearAnswer(birthYear: number, year: number): BirthYearAnswer {
  if (!Number.isInteger(birthYear) || birthYear > year || birthYear < year - MAX_AGE) return 'invalid';
  return year - birthYear < ADULT_AGE ? 'minor' : 'adult';
}
