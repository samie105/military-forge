/**
 * The Lobby feed's store (the contract is @military-forge/shared lobbyFeed.ts): one public channel
 * of system cards and players' quick chat.
 *
 * - Postgres `chat_messages` is the record (30 days, the retention sweep). Each line is one row; a
 *   message keeps its quick-chat id, never its words (free text, when on, keeps the filtered line).
 * - Valkey keeps the live feed as a stream (`lobby:feed`, ~500 entries): what GET /lobby reads first.
 * - Every new line goes to the open feed panels on the `lobby` topic (events/bus.ts).
 *
 * A read takes the newest lines from the stream and checks them against Postgres in one query: a line
 * whose row has gone (Delete my data cascades, the owner's delete) or was hidden (reports) is left out,
 * and names come from the players' profiles now, so a rename (the owner's included) shows everywhere.
 * With a stream shorter than a page (a fresh Valkey, a quiet feed) it reads Postgres instead. Lines from or about a player the
 * reader blocked, or who blocked them, are left out too.
 *
 * Bots are never people here: match results count them apart, and a match a bot won names no winner.
 *
 * Rooms' Post to Lobby (rooms/routes.ts) calls `publish(event)`: the posted room becomes a
 * room_posted card like any other. `recent` and `subscribe` are the posted rooms alone, for code that
 * wants just those.
 */
import { LEVEL_CARD_EVERY, LOBBY_CHANNEL, LOBBY_FEED_TTL_MS, isRoomLang, isRoomTag, quickChat, type LobbyFeedEvent, type LobbyCard, type LobbyChat, type LobbyEntry, type LobbyFeedPublisher, type FightNightCard, type QuickChatId, type RoomPostedCard } from '@military-forge/shared';
import { and, countDistinct, desc, eq, gt, inArray, isNull, lt, max, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import { blocks, chatMessages, matches, playerReports, profiles, users, type ChatKind } from '../db/schema';
import type { EventBus } from '../events/bus';
import type { Kv } from '../kv/kv';
import type { Logger } from '../log';

export const FEED_KEY = 'lobby:feed';
/** entries the live stream keeps (MAXLEN ~) */
export const FEED_KEEP = 500;
/** lines a read returns at most */
export const FEED_PAGE = 100;
/** how long Postgres keeps a line (the retention sweep) */
export const CHAT_TTL_MS = 30 * 86_400_000;
/** distinct reports (from accounts older than a day) that hide a message until the owner looks */
export const HIDE_AFTER_REPORTS = 3;
export const REPORTER_MIN_AGE_MS = 86_400_000;

type StoredCard = Exclude<LobbyCard, FightNightCard>;

/** Who a card is by (author) and about (subject): blocks hide it, Delete my data removes it. */
function cardPeople(card: StoredCard): { author: string | null; subject: string | null } {
  switch (card.kind) {
    case 'room_posted':
      return { author: card.hostId ?? null, subject: null };
    case 'match_result':
      return { author: null, subject: card.winnerId };
    case 'welcome':
    case 'level_up':
      return { author: null, subject: card.playerId };
  }
}

const clampInt = (n: unknown, lo: number, hi: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo);
const short = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '');
const shortOrNull = (s: unknown, n: number) => (typeof s === 'string' && s ? s.slice(0, n) : null);

/** A card as it may be stored: known kinds only, lengths and numbers clamped (Rooms' cards come from another workstream). */
export function cleanCard(card: StoredCard): StoredCard | null {
  switch (card.kind) {
    case 'room_posted':
      return {
        kind: 'room_posted',
        code: short(card.code, 16).toUpperCase(),
        hostName: short(card.hostName, 32),
        ...(card.hostId ? { hostId: short(card.hostId, 64) } : {}),
        mode: card.mode === null ? null : clampInt(card.mode, 0, 8),
        map: shortOrNull(card.map, 64),
        people: clampInt(card.people, 0, 64),
        bots: card.bots === null ? null : clampInt(card.bots, 0, 64),
        seats: clampInt(card.seats, 0, 64),
        tag: isRoomTag(card.tag) ? card.tag : null,
        lang: isRoomLang(card.lang) ? card.lang : null,
        at: card.at,
      };
    case 'match_result':
      return { kind: 'match_result', winnerId: card.winnerId ? short(card.winnerId, 64) : null, winnerName: card.winnerId ? shortOrNull(card.winnerName, 32) : null, mode: short(card.mode, 32), map: short(card.map, 64), people: clampInt(card.people, 0, 64), bots: clampInt(card.bots, 0, 64), at: card.at };
    case 'welcome':
      return { kind: 'welcome', playerId: short(card.playerId, 64), name: short(card.name, 32), at: card.at };
    case 'level_up':
      return { kind: 'level_up', playerId: short(card.playerId, 64), name: short(card.name, 32), level: clampInt(card.level, 1, 1000), at: card.at };
    default:
      return null;
  }
}

