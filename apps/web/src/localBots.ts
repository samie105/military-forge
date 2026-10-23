/**
 * Bots in local play (packages/bots): `?bots=<n>` (0–12) and `?botlevel=easy|normal|hard`. The
 * local match plays three Normal bots by default; the sandbox (`?sandbox`) keeps the range dummies
 * unless `?bots` asks for bots. Bots replace the dummies.
 */
import { botLevel, type BotLevelId } from '@military-forge/bots';

export interface LocalBots {
  count: number;
  level: BotLevelId;
}

export const MAX_LOCAL_BOTS = 12;

/** Live fire (the onboarding's first match for a recruit): 3 Easy bots (the owner's default, §8.1). */
export const LIVE_FIRE_BOTS: LocalBots = { count: 3, level: 'easy' };

export function localBots(params: URLSearchParams, matchMode: boolean): LocalBots | null {
  const raw = params.get('bots');
  const count = raw === null ? (matchMode ? 3 : 0) : Math.round(Number(raw));
  if (!Number.isFinite(count) || count <= 0) return null;
  return { count: Math.min(MAX_LOCAL_BOTS, count), level: botLevel(params.get('botlevel')).id };
}
