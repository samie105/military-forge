/**
 * Old sign-in records are deleted (auth/retention.ts; bot check, 30 Oct): sessions and emailed links
 * 7 days after they expired, were revoked or were used; never anything else. Runs on the test
 * database the other tests use (PGlite, or TEST_DATABASE_URL's Postgres).
 */
import { eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from '../src/auth/accounts';
import { KEEP_ENDED_MS, runRetentionSweep, sweepEndedSignIns } from '../src/auth/retention';
import type { Db } from '../src/db/client';
import { emailTokens, sessions, users } from '../src/db/schema';
import { createGuest, createTestApi, type TestApi } from './helpers';

const DAY = 24 * 3_600_000;

describe('the retention sweep', () => {
  let api: TestApi;
  let db: Db;
  beforeAll(async () => {
    api = await createTestApi();
    db = api.database.db;
  });
  afterAll(() => api.close());

  /** a guest and its session row, with the session's dates set as given */
  async function sessionWith(dates: { expiresAt: number; revokedAt?: number }) {
    const guest = await createGuest(api);
    const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, guest.user.id));
    await db
      .update(sessions)
      .set({ expiresAt: new Date(dates.expiresAt), revokedAt: dates.revokedAt === undefined ? null : new Date(dates.revokedAt) })
      .where(eq(sessions.id, row!.id));
    return { userId: guest.user.id, sessionId: row!.id };
  }

  async function linkWith(userId: string, dates: { expiresAt: number; usedAt?: number }) {
    const accounts = new AccountService(db, api.clock.now);
    const token = await accounts.createToken(userId, 'reset', 30 * 60_000);
    const id = token.split('.')[0]!;
    await db
      .update(emailTokens)
      .set({ expiresAt: new Date(dates.expiresAt), usedAt: dates.usedAt === undefined ? null : new Date(dates.usedAt) })
      .where(eq(emailTokens.id, id));
    return id;
  }

  const sessionIds = async (ids: string[]) => (await db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, ids))).map((r) => r.id).sort();
  const linkIds = async (ids: string[]) => (await db.select({ id: emailTokens.id }).from(emailTokens).where(inArray(emailTokens.id, ids))).map((r) => r.id).sort();

  it('deletes sessions 7 days after they expired or were revoked, keeps the rest and every account', async () => {
    const now = api.clock.now();
    const expiredLong = await sessionWith({ expiresAt: now - 8 * DAY });
    const expiredRecent = await sessionWith({ expiresAt: now - 6 * DAY });
    const revokedLong = await sessionWith({ expiresAt: now + 30 * DAY, revokedAt: now - 8 * DAY });
    const revokedRecent = await sessionWith({ expiresAt: now + 30 * DAY, revokedAt: now - 6 * DAY });
    const active = await sessionWith({ expiresAt: now + 30 * DAY });
    const all = [expiredLong, expiredRecent, revokedLong, revokedRecent, active];

    const result = await sweepEndedSignIns(db, now);
    expect(result.sessions).toBe(2);
    expect(await sessionIds(all.map((s) => s.sessionId))).toEqual([expiredRecent, revokedRecent, active].map((s) => s.sessionId).sort());
    // the guests stay, their sessions or not
    const kept = await db.select({ id: users.id }).from(users).where(inArray(users.id, all.map((s) => s.userId)));
    expect(kept).toHaveLength(all.length);
  });

  it('deletes emailed links 7 days after they expired or were used, keeps good and recent ones', async () => {
    const now = api.clock.now();
    const { userId } = await sessionWith({ expiresAt: now + 30 * DAY });
    // createToken cancels the user's older links of the kind: each gets its own user
    const owner = async () => (await sessionWith({ expiresAt: now + 30 * DAY })).userId;
    const expiredLong = await linkWith(userId, { expiresAt: now - 8 * DAY });
    const expiredRecent = await linkWith(await owner(), { expiresAt: now - DAY });
    const usedLong = await linkWith(await owner(), { expiresAt: now + DAY, usedAt: now - 8 * DAY });
    const usedRecent = await linkWith(await owner(), { expiresAt: now - 8 * DAY + KEEP_ENDED_MS, usedAt: now - DAY });
    const good = await linkWith(await owner(), { expiresAt: now + 20 * 60_000 });
    const all = [expiredLong, expiredRecent, usedLong, usedRecent, good];

    const result = await sweepEndedSignIns(db, now);
    expect(result.emailLinks).toBe(2);
    expect(await linkIds(all)).toEqual([expiredRecent, usedRecent, good].sort());
  });

  it('works in batches until nothing old is left', async () => {
    const now = api.clock.now();
    const old = await Promise.all(Array.from({ length: 5 }, () => sessionWith({ expiresAt: now - 10 * DAY })));
    expect(await sweepEndedSignIns(db, now, 2)).toEqual({ sessions: 5, emailLinks: 0 });
    expect(await sessionIds(old.map((s) => s.sessionId))).toEqual([]);
    // nothing left: a second run deletes nothing
    expect(await sweepEndedSignIns(db, now, 2)).toEqual({ sessions: 0, emailLinks: 0 });
  });

  it('logs what went, and a failure is logged, never thrown out of the timer', async () => {
    const lines: Record<string, unknown>[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
    const now = api.clock.now();
    await sessionWith({ expiresAt: now - 9 * DAY });
    expect(await runRetentionSweep(db, now, log)).toEqual({ sessions: 1, emailLinks: 0 });
    expect(lines.at(-1)).toMatchObject({ retention: 'sweep', sessions: 1, emailLinks: 0, msg: 'old sessions and email links deleted' });
    const broken = { select: () => { throw new Error('database down'); } } as unknown as Db;
    expect(await runRetentionSweep(broken, now, log)).toBeNull();
    expect(lines.at(-1)).toMatchObject({ level: 50, msg: 'retention sweep failed' });
  });
});
