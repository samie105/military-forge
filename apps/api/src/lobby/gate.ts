/**
 * Who may type their own words in the Lobby (free text). Nobody while CHAT_FREE_TEXT is off (the
 * default): the feed takes quick chat only, and GET /lobby says `freeText.on: false` so the web shows
 * no text box. With it on, a player needs all of:
 *
 * - 18+ (the whole feed is adults only: adultsOnly on every /lobby route);
 * - an account 24 hours old with 3 online matches, or a saved account (email);
 * - the chat rules accepted once (POST /lobby/rules, users.chat_rules_at).
 *
 * The slow mode and the repeat check are the same as quick chat's (routes.ts); the words go through
 * filter.ts.
 */
import { and, count, eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { ALL_WEAPONS, identities, statsLifetime, users } from '../db/schema';

export const FREE_TEXT_MIN_AGE_MS = 24 * 3_600_000;
export const FREE_TEXT_MIN_MATCHES = 3;

/** What a player still needs before they may type: `account` (24 h and 3 matches, or a saved account), `rules`. */
export type FreeTextNeed = 'account' | 'rules';

export interface FreeTextGate {
  /** CHAT_FREE_TEXT: off, nobody types and the web shows no box */
  on: boolean;
  allowed: boolean;
  needs: FreeTextNeed[];
}

export async function freeTextGate(db: Db, config: Pick<Config, 'chat'>, userId: string, now: number): Promise<FreeTextGate> {
  if (!config.chat.freeText) return { on: false, allowed: false, needs: [] };
  const [[user], [saved], [stats]] = await Promise.all([
    db.select({ createdAt: users.createdAt, minor: users.minor, rulesAt: users.chatRulesAt }).from(users).where(eq(users.id, userId)),
    db.select({ n: count() }).from(identities).where(and(eq(identities.userId, userId), eq(identities.provider, 'email'))),
    db.select({ matches: statsLifetime.matches }).from(statsLifetime).where(and(eq(statsLifetime.userId, userId), eq(statsLifetime.weaponId, ALL_WEAPONS))),
  ]);
  if (!user || user.minor) return { on: true, allowed: false, needs: [] };
  const needs: FreeTextNeed[] = [];
  const seasoned = now - user.createdAt.getTime() >= FREE_TEXT_MIN_AGE_MS && (stats?.matches ?? 0) >= FREE_TEXT_MIN_MATCHES;
  if (!seasoned && !(saved && saved.n > 0)) needs.push('account');
  if (!user.rulesAt) needs.push('rules');
  return { on: true, allowed: needs.length === 0, needs };
}
