/**
 * Old sign-in records are deleted (bot check, 30 Oct): without this, expired sessions and emailed
 * links stayed in Postgres for good.
 *
 * - `sessions` (auth/sessions.ts): deleted 7 days after they expired, or 7 days after they were
 *   revoked (signed out, a password change, a replayed refresh token).
 * - `email_tokens` (auth/accounts.ts, the "Save my account" and reset links): deleted 7 days after
 *   they expired, or 7 days after they were used (or replaced, or cancelled).
 *
 * The 7 days keep the recent ones for working out what happened to a player's sign-in. Nothing else
 * is touched here: guest accounts, matches, logs and play stats keep the retention they have.
 *
 * index.ts runs the sweep every hour (and once soon after the API starts), in batches so a big backlog
 * never holds a long lock, and logs what went. It never throws out of the timer.
 */
import { inArray, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { emailTokens, sessions } from '../db/schema';
import type { Logger } from '../log';

/** how long an expired, revoked or used record stays before the sweep deletes it */
export const KEEP_ENDED_MS = 7 * 24 * 3_600_000;
/** how often index.ts runs the sweep */
export const RETENTION_SWEEP_EVERY_MS = 60 * 60_000;
/** rows deleted per statement */
export const RETENTION_BATCH = 500;
/** batches per table per run: the rest waits for the next run */
const MAX_BATCHES = 200;

export interface SweepResult {
  sessions: number;
  emailLinks: number;
}

/** Deletes in batches of `batch` until none are left (or MAX_BATCHES); returns how many went. */
async function deleteInBatches(run: () => Promise<number>, batch: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await run();
    total += n;
    if (n < batch) break;
  }
  return total;
}

/** One sweep: the sessions and emailed links that ended more than KEEP_ENDED_MS before `now`. */
export async function sweepEndedSignIns(db: Db, now: number, batch = RETENTION_BATCH): Promise<SweepResult> {
  const cutoff = new Date(now - KEEP_ENDED_MS);
  const sessionCount = await deleteInBatches(async () => {
    const old = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(or(lt(sessions.expiresAt, cutoff), lt(sessions.revokedAt, cutoff)))
      .limit(batch);
    const gone = await db.delete(sessions).where(inArray(sessions.id, old)).returning({ id: sessions.id });
    return gone.length;
  }, batch);
  const linkCount = await deleteInBatches(async () => {
    const old = db
      .select({ id: emailTokens.id })
      .from(emailTokens)
      .where(or(lt(emailTokens.expiresAt, cutoff), lt(emailTokens.usedAt, cutoff)))
      .limit(batch);
    const gone = await db.delete(emailTokens).where(inArray(emailTokens.id, old)).returning({ id: emailTokens.id });
    return gone.length;
  }, batch);
  return { sessions: sessionCount, emailLinks: linkCount };
}

/** A sweep for the timer: logs what went (or why it failed), never throws. */
export async function runRetentionSweep(db: Db, now: number, log: Logger): Promise<SweepResult | null> {
  try {
    const result = await sweepEndedSignIns(db, now);
    if (result.sessions || result.emailLinks) log.info({ retention: 'sweep', ...result }, 'old sessions and email links deleted');
    return result;
  } catch (err) {
    log.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, 'retention sweep failed');
    return null;
  }
}

/** Starts the hourly sweep (index.ts): the first run a minute after start. The timers don't keep the process up. */
export function startRetentionSweep(db: Db, log: Logger, now: () => number = Date.now): () => void {
  const run = () => void runRetentionSweep(db, now(), log);
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, RETENTION_SWEEP_EVERY_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
