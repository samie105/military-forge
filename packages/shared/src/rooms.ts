/**
 * The Rooms list and Online now (1 Nov 2026, the owner: "a session where people can enter like the
 * room and all post it, or find anyone online"): what the API, the game server and the web page agree on.
 *
 * - A room's host picks who sees it in the list: Private (code only: the default for Create room),
 *   Friends (the host's friends and party) or Public. Play now rooms are listed as Open by themselves.
 * - The host may add one preset tag and a language. No free-text titles: nothing to moderate.
 * - The game server says how each room is doing about every 10 s (a signed heartbeat, RoomStateReport);
 *   the API keeps it 30 s (`roomstate:{code}`), so a room that stops beating leaves the list by itself.
 * - People and bots are always counted apart, and bots are always called bots.
 */

/** Who sees a room in the Rooms list. Private rooms are joined by code only. */
export const ROOM_VISIBILITIES = ['private', 'friends', 'public'] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

export const VISIBILITY_LABELS: Record<RoomVisibility, string> = {
  private: 'Private',
  friends: 'Friends',
  public: 'Public',
};

/** One line on what each choice means (the lobby's picker). */
export const VISIBILITY_HINTS: Record<RoomVisibility, string> = {
  private: 'Only people with the code or link',
  friends: 'Your friends and party see it in Rooms',
  public: 'Anyone can find it in Rooms',
};

/** The host's preset tag (no free text). */
export const ROOM_TAGS = ['new', 'chill', 'practice', 'sweaty'] as const;
export type RoomTag = (typeof ROOM_TAGS)[number];

export const TAG_LABELS: Record<RoomTag, string> = {
  new: 'New players welcome',
  chill: 'Chill',
  practice: 'Practice',
  sweaty: 'Sweaty',
};

/** The languages a host may mark a room with (optional), by code; the label is the language's own name. */
export const ROOM_LANGS = ['en', 'fr', 'pt', 'es', 'ar', 'ha', 'yo', 'ig', 'sw', 'hi', 'de', 'tr', 'id', 'ru'] as const;
export type RoomLang = (typeof ROOM_LANGS)[number];

export const LANG_LABELS: Record<RoomLang, string> = {
  en: 'English',
  fr: 'Français',
  pt: 'Português',
  es: 'Español',
  ar: 'العربية',
  ha: 'Hausa',
  yo: 'Yorùbá',
  ig: 'Igbo',
  sw: 'Kiswahili',
  hi: 'हिन्दी',
  de: 'Deutsch',
  tr: 'Türkçe',
  id: 'Bahasa Indonesia',
  ru: 'Русский',
};

export function isRoomTag(v: unknown): v is RoomTag {
  return typeof v === 'string' && (ROOM_TAGS as readonly string[]).includes(v);
}

export function isRoomLang(v: unknown): v is RoomLang {
  return typeof v === 'string' && (ROOM_LANGS as readonly string[]).includes(v);
}

/** Where a room's match is: its lobby, the countdown, the match, or the scoreboard. */
export const ROOM_PHASES = ['lobby', 'starting', 'playing', 'results'] as const;
export type RoomPhase = (typeof ROOM_PHASES)[number];

/** Most people in one room (bots fill the rest of the 8 slots). */
export const ROOM_MAX_PEOPLE = 8;

/** The game server beats about this often … */
export const ROOM_STATE_EVERY_MS = 10_000;
/** … and the API keeps a beat this long: three missed beats and the room leaves the list. */
export const ROOM_STATE_TTL_MS = 30_000;

/**
 * One room as the game server reports it (POST /internal/rooms/state, signed like match results).
 * `ids` are the account ids of the people playing in it (never shown: blocks and "Friend inside").
 */
export interface RoomStateEntry {
  code: string;
  phase: RoomPhase;
  /** team modes: 0 a free-for-all, else 2, 3 or 4 teams */
  teams: number;
  map: string;
  /** people with a slot (those reconnecting too), never bots or spectators */
  people: number;
  bots: number;
  /** slots a person could still take */
  seats: number;
  /** seconds left in the match (playing only), else null */
  timeLeftS: number | null;
  /** the host's account id (the game server's host now; null: a guest without a ticket, or none) */
  hostId: string | null;
  ids: string[];
}

export interface RoomStateReport {
  /** when the game server read its rooms (ms since 1970): an older report never replaces a newer one */
  at: number;
  rooms: RoomStateEntry[];
}

/** A row of the Rooms list, as GET /rooms returns it. */
export interface RoomRow {
  code: string;
  /** a Play now room (listed as Open by itself) */
  quick: boolean;
  visibility: RoomVisibility;
  /** null until the game server has said (a room just made) */
  teams: number | null;
  map: string | null;
  host: { name: string; friend: boolean };
  people: number;
  /** null: not known yet */
  bots: number | null;
  seats: number;
  phase: RoomPhase | null;
  timeLeftS: number | null;
  tag: RoomTag | null;
  lang: RoomLang | null;
  /** one of your friends is playing in it */
  friendInside: boolean;
  /** when it was made (ISO) */
  createdAt: string;
}

/** Online now's counts: people only, never bots. */
export interface OnlineCounts {
  online: number;
  inMatches: number;
  playedToday: number;
}

/** Below this many online, Online now says how many played today instead (a small number reads as empty). */
export const ONLINE_FEW = 5;

/** "Looking for a match" lasts this long, then turns itself off. */
export const LFG_TTL_MS = 15 * 60_000;

/** What a player looking for a match wants: anything, a free-for-all, or teams. */
export const LFG_MODES = ['any', 'ffa', 'teams'] as const;
export type LfgMode = (typeof LFG_MODES)[number];

export const LFG_MODE_LABELS: Record<LfgMode, string> = {
  any: 'Any mode',
  ffa: 'Deathmatch',
  teams: 'Team deathmatch',
};

/** "Recent players online": people you played with in this many days, who chose to be shown. */
export const RECENT_ONLINE_DAYS = 7;