/** The words a reader sees for a stored message. */
export function messageText(quick: string | null, body: string | null): string {
  if (quick) return quickChat(quick)?.text ?? '';
  return body ?? '';
}

export class LobbyFeed implements LobbyFeedPublisher {
  constructor(
    private readonly db: Db,
    private readonly kv: Kv,
    private readonly bus: EventBus,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {}

  /** A system card (Rooms' room_posted, match results, welcomes, level-ups). Never throws: a failure is logged and dropped. */
  async post(card: StoredCard): Promise<LobbyEntry | null> {
    try {
      const clean = cleanCard(card);
      if (!clean) return null;
      const { author, subject } = cardPeople(clean);
      const at = new Date(this.now());
      const [row] = await this.db
        .insert(chatMessages)
        .values({ kind: clean.kind as ChatKind, authorId: author, subjectId: subject, card: clean as unknown as Record<string, unknown>, createdAt: at })
        .returning({ id: chatMessages.id });
      const entry = { ...clean, at: at.toISOString(), id: String(row!.id) } as LobbyEntry;
      await this.spread(entry);
      return entry;
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err), kind: card.kind }, 'lobby card not posted');
      return null;
    }
  }

  /** Rooms' Post to Lobby: the posted room as a room_posted card (its `at` becomes the server's time). */
  async publish(event: LobbyFeedEvent): Promise<void> {
    const { at: _at, ...rest } = event;
    await this.post({ ...rest, at: new Date(this.now()).toISOString() });
  }

  /** The rooms posted in the last LOBBY_FEED_TTL_MS, newest first (every reader's; blocks aren't applied here). */
  async recent(limit = 50): Promise<LobbyFeedEvent[]> {
    const rows = await this.db
      .select({ card: chatMessages.card, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(and(eq(chatMessages.kind, 'room_posted'), isNull(chatMessages.hiddenAt), gt(chatMessages.createdAt, new Date(this.now() - LOBBY_FEED_TTL_MS))))
      .orderBy(desc(chatMessages.id))
      .limit(limit);
    return rows.filter((r) => r.card).map((r) => ({ ...(r.card as unknown as RoomPostedCard), at: r.createdAt.getTime() }));
  }

  /** New posted rooms in this process (any API process's, through the topic). */
  subscribe(listener: (event: LobbyFeedEvent) => void): () => void {
    return this.bus.subscribeTopic(LOBBY_CHANNEL, (e) => {
      if (e.type !== 'entry' || e.entry.kind !== 'room_posted') return;
      const { id: _id, at, ...card } = e.entry;
      listener({ ...card, at: Date.parse(at) });
    });
  }

  /** A player's message: a quick-chat id, or free text that already passed filter.ts. */
  async say(from: { id: string; name: string }, say: { quick: QuickChatId } | { text: string }, replyTo: string | null): Promise<LobbyChat> {
    const at = new Date(this.now());
    const quick = 'quick' in say ? say.quick : null;
    const body = 'text' in say ? say.text : null;
    const [row] = await this.db
      .insert(chatMessages)
      .values({ kind: 'chat', authorId: from.id, quick, body, replyTo: replyTo ? Number(replyTo) : null, createdAt: at })
      .returning({ id: chatMessages.id });
    const entry: LobbyChat = { kind: 'chat', id: String(row!.id), at: at.toISOString(), from, quick: quick as QuickChatId | null, text: messageText(quick, body), replyTo };
    await this.spread(entry);
    return entry;
  }

  /** Into the live stream and out to the open panels (a Valkey hiccup only costs the live copy). */
  private async spread(entry: LobbyEntry): Promise<void> {
    await this.kv.xadd(FEED_KEY, JSON.stringify(entry), FEED_KEEP).catch((err: unknown) => this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'lobby stream write failed'));
    await this.bus.publishTopic(LOBBY_CHANNEL, { type: 'entry', entry }).catch((err: unknown) => this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'lobby topic publish failed'));
  }

  /** The players `viewer` blocked or who blocked them: their lines are hidden both ways. */
  async blockedBetween(viewer: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ a: blocks.userId, b: blocks.blockedId })
      .from(blocks)
      .where(or(eq(blocks.userId, viewer), eq(blocks.blockedId, viewer)));
    return new Set(rows.map((r) => (r.a === viewer ? r.b : r.a)));
  }

  /** Whether `viewer` should see `entry` (the live topic's filter; reads filter in Postgres). */
  static visibleTo(entry: LobbyEntry, hidden: ReadonlySet<string>): boolean {
    if (entry.kind === 'chat') return !hidden.has(entry.from.id);
    const { author, subject } = cardPeople(entry);
    return !(author && hidden.has(author)) && !(subject && hidden.has(subject));
  }

  /** The newest lines for `viewer`, oldest first. */
  async list(viewer: string, limit = FEED_PAGE): Promise<LobbyEntry[]> {
    const hidden = await this.blockedBetween(viewer);
    let live: LobbyEntry[] = [];
    try {
      live = (await this.kv.xrevrange(FEED_KEY, Math.min(FEED_KEEP, limit * 2)))
        .map((e) => {
          try {
            return JSON.parse(e.value) as LobbyEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is LobbyEntry => !!e && typeof e.id === 'string' && /^\d+$/.test(e.id));
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'lobby stream read failed');
    }
    const author = alias(profiles, 'author');
    const subject = alias(profiles, 'subject');
    const base = this.db
      .select({
        id: chatMessages.id,
        kind: chatMessages.kind,
        authorId: chatMessages.authorId,
        subjectId: chatMessages.subjectId,
        quick: chatMessages.quick,
        body: chatMessages.body,
        card: chatMessages.card,
        replyTo: chatMessages.replyTo,
        createdAt: chatMessages.createdAt,
        authorName: author.nickname,
        subjectName: subject.nickname,
      })
      .from(chatMessages)
      .leftJoin(author, eq(author.userId, chatMessages.authorId))
      .leftJoin(subject, eq(subject.userId, chatMessages.subjectId));
    const since = new Date(this.now() - CHAT_TTL_MS);
    // a stream shorter than a page (a fresh Valkey, a quiet feed) can't be the whole page: read Postgres
    const rows = live.length >= limit
      ? await base.where(and(inArray(chatMessages.id, live.map((e) => Number(e.id))), isNull(chatMessages.hiddenAt), gt(chatMessages.createdAt, since)))
      : await base.where(and(isNull(chatMessages.hiddenAt), gt(chatMessages.createdAt, since))).orderBy(desc(chatMessages.id)).limit(limit * 2);
    const out: LobbyEntry[] = [];
    for (const r of rows.sort((a, b) => a.id - b.id)) {
      if ((r.authorId && hidden.has(r.authorId)) || (r.subjectId && hidden.has(r.subjectId))) continue;
      const entry = toEntry(r);
      if (entry) out.push(entry);
    }
    return out.slice(-limit);
  }

  /** When the last online match ended (the quiet feed's "Last match 3 h ago"), or null. */
  async lastMatchAt(): Promise<string | null> {
    const [row] = await this.db.select({ at: max(matches.endedAt) }).from(matches);
    return row?.at ? new Date(row.at).toISOString() : null;
  }

  /** The newest line's id and time (Home's unread dot), skipping lines hidden or gone. */
  async head(): Promise<{ id: string | null; at: string | null }> {
    const [row] = await this.db
      .select({ id: chatMessages.id, at: chatMessages.createdAt })
      .from(chatMessages)
      .where(isNull(chatMessages.hiddenAt))
      .orderBy(desc(chatMessages.id))
      .limit(1);
    return row ? { id: String(row.id), at: row.at.toISOString() } : { id: null, at: null };
  }

  /** One stored message (reports' snapshot, the owner's delete). */
  async message(id: number) {
    const [row] = await this.db
      .select({ id: chatMessages.id, kind: chatMessages.kind, authorId: chatMessages.authorId, quick: chatMessages.quick, body: chatMessages.body, createdAt: chatMessages.createdAt, hiddenAt: chatMessages.hiddenAt, name: profiles.nickname })
      .from(chatMessages)
      .leftJoin(profiles, eq(profiles.userId, chatMessages.authorId))
      .where(eq(chatMessages.id, id));
    return row ?? null;
  }

  /** The owner's delete: the row goes, and every open panel drops the line. */
  async remove(id: number): Promise<boolean> {
    const gone = await this.db.delete(chatMessages).where(eq(chatMessages.id, id)).returning({ id: chatMessages.id });
    if (gone.length) await this.bus.publishTopic(LOBBY_CHANNEL, { type: 'remove', id: String(id) }).catch(() => {});
    return gone.length > 0;
  }

  /**
   * A report came in about message `id`: with HIDE_AFTER_REPORTS distinct reporters whose accounts are
   * a day old, it's hidden for everyone until the owner looks. Returns whether it is hidden now.
   */
  async reported(id: number): Promise<boolean> {
    const [row] = await this.db
      .select({ n: countDistinct(playerReports.reporterId) })
      .from(playerReports)
      .innerJoin(users, eq(users.id, playerReports.reporterId))
      .where(and(eq(playerReports.messageId, id), lt(users.createdAt, new Date(this.now() - REPORTER_MIN_AGE_MS))));
    if ((row?.n ?? 0) < HIDE_AFTER_REPORTS) return false;
    const hid = await this.db
      .update(chatMessages)
      .set({ hiddenAt: new Date(this.now()) })
      .where(and(eq(chatMessages.id, id), isNull(chatMessages.hiddenAt)))
      .returning({ id: chatMessages.id });
    if (hid.length) {
      await this.bus.publishTopic(LOBBY_CHANNEL, { type: 'remove', id: String(id) }).catch(() => {});
      this.log.info({ messageId: id }, 'lobby message hidden by reports');
    }
    return true;
  }
}

