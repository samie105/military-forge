/**
 * The play-stats event vocabulary, version 1 (docs/16-player-metrics.md §2): one small, fixed list
 * of events the web client and the game server send to the API (`POST /analytics/batch`,
 * `POST /internal/analytics/match`). The API validates every event against it and drops the rest,
 * so nothing outside this file reaches the database: no free text, no names, no addresses.
 *
 * Adding an event kind or an optional field is a compatible change (same version). Changing what a
 * field means, or removing one, bumps ANALYTICS_VERSION; the API keeps reading the old version
 * until no client sends it.
 */

export const ANALYTICS_VERSION = 1;

/** How the player plays right now. */
export const INPUT_KINDS = ['touch', 'keyboard', 'pad'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
/** The screen's size class: phone (short side < 500 CSS px), tablet (< 900), desktop. */
export const FORM_FACTORS = ['phone', 'tablet', 'desktop'] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];
/** The graphics tier the device runs (gfxAuto's pick, or the player's own). */
export const PERF_TIERS = ['low', 'medium', 'high'] as const;
export type PerfTier = (typeof PERF_TIERS)[number];
/** How the page was opened. */
export const ARRIVALS = ['direct', 'invite', 'app'] as const;
export type Arrival = (typeof ARRIVALS)[number];

/** The first-run funnel, in order (each step is sent once, in the session it happens in). */
export const FUNNEL_STEPS = ['landing', 'title', 'name', 'home', 'first-match', 'second-session'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** Where a session can end (the screen showing when the page was closed or hidden for good). */
export const SCREENS = ['landing', 'title', 'name', 'home', 'finding', 'lobby', 'match', 'results', 'training', 'route', 'settings', 'error'] as const;
export type ScreenName = (typeof SCREENS)[number];

/** Features whose use is counted (once per session each). */
export const FEATURES = [
  'locker',
  'armory',
  'creator',
  'outfit-saved',
  'tour-finished',
  'tour-skipped',
  'tour-replayed',
  'install-offered',
  'install-accepted',
  'install-dismissed',
  'settings',
  'spectate',
  'local-room',
  'room-created',
  'room-joined',
  'invite-opened',
  'report-sent',
] as const;
export type Feature = (typeof FEATURES)[number];

/** What went wrong on a device (the no-blank-screen work's failures, and the rest). */
export const ERROR_KINDS = ['route-failed', 'chunk-missing', 'boot-failed', 'script', 'webgl-lost', 'connect-failed'] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** A match's mode: free-for-all, 2–4 teams (rooms on the server), a local room, the training range. */
export const MATCH_MODES = ['ffa', 'team2', 'team3', 'team4', 'local', 'training'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

/** Round trip, banded (never the exact figure). */
export const PING_BANDS = ['lt60', '60-120', '120-200', '200+', 'unknown'] as const;
export type PingBand = (typeof PING_BANDS)[number];

export function pingBand(ms: number): PingBand {
  if (!(ms >= 0)) return 'unknown';
  return ms < 60 ? 'lt60' : ms < 120 ? '60-120' : ms < 200 ? '120-200' : '200+';
}

/** When a player left a running match. */
export const LEAVE_PHASES = ['lobby', 'countdown', 'playing', 'results'] as const;
export type LeavePhase = (typeof LEAVE_PHASES)[number];

/** A creative or advertiser id as the ad pools write them ("house:deet-napkin-motion", "deet"). */
export const AD_ID = /^[a-z0-9][a-z0-9:._#-]{0,79}$/;
/** A route or place id ("locker", "settings:audio"). */
export const PLACE_ID = /^[a-z0-9][a-z0-9:._-]{0,31}$/;

// ---------------------------------------------------------------- client events

/**
 * What the web client sends. `t` is the device's epoch ms when it happened (the API clamps it to
 * the last 24 h). Tiers: `analytics` needs the player's yes (Settings → Privacy); `anonymous` kinds
 * are counts with no player or session id at all, sent either way (errors, ad delivery) unless the
 * browser asks not to be tracked.
 */
export type ClientEvent =
  /**
   * a page load that reached the app: `n` is this device's session number (1 = first ever), `days`
   * since its first, `tzo` the time zone's offset in minutes east of UTC (the local hour of play)
   */
  | { k: 'session.start'; t: number; n: number; days: number; input: InputKind; form: FormFactor; tier: PerfTier; installed: boolean; arrival: Arrival; tzo: number }
  /** foreground seconds since the last one (sent when the page hides, and every 5 min) */
  | { k: 'session.active'; t: number; s: number }
  /** the page went away: the screen it was on */
  | { k: 'session.end'; t: number; last: ScreenName }
  | { k: 'funnel'; t: number; step: FunnelStep }
  | { k: 'feature'; t: number; f: Feature }
  /** the input changed mid-session (a pad picked up) */
  | { k: 'input'; t: number; input: InputKind }
  /** a match as this device saw it (local rooms and training: the server never sees those) */
  | { k: 'match.client'; t: number; mode: MatchMode; finished: boolean; won: boolean; kills: number; deaths: number; s: number; bots: boolean }
  | { k: 'error'; t: number; e: ErrorKind; where: string }
  /** a creative was on screen (once per creative per match): viewable ms, the most of the screen it took (‰) */
  | { k: 'ad.view'; t: number; c: string; adv: string; ms: number; share: number }
  /** tap-to-save: the player saved the creative for after the match */
  | { k: 'ad.save'; t: number; c: string; adv: string }
  /** the player opened a saved ad (the after-match list's Visit) */
  | { k: 'ad.visit'; t: number; c: string; adv: string };

export type ClientEventKind = ClientEvent['k'];

/** Kinds sent with no ids, whether or not the player said yes (the API strips any id they carry). */
export const ANONYMOUS_KINDS: ReadonlySet<ClientEventKind> = new Set(['error', 'ad.view', 'ad.save', 'ad.visit']);
/** Kinds the API sheds first under load (the heavy, sampled ones), before any other client kind. */
export const SHED_FIRST: ReadonlySet<ClientEventKind> = new Set(['ad.view', 'session.active', 'feature']);

/** One upload from the web client. */
export interface ClientBatch {
  v: typeof ANALYTICS_VERSION;
  /** the player's choice: 'analytics' = yes (events carry the session id), 'none' = anonymous kinds only */
  consent: 'analytics' | 'none';
  /** random per page load, memory only (never stored on the device); null when consent is 'none' */
  sid: string | null;
  /** the IANA time zone (a coarse country hint when the request has none; not stored) */
  tz?: string;
  /** the web build id */
  build: string;
  events: ClientEvent[];
}

export const MAX_BATCH_EVENTS = 50;

// ---------------------------------------------------------------- server events

/** One player's match, as the game server saw it (people and bots). */
export interface MatchPlayerStats {
  /** the API account id (guest or signed in) from the join ticket; null for bots and ticketless guests */
  uid: string | null;
  bot: boolean;
  placement: number;
  /** 1st in a free-for-all, or on the winning team */
  won: boolean;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  damageTaken: number;
  headshots: number;
  bestStreak: number;
  /** the gun pair the player brought (weapon ids: their saved pair, or the default one); null for bots */
  guns: [string, string] | null;
  /** kills by what made them (a weapon id, or melee / grenade / mine / gas / world) */
  killsBy: Record<string, number>;
  /** deaths by what killed them */
  deathsBy: Record<string, number>;
  /** kills of bots, and deaths to bots */
  botKills: number;
  botDeaths: number;
  /** seconds in the running match */
  playedS: number;
  /** average seconds alive per life */
  lifeS: number;
  /** left before the end */
  left: boolean;
  /** seconds into the match when they left, null = stayed */
  leftAtS: number | null;
  leftPhase: LeavePhase | null;
  /** left within RAGE_QUIT_S of their own death */
  rage: boolean;
  ping: PingBand;
  reconnects: number;
  transport: 'ws' | 'wt' | 'bot' | 'unknown';
}

/** A player who quit within this many seconds of dying counts as a rage quit. */
export const RAGE_QUIT_S = 15;

/** One finished (or abandoned) match: the game server signs and posts it. */
export interface MatchStatsReport {
  v: typeof ANALYTICS_VERSION;
  matchId: string;
  mode: MatchMode;
  map: string;
  /** a room by code, or the server's default room */
  room: 'code' | 'default';
  startedAt: string;
  endedAt: string;
  durationS: number;
  reason: 'kill_limit' | 'time_limit' | 'other';
  humans: number;
  bots: number;
  players: MatchPlayerStats[];
}
