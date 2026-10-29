import { describe, expect, it } from 'vitest';
import { birthYearAnswer, turns18This } from '../src';

describe('the 18+ rule from a birth year', () => {
  const year = 2026;

  it('a year that leaves the player under 18 all year is a minor', () => {
    expect(birthYearAnswer(2009, year)).toBe('minor');
    expect(birthYearAnswer(2026, year)).toBe('minor');
  });

  it('the year they turn 18, and before, is an adult by the year (the birthday question settles that year)', () => {
    expect(birthYearAnswer(2008, year)).toBe('adult');
    expect(birthYearAnswer(1990, year)).toBe('adult');
    expect(birthYearAnswer(1906, year)).toBe('adult');
  });

  it('only the year they turn 18 needs their word on the birthday', () => {
    expect(turns18This(2008, year)).toBe(true);
    for (const y of [2009, 2007, 1990]) expect(turns18This(y, year)).toBe(false);
  });

  it('refuses years that are not a player', () => {
    for (const bad of [2027, 1905, 1990.5, Number.NaN]) expect(birthYearAnswer(bad, year)).toBe('invalid');
  });

  it('turns over with the year', () => {
    expect(birthYearAnswer(2009, 2026)).toBe('minor');
    expect(birthYearAnswer(2009, 2027)).toBe('adult');
  });
});
