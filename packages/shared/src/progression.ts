/**
 * Player XP and levels (docs/07 §12): the one rule the API applies to match results and any
 * client shows. Kept deliberately simple, and documented there.
 *
 * XP for a match (people only; bots earn nothing):
 *   +100 for playing a match to the end (not for leaving early)
 *   +10 per kill, +5 per assist
 *   +50 for 1st place, +25 for 2nd or 3rd (only when the match was played to the end)
 *   capped at 1000 per match
 *
 * Levels: reaching level L takes 50 × L × (L − 1) XP in all, so each level costs 100 × (L − 1)
 * more than the last: level 2 at 100 XP, level 3 at 300, level 4 at 600, level 10 at 4,500,
 * level 50 at 122,500. The level stops at MAX_LEVEL.
 */

export const MAX_LEVEL = 100;
export const MATCH_XP_CAP = 1000;

export interface MatchXpInput {
  kills: number;
  assists: number;
  /** 1-based */
  placement: number;
  /** left before the match ended */
  left: boolean;
}

export function xpForMatch(p: MatchXpInput): number {
  let xp = 10 * Math.max(0, p.kills) + 5 * Math.max(0, p.assists);
  if (!p.left) {
    xp += 100;
    if (p.placement === 1) xp += 50;
    else if (p.placement === 2 || p.placement === 3) xp += 25;
  }
  return Math.min(MATCH_XP_CAP, Math.round(xp));
}

/** Total XP needed to reach `level` (1 → 0). */
export function xpForLevel(level: number): number {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return 50 * l * (l - 1);
}

/** The level a total of `xp` reaches. */
export function levelForXp(xp: number): number {
  // largest L with 50·L·(L−1) ≤ xp
  const l = Math.floor((1 + Math.sqrt(1 + (4 * Math.max(0, xp)) / 50)) / 2);
  let level = Math.max(1, Math.min(MAX_LEVEL, l));
  while (level < MAX_LEVEL && xpForLevel(level + 1) <= xp) level++;
  while (level > 1 && xpForLevel(level) > xp) level--;
  return level;
}

/** Progress inside the current level, for a bar: XP earned since it, and the XP the next level needs (0 at MAX_LEVEL). */
export function levelProgress(xp: number): { level: number; xpIntoLevel: number; xpForNextLevel: number } {
  const level = levelForXp(xp);
  if (level >= MAX_LEVEL) return { level, xpIntoLevel: xp - xpForLevel(level), xpForNextLevel: 0 };
  return { level, xpIntoLevel: xp - xpForLevel(level), xpForNextLevel: xpForLevel(level + 1) - xpForLevel(level) };
}
