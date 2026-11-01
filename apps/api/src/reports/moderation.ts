/**
 * The owner's moderation (audit-2 L-04), on the admin page (Authorization: Bearer ADMIN_TOKEN):
 *
 *   GET  /admin/moderation/reports?open=1          player reports, newest first (200 at most), with who,
 *                                                  about whom, when, where, why; + { open, last24h } counts
 *   GET  /admin/moderation/players?q=              find an account by id or nickname
 *   GET  /admin/moderation/players/:id             the account, the reports about it, the actions taken
 *   POST /admin/moderation/players/:id { action, reason, hours? }
 *        rename      a generated guest name; they may pick a new one at once (the change cooldown resets)
 *        suspend     no online play (no sign-in, no session) for `hours` (1–720, default 24), then it's back
 *        ban         no online play, for good (until unban)
 *        unban       active again
 *        dismiss     nothing against the account: its open reports are closed
 *        clear_minor the under-18 mark goes (a wrong answer the player asked to correct)
 *        close       the account is deleted (an under-18 account, or the owner's call): name, friends,
 *                    progress; its reports and this log stay
 *        chat_mute   no Lobby messages for `hours` (1–720, default 24); the player sees it, with the
 *                    reason and the end time (GET /lobby)
 *        chat_unmute the chat mute ends now
 *        delete_message  `message` (a Lobby message of theirs) is deleted for everyone; its words stay
 *                    in this log's detail and in the reports' snapshots
 *
 * Suspend and ban use users.status 'banned' (with banned_until for a suspension) and the session check
 * every request already makes (auth/sessions.ts), so they take effect on the player's next request. The
 * sessions are kept: a guest can't sign in again, so its account comes back when a suspension ends.
 * Every action, with its reason, goes in moderation_audit; rename, suspend, ban, dismiss and close also
 * close the account's open reports with that action.
 */
import { and, count, desc, eq, gt, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Config } from '../config';
import { isUniqueViolation, type Db } from '../db/client';
import { chatMutes, identities, moderationAudit, playerReports, profiles, users } from '../db/schema';
import { messageText } from '../lobby/feed';
import { USER_ID } from '../friends/service';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import type { ProfileService } from '../me/profiles';
import { randomGuestNickname } from '../nickname/rules';
import { ownerOnly } from './routes';

