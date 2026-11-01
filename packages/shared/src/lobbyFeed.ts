/**
 * The Lobby feed: one public channel ("Lobby") on Home, made of system cards (a room posted, a match
 * result, a newcomer's welcome, a level-up, Fight night) and quick chat (preset phrases and emotes,
 * never free text while CHAT_FREE_TEXT is off). This file is the contract between the API, the web
 * and Rooms (feat/rooms, which posts rooms): keep it small and stable, add, never rename.
 *
 * Rooms' Post to Lobby (apps/api rooms/routes.ts) calls `feed.publish(event)` with a
 * {@link RoomPostedEvent}; other cards go through `lobby.post(card)`. Both are on the API's one
 * LobbyFeed (apps/api/src/lobby/feed.ts). A line is stored (Postgres, 30 days, plus the live Valkey
 * stream of ~500) and pushed to every open feed panel on the {@link LOBBY_CHANNEL} topic
 * (events/bus.ts publishTopic) as a {@link LobbyStreamEvent}. Posting never throws into the caller's
 * request: a card that can't be stored is logged and dropped.
 *
 * Messages are stored as quick-chat ids; the text a reader sees is rendered by the server from
 * {@link QUICK_CHAT} (so a phrase can be reworded without touching old rows). Bots are counted apart
 * from people everywhere; the room tag and language are presets, so no card carries free text.
 */
import type { RoomLang, RoomTag } from './rooms';

/** The feed's one channel, and its SSE topic (GET /lobby/events). */
export const LOBBY_CHANNEL = 'lobby' as const;

/** What Rooms publishes when a host presses Post to Lobby (`feed.publish(event)`). */
export interface RoomPostedEvent {
  kind: 'room_posted';
  code: string;
  hostName: string;
  /** the host's account id: hides the card from players who blocked them, and goes with Delete my data */
  hostId?: string;
  /** team modes: 0 a free-for-all, else 2, 3 or 4 teams; null when the room hasn't said yet */
  mode: number | null;
  /** map id (content's maps); null when the room hasn't said yet */
  map: string | null;
  /** people in the room now (bots are never counted as people) */
  people: number;
  /** null: not known yet */
  bots: number | null;
  /** seats left for people */
  seats: number;
  tag: RoomTag | null;
  lang: RoomLang | null;
  /** when it was posted, ms since 1970 */
  at: number;
}

/** Everything Rooms publishes (one kind today). */
export type LobbyFeedEvent = RoomPostedEvent;

/** A posted room as the feed stores and shows it (`at`: ISO time, the server's). */
export type RoomPostedCard = Omit<RoomPostedEvent, 'at'> & { at: string };

/** Rooms' name for the feed's topic: the same channel. */
export const LOBBY_FEED_TOPIC = LOBBY_CHANNEL;
/** A posted room's Join goes away after this long (its room may have moved on); the card stays. */
export const LOBBY_FEED_TTL_MS = 30 * 60_000;
/** One post per room this often. */
export const ROOM_POST_COOLDOWN_MS = 5 * 60_000;

/** A finished online match. `winnerName` is null when a bot came first: bots are never named as people. */
export interface MatchResultCard {
  kind: 'match_result';
  winnerId: string | null;
  winnerName: string | null;
  mode: string;
  map: string;
  people: number;
  bots: number;
  at: string;
}

/** A new player's first match ended: "Tobi joined · say welcome". */
export interface WelcomeCard {
  kind: 'welcome';
  playerId: string;
  name: string;
  at: string;
}

/** A player reached a level worth a card (every {@link LEVEL_CARD_EVERY} levels). */
export interface LevelUpCard {
  kind: 'level_up';
  playerId: string;
  name: string;
  level: number;
  at: string;
}

/** The daily Fight night window (see {@link fightNightWindow}); the feed pins one, it is never stored. */
export interface FightNightCard {
  kind: 'fight_night';
  startsAt: string;
  endsAt: string;
  at: string;
}

export type LobbyCard = RoomPostedCard | MatchResultCard | WelcomeCard | LevelUpCard | FightNightCard;
export type LobbyCardKind = LobbyCard['kind'];

/** A level-up card is posted at levels 5, 10, 15, … (every level would bury the feed). */
export const LEVEL_CARD_EVERY = 5;

/** A player's message: a quick-chat phrase or emote (`quick`), or free text when that is on (`quick` null). */
export interface LobbyChat {
  kind: 'chat';
  id: string;
  at: string;
  from: { id: string; name: string };
  quick: QuickChatId | null;
  /** what to show, rendered by the server */
  text: string;
  /** the card or message this answers (a one-tap reply), or null */
  replyTo: string | null;
}

/** One line in the feed: a stored card with its id, or a message. */
export type LobbyEntry = (Exclude<LobbyCard, FightNightCard> & { id: string }) | LobbyChat;

/** What the `lobby` SSE topic carries (event name = `lobby_${type}`). */
export type LobbyStreamEvent = { type: 'entry'; entry: LobbyEntry } | { type: 'remove'; id: string };

