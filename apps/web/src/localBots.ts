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

export function localBots(params: URLSearchParams, matchMode: boolean): LocalBots | null {
  const raw = params.get('bots');
  const count = raw === null ? (matchMode ? 3 : 0) : Math.round(Number(raw));
  if (!Number.isFinite(count) || count <= 0) return null;
  return { count: Math.min(MAX_LOCAL_BOTS, count), level: botLevel(params.get('botlevel')).id };
}