/** A Postgres row as the feed shows it, with today's names. */
function toEntry(r: {
  id: number;
  kind: ChatKind;
  authorId: string | null;
  quick: string | null;
  body: string | null;
  card: Record<string, unknown> | null;
  replyTo: number | null;
  createdAt: Date;
  authorName: string | null;
  subjectName: string | null;
}): LobbyEntry | null {
  const id = String(r.id);
  const at = r.createdAt.toISOString();
  if (r.kind === 'chat') {
    if (!r.authorId || !r.authorName) return null;
    const text = messageText(r.quick, r.body);
    if (!text) return null;
    return { kind: 'chat', id, at, from: { id: r.authorId, name: r.authorName }, quick: (r.quick as QuickChatId | null) ?? null, text, replyTo: r.replyTo === null ? null : String(r.replyTo) };
  }
  const card = r.card as unknown as StoredCard | null;
  if (!card || card.kind !== r.kind) return null;
  switch (card.kind) {
    case 'room_posted':
      return { ...card, hostName: r.authorName ?? card.hostName, at, id };
    case 'match_result':
      return { ...card, winnerName: card.winnerId ? (r.subjectName ?? card.winnerName) : null, at, id };
    case 'welcome':
    case 'level_up':
      return r.subjectName ? { ...card, name: r.subjectName, at, id } : null;
  }
}