/** What publishes cards (the API's LobbyFeed). */
export interface LobbyFeedPublisher {
  /** a system card (match results, welcomes, level-ups) */
  post(card: Exclude<LobbyCard, FightNightCard>): Promise<LobbyEntry | null>;
  /** Rooms' Post to Lobby */
  publish(event: LobbyFeedEvent): Promise<void>;
}

// ---------------------------------------------------------------- quick chat

export interface QuickChatPhrase {
  id: string;
  text: string;
  /** an emote: shown large; `text` is its glyph and `label` what a screen reader says */
  emote?: true;
  label?: string;
}

/**
 * The preset phrases and emotes. Ids are stored: never reuse or remove one (retire it with `retired`
 * in a later change); wording may change.
 */
export const QUICK_CHAT = [
  { id: 'hi', text: 'Hi all' },
  { id: 'how_far', text: 'How far?' },
  { id: 'whos_on', text: "Who's on?" },
  { id: 'make_we_play', text: 'Make we play' },
  { id: 'need_one', text: 'Need 1 more' },
  { id: 'need_two', text: 'Need 2 more' },
  { id: 'join_my_room', text: 'Join my room' },
  { id: 'im_in', text: "I'm in" },
  { id: 'on_my_way', text: 'On my way' },
  { id: 'one_more', text: 'One more match?' },
  { id: 'rematch', text: 'Rematch?' },
  { id: 'fight_night', text: 'Fight night?' },
  { id: 'see_you_tonight', text: 'See you tonight' },
  { id: 'welcome', text: 'Welcome!' },
  { id: 'good_luck', text: 'Good luck' },
  { id: 'gg', text: 'GG' },
  { id: 'gg_wp', text: 'GG, well played' },
  { id: 'nice_shot', text: 'Nice shot' },
  { id: 'well_done', text: 'Well done' },
  { id: 'no_wahala', text: 'No wahala' },
  { id: 'thanks', text: 'Thanks' },
  { id: 'sorry', text: 'Sorry' },
  { id: 'back_soon', text: 'Back soon' },
  { id: 'got_to_go', text: 'Got to go' },
  { id: 'e_thumbs', text: '👍', emote: true, label: 'Thumbs up' },
  { id: 'e_fire', text: '🔥', emote: true, label: 'Fire' },
  { id: 'e_laugh', text: '😂', emote: true, label: 'Laughing' },
  { id: 'e_clap', text: '👏', emote: true, label: 'Clapping' },
  { id: 'e_strong', text: '💪', emote: true, label: 'Strong' },
] as const satisfies readonly QuickChatPhrase[];

export type QuickChatId = (typeof QUICK_CHAT)[number]['id'];

const BY_ID: ReadonlyMap<string, QuickChatPhrase> = new Map(QUICK_CHAT.map((p) => [p.id, p]));

export function quickChat(id: string): QuickChatPhrase | undefined {
  return BY_ID.get(id);
}

export function isQuickChatId(id: unknown): id is QuickChatId {
  return typeof id === 'string' && BY_ID.has(id);
}

/** The one-tap replies a card offers, in order. */
export const CARD_REPLIES: Readonly<Record<LobbyCardKind, readonly QuickChatId[]>> = {
  room_posted: ['im_in', 'on_my_way'],
  match_result: ['gg', 'nice_shot', 'rematch'],
  welcome: ['welcome', 'how_far'],
  level_up: ['well_done', 'e_fire'],
  fight_night: ['im_in', 'make_we_play'],
};

// ---------------------------------------------------------------- Fight night

/** West Africa Time is UTC+1 all year (no daylight saving). */
export const WAT_OFFSET_MS = 3_600_000;
/** Fight night: 20:00–22:00 WAT every day. */
export const FIGHT_NIGHT_START_HOUR_WAT = 20;
export const FIGHT_NIGHT_HOURS = 2;

/** Tonight's window if it hasn't ended yet, else tomorrow's; `live` while it runs. */
export function fightNightWindow(nowMs: number): { startsAt: number; endsAt: number; live: boolean } {
  const day = 86_400_000;
  const watMidnight = Math.floor((nowMs + WAT_OFFSET_MS) / day) * day - WAT_OFFSET_MS;
  let startsAt = watMidnight + FIGHT_NIGHT_START_HOUR_WAT * 3_600_000;
  let endsAt = startsAt + FIGHT_NIGHT_HOURS * 3_600_000;
  if (nowMs >= endsAt) {
    startsAt += day;
    endsAt += day;
  }
  return { startsAt, endsAt, live: nowMs >= startsAt && nowMs < endsAt };
}

// ---------------------------------------------------------------- limits (the API enforces, the web explains)

export const LOBBY_LIMITS = {
  /** at most one message this often per account */
  gapMs: 3_000,
  perMinute: 10,
  perHour: 100,
  /** the same phrase again from the same account inside this window is dropped */
  repeatMs: 60_000,
  /** free text (off unless CHAT_FREE_TEXT): characters at most */
  textMax: 200,
} as const;
