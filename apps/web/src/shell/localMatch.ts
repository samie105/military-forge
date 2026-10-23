/**
 * Local-mode match rules: a deathmatch against the bots (three Normal ones by default; localBots.ts),
 * then results and Play again.
 * URL overrides for playtests and screenshots: ?time=<s>&kills=<n>&countdown=<s> (0 turns a limit
 * off); ?sandbox is free play with no match.
 */
import { DEATHMATCH_RULES, defaultKillLimit, type MatchRules } from '@military-forge/sim';

/** Shorter than a room's match (a warm-up); nobody else votes, so a missed rematch returns to the warm-up, not a close. */
export const LOCAL_MATCH_RULES: Partial<MatchRules> = { timeLimit: 300, killLimit: 10, onNoRematch: 'lobby' };

const LIMITS: Record<'time' | 'kills' | 'countdown', [keyof MatchRules, number]> = {
  time: ['timeLimit', 1200],
  kills: ['killLimit', 100],
  countdown: ['countdown', DEATHMATCH_RULES.countdown * 2],
};

/** Live fire (the onboarding's first match for a recruit, §3.2): first to 5 kills, or 3 minutes. */
export const LIVE_FIRE_RULES: Partial<MatchRules> = { ...LOCAL_MATCH_RULES, timeLimit: 180, killLimit: 5 };

export function localMatchRules(params: URLSearchParams): Partial<MatchRules> | null {
  if (params.has('sandbox')) return null;
  const rules: Partial<MatchRules> = { ...LOCAL_MATCH_RULES };
  for (const [param, [key, max]] of Object.entries(LIMITS)) {
    const value = Number(params.get(param) ?? NaN);
    if (Number.isFinite(value)) Object.assign(rules, { [key]: Math.min(max, Math.max(0, Math.round(value))) });
  }
  // team modes (v21): `?teams=2|3|4` plays a team match against the bots (their kill limit unless ?kills=)
  const teams = Number(params.get('teams'));
  if (teams === 2 || teams === 3 || teams === 4) {
    rules.teams = teams;
    if (!params.has('kills')) rules.killLimit = defaultKillLimit(teams);
  }
  return rules;
}
