/**
 * Recording a finished match (docs/07 §12): one transaction writes the match, each person's line,
 * their lifetime stats and their XP. Keyed by the game server's match id, so a report that comes
 * twice (a retry, a replay) is recorded once. Only accounts that exist and are active get rows;
 * bots never reach here (the game server leaves them out) and an unknown id is skipped.
 */
import { levelForXp, xpForMatch } from '@military-forge/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { ALL_WEAPONS, matchPlayers, matches, profiles, statsLifetime, users } from '../db/schema';
import type { MatchReportBody } from './report';

export interface RecordedPlayer {
  userId: string;
  xpGained: number;
  xp: number;
  level: number;
}

export interface RecordResult {
  /** false: this match id was already recorded, nothing changed */
  recorded: boolean;
  players: RecordedPlayer[];
}

export async function recordMatch(db: Db, report: MatchReportBody, now: () => number): Promise<RecordResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(matches)
      .values({
        id: report.matchId,
        mode: report.mode,
        map: report.map,
        room: report.room,
        startedAt: new Date(report.startedAt),
        endedAt: new Date(report.endedAt),
        durationS: report.durationS,
        serverBuild: report.serverBuild,
        result: report,
        recordedAt: new Date(now()),
      })
      .onConflictDoNothing()
      .returning({ id: matches.id });
    if (inserted.length === 0) return { recorded: false, players: [] };

    // one line per account (the best placement if a report somehow names one twice), active accounts only
    const lines = new Map<string, MatchReportBody['players'][number]>();
    for (const p of report.players) if (!lines.has(p.userId) || lines.get(p.userId)!.placement > p.placement) lines.set(p.userId, p);
    const ids = [...lines.keys()];
    const active = ids.length
      ? new Set((await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.status, 'active')))).map((r) => r.id))
      : new Set<string>();

    const out: RecordedPlayer[] = [];
    for (const [userId, p] of lines) {
      if (!active.has(userId)) continue;
      const finished = !p.left;
      const xpGained = xpForMatch(p);
      await tx.insert(matchPlayers).values({
        matchId: report.matchId,
        userId,
        placement: p.placement,
        score: p.score,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        damage: p.damageDealt,
        damageTaken: p.damageTaken,
        headshots: p.headshots,
        bestStreak: p.bestStreak,
        left: p.left,
        mvp: p.mvp,
        xpGained,
      });
      const totals = {
        matches: 1,
        wins: finished && p.placement === 1 ? 1 : 0,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        damage: p.damageDealt,
        headshots: p.headshots,
        bestStreak: p.bestStreak,
        playtimeS: finished ? report.durationS : 0,
      };
      const s = statsLifetime;
      await tx
        .insert(s)
        .values({ userId, weaponId: ALL_WEAPONS, ...totals })
        .onConflictDoUpdate({
          target: [s.userId, s.weaponId],
          set: {
            matches: sql`${s.matches} + ${totals.matches}`,
            wins: sql`${s.wins} + ${totals.wins}`,
            kills: sql`${s.kills} + ${totals.kills}`,
            deaths: sql`${s.deaths} + ${totals.deaths}`,
            assists: sql`${s.assists} + ${totals.assists}`,
            damage: sql`${s.damage} + ${totals.damage}`,
            headshots: sql`${s.headshots} + ${totals.headshots}`,
            bestStreak: sql`greatest(${s.bestStreak}, ${totals.bestStreak})`,
            playtimeS: sql`${s.playtimeS} + ${totals.playtimeS}`,
          },
        });
      for (const [source, kills] of Object.entries(p.killsBy)) {
        if (source === ALL_WEAPONS || kills <= 0) continue;
        await tx
          .insert(s)
          .values({ userId, weaponId: source, kills })
          .onConflictDoUpdate({ target: [s.userId, s.weaponId], set: { kills: sql`${s.kills} + ${kills}` } });
      }
      const [row] = await tx
        .update(profiles)
        .set({ xp: sql`${profiles.xp} + ${xpGained}` })
        .where(eq(profiles.userId, userId))
        .returning({ xp: profiles.xp });
      if (!row) continue;
      const level = levelForXp(row.xp);
      await tx.update(profiles).set({ level }).where(eq(profiles.userId, userId));
      out.push({ userId, xpGained, xp: row.xp, level });
    }
    return { recorded: true, players: out };
  });
}
