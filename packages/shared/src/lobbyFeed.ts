/**
 * The Lobby feed's interface (agreed in writing between the Rooms workstream, feat/rooms, and the
 * Lobby feed workstream, feat/lobby-feed). Rooms publishes; the feed shows each event as a card.
 *
 * - A room's host presses Post to Lobby (at most once per room every ROOM_POST_COOLDOWN_MS). The API
 *   checks they are the host, makes the room Public if it was Private, and publishes a RoomPostedEvent.
 * - On the API it goes through the push channel's bus (apps/api/src/events/bus.ts) on the topic
 *   LOBBY_FEED_TOPIC, as the SocialEvent `{ type: 'lobby_feed', event }`, and the newest
 *   LOBBY_FEED_KEEP events are kept in Valkey (LOBBY_FEED_KEY, a sorted set by `at`) for a feed that
 *   opens later. apps/api/src/lobby/feed.ts has the publisher and the reader (`LobbyFeed`).
 * - Bots are counted apart from people, as everywhere; there is no free text (the tag and language
 *   are presets), so nothing in a card needs moderating.
 */
import type { RoomLang, RoomTag } from './rooms';

/** A host posted their room to the Lobby. */
export interface RoomPostedEvent {
  kind: 'room_posted';
  code: string;
  hostName: string;
  /** team modes: 0 a free-for-all, else 2, 3 or 4 teams; null when the room hasn't said yet */
  mode: number | null;
  /** map id (content's maps); null when the room hasn't said yet */
  map: string | null;
  people: number;
  /** null: not known yet */
  bots: number | null;
  seats: number;
  tag: RoomTag | null;
  lang: RoomLang | null;
  /** when it was posted, ms since 1970 */
  at: number;
}

/** Everything the feed may carry (one kind today). */
export type LobbyFeedEvent = RoomPostedEvent;

/** The bus topic the feed's events go out on (not a user id: those start `u_`). */
export const LOBBY_FEED_TOPIC = 'lobby-feed';
/** The Valkey sorted set of recent events (score: `at`). */
export const LOBBY_FEED_KEY = 'lobbyfeed:recent';
/** Events kept for a feed that opens later. */
export const LOBBY_FEED_KEEP = 50;
/** A posted room's card is stale after this long (its room may have moved on). */
export const LOBBY_FEED_TTL_MS = 30 * 60_000;
/** One post per room this often. */
export const ROOM_POST_COOLDOWN_MS = 5 * 60_000;