export const MODERATION_ACTIONS = ['rename', 'suspend', 'ban', 'unban', 'dismiss', 'clear_minor', 'close', 'chat_mute', 'chat_unmute', 'delete_message'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
/** these close the account's open reports */
const CLOSES_REPORTS: ReadonlySet<ModerationAction> = new Set(['rename', 'suspend', 'ban', 'dismiss', 'close', 'chat_mute', 'delete_message']);
export const SUSPEND_MAX_HOURS = 720;
const RENAME_ATTEMPTS = 8;

const ActionBody = z.strictObject({
  action: z.enum(MODERATION_ACTIONS),
  reason: z.string().trim().min(1).max(200),
  hours: z.number().int().min(1).max(SUSPEND_MAX_HOURS).optional(),
  /** delete_message: the Lobby message's id */
  message: z.string().regex(/^\d{1,18}$/).optional(),
});

/** What moderation needs from the Lobby feed (lobby/feed.ts LobbyFeed). */
export interface ChatModeration {
  message(id: number): Promise<{ id: number; kind: string; authorId: string | null; quick: string | null; body: string | null; createdAt: Date; hiddenAt: Date | null } | null>;
  remove(id: number): Promise<boolean>;
}

export interface ModerationDeps {
  config: Config;
  db: Db;
  profiles: ProfileService;
  now: () => number;
  /** these players' friends lists changed (a rename, a closed account): the push channel */
  touched?: (userIds: readonly string[]) => void;
  /** their friends, so a rename or a closed account reaches the friends' lists */
  friendIds?: (userId: string) => Promise<string[]>;
  /** the Lobby feed: delete_message */
  chat?: ChatModeration;
}

export function adminModerationRoutes(deps: ModerationDeps): Hono<AppEnv> {
  const { config, db, now } = deps;
  const names = deps.profiles;
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    ownerOnly(c, config.adminToken);
    await next();
  });

  const iso = (d: Date | null) => d?.toISOString() ?? null;

  async function player(id: string) {
    const [u] = await db
      .select({
        id: users.id,
        status: users.status,
        bannedUntil: users.bannedUntil,
        minor: users.minor,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        nickname: profiles.nickname,
        level: profiles.level,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, id));
    if (!u) return null;
    const suspended = u.status === 'banned' && u.bannedUntil !== null && u.bannedUntil.getTime() > now();
    const standing = u.status === 'banned' ? (u.bannedUntil === null ? 'banned' : suspended ? 'suspended' : 'active') : u.status;
    const [mute] = await db.select({ until: chatMutes.until, reason: chatMutes.reason }).from(chatMutes).where(eq(chatMutes.userId, id));
    const chatMute = mute && mute.until.getTime() > now() ? { until: mute.until.toISOString(), reason: mute.reason } : null;
    return { ...u, standing, chatMute, createdAt: u.createdAt.toISOString(), lastSeenAt: u.lastSeenAt.toISOString(), bannedUntil: suspended ? iso(u.bannedUntil) : null };
  }

  /** Reports as the page lists them: who, about whom (then and now), when, where, why. */
  async function reportRows(where: SQL | undefined, limit: number) {
    const reporter = alias(profiles, 'reporter');
    const target = alias(profiles, 'target');
    const rows = await db
      .select({
        id: playerReports.id,
        at: playerReports.createdAt,
        reason: playerReports.reason,
        note: playerReports.note,
        room: playerReports.room,
        place: playerReports.place,
        handledAt: playerReports.handledAt,
        action: playerReports.action,
        messageId: playerReports.messageId,
        snapshot: playerReports.snapshot,
        reporterId: playerReports.reporterId,
        reporterName: reporter.nickname,
        targetId: playerReports.targetId,
        targetName: playerReports.targetName,
        targetNow: target.nickname,
        targetStatus: users.status,
        targetUntil: users.bannedUntil,
        targetMinor: users.minor,
      })
      .from(playerReports)
      .leftJoin(reporter, eq(reporter.userId, playerReports.reporterId))
      .leftJoin(target, eq(target.userId, playerReports.targetId))
      .leftJoin(users, eq(users.id, playerReports.targetId))
      .where(where)
      .orderBy(desc(playerReports.createdAt), desc(playerReports.id))
      .limit(limit);
    const targets = [...new Set(rows.map((r) => r.targetId))];
    const open = targets.length
      ? await db
          .select({ id: playerReports.targetId, n: count() })
          .from(playerReports)
          .where(and(inArray(playerReports.targetId, targets), isNull(playerReports.handledAt)))
          .groupBy(playerReports.targetId)
      : [];
    const openOf = new Map(open.map((o) => [o.id, o.n]));
    return rows.map((r) => {
      const standing =
        r.targetStatus === null ? 'deleted' : r.targetStatus === 'banned' ? (r.targetUntil === null ? 'banned' : r.targetUntil.getTime() > now() ? 'suspended' : 'active') : r.targetStatus;
      return {
        id: r.id,
        at: r.at.toISOString(),
        reason: r.reason,
        note: r.note,
        room: r.room,
        place: r.place,
        handledAt: iso(r.handledAt),
        action: r.action,
        message: r.messageId === null ? null : { id: String(r.messageId), snapshot: r.snapshot },
        reporter: { id: r.reporterId, nickname: r.reporterName },
        target: {
          id: r.targetId,
          name: r.targetName,
          nickname: r.targetNow,
          standing,
          until: standing === 'suspended' ? iso(r.targetUntil) : null,
          minor: r.targetMinor ?? false,
          open: openOf.get(r.targetId) ?? 0,
        },
      };
    });
  }

  app.get('/reports', async (c) => {
    const onlyOpen = c.req.query('open') === '1';
    const [reports, [openRow], [dayRow]] = await Promise.all([
      reportRows(onlyOpen ? isNull(playerReports.handledAt) : undefined, 200),
      db.select({ n: count() }).from(playerReports).where(isNull(playerReports.handledAt)),
      db.select({ n: count() }).from(playerReports).where(gt(playerReports.createdAt, new Date(now() - 86_400_000))),
    ]);
    return c.json({ open: openRow?.n ?? 0, last24h: dayRow?.n ?? 0, reports });
  });

  app.get('/players', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json({ players: [] });
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await db
      .selectDistinct({ id: users.id, nickname: profiles.nickname, level: profiles.level, status: users.status })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .leftJoin(identities, and(eq(identities.userId, users.id), eq(identities.provider, 'email')))
      .where(or(eq(users.id, q), ilike(profiles.nickname, like), eq(identities.providerUid, q.toLowerCase())))
      .limit(20);
    return c.json({ players: rows });
  });

  const idParam = (raw: string) => {
    if (!USER_ID.test(raw)) throw new ApiError(400, 'invalid_player_id', 'Not a player id');
    return raw;
  };

  async function history(id: string) {
    const [p, reports, [by], audit] = await Promise.all([
      player(id),
      reportRows(eq(playerReports.targetId, id), 100),
      db.select({ n: count() }).from(playerReports).where(eq(playerReports.reporterId, id)),
      db.select().from(moderationAudit).where(eq(moderationAudit.userId, id)).orderBy(desc(moderationAudit.id)).limit(100),
    ]);
    return {
      player: p,
      reports,
      reportsBy: by?.n ?? 0,
      audit: audit.map((a) => ({ id: a.id, at: a.at.toISOString(), actor: a.actor, action: a.action, reason: a.reason, detail: a.detail })),
    };
  }

  app.get('/players/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const h = await history(id);
    // a closed account: only its reports and the log are left
    if (!h.player && !h.reports.length && !h.audit.length) throw new ApiError(404, 'not_found', 'No such account');
    return c.json(h);
  });

  /** A generated name nobody has (the player may choose a new one at once). */
  async function rename(id: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      if (attempt > RENAME_ATTEMPTS * 4) throw new Error('no free generated name');
      const pick = names.policy.check(randomGuestNickname());
      if (!pick.ok) continue;
      if ((await names.takenNorms([pick.norm])).has(pick.norm)) continue;
      try {
        await db.update(profiles).set({ nickname: pick.nickname, nicknameNorm: pick.norm, nicknameChangedAt: null }).where(eq(profiles.userId, id));
        return pick.nickname;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= RENAME_ATTEMPTS) throw err;
      }
    }
  }

  app.post('/players/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = await readJson(c, ActionBody);
    const before = await player(id);
    if (!before) throw new ApiError(404, 'not_found', 'No such account');
    const at = new Date(now());
    const detail: Record<string, unknown> = { before: { nickname: before.nickname, standing: before.standing, until: before.bannedUntil, minor: before.minor } };
    const friends = body.action === 'rename' || body.action === 'close' ? ((await deps.friendIds?.(id)) ?? []) : [];
    // delete_message: theirs, and still there (checked before anything changes)
    const msg = body.action === 'delete_message' ? (body.message !== undefined && deps.chat ? await deps.chat.message(Number(body.message)) : null) : null;
    if (body.action === 'delete_message' && (!msg || msg.kind !== 'chat' || msg.authorId !== id)) throw new ApiError(404, 'message_not_found', 'No such message from this player');

    switch (body.action) {
      case 'rename':
        detail.nickname = await rename(id);
        break;
      case 'suspend': {
        const hours = body.hours ?? 24;
        const until = new Date(at.getTime() + hours * 3_600_000);
        await db.update(users).set({ status: 'banned', bannedUntil: until }).where(eq(users.id, id));
        Object.assign(detail, { hours, until: until.toISOString() });
        break;
      }
      case 'ban':
        await db.update(users).set({ status: 'banned', bannedUntil: null }).where(eq(users.id, id));
        break;
      case 'unban':
        await db.update(users).set({ status: 'active', bannedUntil: null }).where(eq(users.id, id));
        break;
      case 'clear_minor':
        await db.update(users).set({ minor: false }).where(eq(users.id, id));
        break;
      case 'dismiss':
        break;
      case 'close':
        await db.delete(users).where(eq(users.id, id));
        break;
      case 'chat_mute': {
        const hours = body.hours ?? 24;
        const until = new Date(at.getTime() + hours * 3_600_000);
        await db
          .insert(chatMutes)
          .values({ userId: id, until, reason: body.reason, at })
          .onConflictDoUpdate({ target: chatMutes.userId, set: { until, reason: body.reason, at } });
        Object.assign(detail, { hours, until: until.toISOString() });
        break;
      }
      case 'chat_unmute':
        await db.delete(chatMutes).where(eq(chatMutes.userId, id));
        break;
      case 'delete_message':
        detail.message = { id: String(msg!.id), at: msg!.createdAt.toISOString(), quick: msg!.quick, text: messageText(msg!.quick, msg!.body), hidden: msg!.hiddenAt !== null };
        await deps.chat!.remove(msg!.id);
        break;
    }
    if (CLOSES_REPORTS.has(body.action)) {
      await db
        .update(playerReports)
        .set({ handledAt: at, action: body.action })
        .where(and(eq(playerReports.targetId, id), isNull(playerReports.handledAt)));
    }
    await db.insert(moderationAudit).values({ at, actor: 'owner', action: body.action, userId: id, reason: body.reason, detail });
    if (friends.length) deps.touched?.([...friends, ...(body.action === 'rename' ? [id] : [])]);
    c.get('log').info({ userId: id, action: body.action }, 'moderation action');
    return c.json(await history(id));
  });

  return app;
}
