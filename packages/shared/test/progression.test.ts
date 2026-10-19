import { describe, expect, it } from 'vitest';
import { MATCH_XP_CAP, MAX_LEVEL, levelForXp, levelProgress, xpForLevel, xpForMatch } from '../src/progression';

describe('xpForMatch', () => {
  it('pays for finishing, kills, assists and the podium; a leaver keeps only kills and assists', () => {
    expect(xpForMatch({ kills: 0, assists: 0, placement: 4, left: false })).toBe(100);
    expect(xpForMatch({ kills: 7, assists: 2, placement: 1, left: false })).toBe(100 + 70 + 10 + 50);
    expect(xpForMatch({ kills: 3, assists: 0, placement: 3, left: false })).toBe(100 + 30 + 25);
    expect(xpForMatch({ kills: 3, assists: 1, placement: 1, left: true })).toBe(35);
    expect(xpForMatch({ kills: -2, assists: 0, placement: 8, left: true })).toBe(0);
    expect(xpForMatch({ kills: 500, assists: 0, placement: 1, left: false })).toBe(MATCH_XP_CAP);
  });
});

describe('levels', () => {
  it('level L needs 50·L·(L−1) XP in all', () => {
    expect([1, 2, 3, 4, 10, 50].map(xpForLevel)).toEqual([0, 100, 300, 600, 4500, 122_500]);
    expect([0, 99, 100, 299, 300, 4499, 4500].map(levelForXp)).toEqual([1, 1, 2, 2, 3, 9, 10]);
    expect(levelForXp(1e12)).toBe(MAX_LEVEL);
    for (let l = 1; l <= MAX_LEVEL; l++) expect(levelForXp(xpForLevel(l))).toBe(l);
  });

  it('progress inside a level', () => {
    expect(levelProgress(350)).toEqual({ level: 3, xpIntoLevel: 50, xpForNextLevel: 300 });
    expect(levelProgress(xpForLevel(MAX_LEVEL) + 5)).toEqual({ level: MAX_LEVEL, xpIntoLevel: 5, xpForNextLevel: 0 });
  });
});