/** Cards for a recorded match (matches/routes.ts): the result, newcomers' welcomes, level milestones. */
export function matchCards(
  /** playerCount counts everyone in the standings, bots too (game-server matchRecorder.ts) */
  report: { mode: string; map: string; playerCount: number; botCount: number; players: readonly { userId: string; nickname: string; placement: number; left: boolean }[] },
  recorded: readonly { userId: string; level: number; levelBefore: number; firstMatch: boolean }[],
  at: string,
): StoredCard[] {
  const names = new Map(report.players.map((p) => [p.userId, p.nickname]));
  const counted = new Set(recorded.map((p) => p.userId));
  const winner = report.players.find((p) => p.placement === 1 && !p.left && counted.has(p.userId)) ?? null;
  const cards: StoredCard[] = [];
  if (counted.size > 0) {
    cards.push({ kind: 'match_result', winnerId: winner?.userId ?? null, winnerName: winner?.nickname ?? null, mode: report.mode, map: report.map, people: Math.max(0, report.playerCount - report.botCount), bots: report.botCount, at });
  }
  for (const p of recorded) {
    const name = names.get(p.userId);
    if (!name) continue;
    if (p.firstMatch) cards.push({ kind: 'welcome', playerId: p.userId, name, at });
    const milestone = Math.floor(p.level / LEVEL_CARD_EVERY) * LEVEL_CARD_EVERY;
    if (milestone > p.levelBefore && milestone > 1) cards.push({ kind: 'level_up', playerId: p.userId, name, level: milestone, at });
  }
  return cards;
}
