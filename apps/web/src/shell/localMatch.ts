/**
 * Local-mode match rules: a deathmatch against the range dummies, then results and Play again.
 * URL overrides for playtests and screenshots: ?time=<s>&kills=<n>&countdown=<s> (0 turns a limit
 * off); ?sandbox is free play with no match.
 */
import { DEATHMATCH_RULES, type MatchRules } from '@military-forge/sim';

/** The dummies never shoot back, so the local match is shorter than a real one; nobody else votes, so no close. */
export const LOCAL_MATCH_RULES: Partial<MatchRules> = { timeLimit: 300, killLimit: 10, onNoRematch: 'lobby' };

const LIMITS: Record<'time' | 'kills' | 'countdown', [keyof MatchRules, number]> = {
  time: ['timeLimit', 1200],
  kills: ['killLimit', 100],
  countdown: ['countdown', DEATHMATCH_RULES.countdown * 2],
};

export function localMatchRules(params: URLSearchParams): Partial<MatchRules> | null {
  if (params.has('sandbox')) return null;
  const rules: Partial<MatchRules> = { ...LOCAL_MATCH_RULES };
  for (const [param, [key, max]] of Object.entries(LIMITS)) {
    const value = Number(params.get(param) ?? NaN);
    if (Number.isFinite(value)) Object.assign(rules, { [key]: Math.min(max, Math.max(0, Math.round(value))) });
  }
  return rules;
}
