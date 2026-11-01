/**
 * The Rooms list's rules, in one place (pure: tests drive them without a server). Play now and the
 * list share them: Play now takes the list's top row it may join, else makes a new listed room.
 *
 * Who sees a room: Play now rooms (Open) and Public ones, everyone; Friends ones, the host's friends
 * and party; Private ones, nobody (their code is the way in). A block either way, with the host or
 * anyone playing in it, hides the room (and never says why).
 *
 * The order: rooms with a friend in them (or a friend's room) first, then rooms in their lobby, then
 * the most people among rooms with a seat free, then the newest.
 */
import { ROOM_MAX_PEOPLE, type RoomLang, type RoomPhase, type RoomRow, type RoomTag, type RoomVisibility } from '@military-forge/shared';
import type { StoredRoomState } from './state';

/** A room as the API keeps it (`room:{code}`). */
export interface RoomRecord {
  host: string;
  createdAt: string;
  /** made by Play now: listed as Open, and open to other Play now players while it's young */
  quick?: true;
  /** the players given a ticket to it (newest last, at most ROOM_PLAYERS_KEPT) */
  players?: string[];
  /** who sees it in the Rooms list (Play now rooms: always listed); absent = private */
  visibility?: RoomVisibility;
  tag?: RoomTag;
  lang?: RoomLang;
}

export const ROOM_PLAYERS_KEPT = 32;

/** A Play now room takes other Play now players this long after it was made (its countdown and ~2 minutes of play). */
export const QUICK_OPEN_MS = 150_000;
/** at most this many people in a Play now room (the bots make up the rest: 3 bots fill to 4) */
export const QUICK_PEOPLE = 4;
/** Play now never drops anyone into a match with less than this left */
export const QUICK_MIN_LEFT_S = 60;

/** The room's listing choice: a Play now room is Open (public); otherwise its host's choice, private by default. */
export function visibilityOf(r: RoomRecord): RoomVisibility {
  return r.quick ? 'public' : (r.visibility ?? 'private');
}

/** Whether the room goes in the Rooms list at all (before who's looking). */
export function listed(r: RoomRecord): boolean {
  return visibilityOf(r) !== 'private';
}

/** Who is looking: their friends, their party mates, and everyone blocked either way. */
export interface Viewer {
  id: string;
  friends: ReadonlySet<string>;
  party: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
}

/** A listed room with what the list knows of it now. */
export interface Candidate {
  code: string;
  record: RoomRecord;
  /** the game server's last word on it (null: none in the last 30 s, e.g. a room just made) */
  state: StoredRoomState | null;
  /** the host now (the game server's host when it said, else the room's maker) */
  hostId: string;
  hostName: string;
  /** people playing in it (account ids): the state's, else those whose presence says this room */
  ids: string[];
  /** how many people: the state's, else `ids.length` */
  people: number;
}

/** A row with what the ranking and Play now need beside what the page sees. */
export interface RankedRow extends RoomRow {
  hostId: string;
  ids: string[];
}

/** Whether `viewer` may see (and join from the list) this room. */
export function visibleTo(c: Pick<Candidate, 'record' | 'hostId' | 'ids'>, viewer: Viewer): boolean {
  const v = visibilityOf(c.record);
  if (v === 'private') return false;
  if (v === 'friends' && c.hostId !== viewer.id && !viewer.friends.has(c.hostId) && !viewer.party.has(c.hostId)) return false;
  if (viewer.blocked.has(c.hostId) || (c.record.host !== c.hostId && viewer.blocked.has(c.record.host))) return false;
  return !c.ids.some((id) => viewer.blocked.has(id));
}

/** The page's row for a candidate, as `viewer` sees it. */
export function rowOf(c: Candidate, viewer: Viewer): RankedRow {
  const s = c.state;
  const people = s ? s.people : c.people;
  return {
    code: c.code,
    quick: c.record.quick === true,
    visibility: visibilityOf(c.record),
    teams: s ? s.teams : null,
    map: s ? s.map : null,
    host: { name: c.hostName, friend: viewer.friends.has(c.hostId) },
    people,
    bots: s ? s.bots : null,
    seats: s ? s.seats : Math.max(0, ROOM_MAX_PEOPLE - people),
    phase: s ? s.phase : null,
    timeLeftS: s ? s.timeLeftS : null,
    tag: c.record.tag ?? null,
    lang: c.record.lang ?? null,
    friendInside: c.ids.some((id) => id !== viewer.id && viewer.friends.has(id)),
    createdAt: c.record.createdAt,
    hostId: c.hostId,
    ids: c.ids,
  };
}

/** A room still waiting to start (in its lobby, or not heard from yet: just made). */
function inLobby(r: Pick<RoomRow, 'phase'>): boolean {
  return r.phase === null || r.phase === 'lobby';
}

/** The list's order (see the top of the file). */
export function compareRows(a: RoomRow, b: RoomRow): number {
  const fa = a.friendInside || a.host.friend;
  const fb = b.friendInside || b.host.friend;
  if (fa !== fb) return fa ? -1 : 1;
  if (inLobby(a) !== inLobby(b)) return inLobby(a) ? -1 : 1;
  const oa = a.seats > 0;
  const ob = b.seats > 0;
  if (oa !== ob) return oa ? -1 : 1;
  if (a.people !== b.people) return b.people - a.people;
  const t = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return t !== 0 ? t : a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

export function rankRooms<T extends RoomRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareRows);
}

/** The phases a Play now player may land in (not the scoreboard, not a match about to end). */
function joinableNow(r: Pick<RoomRow, 'phase' | 'timeLeftS'>): boolean {
  const p: RoomPhase | null = r.phase;
  if (p === 'results') return false;
  if (p === 'playing') return r.timeLeftS === null || r.timeLeftS >= QUICK_MIN_LEFT_S;
  return true;
}

/**
 * Whether Play now may put `viewerId` in this row's room: a seat for a person, someone in it already,
 * not a room they were in before, a moment worth joining at, and for a Play now room, young (when the
 * game server hasn't said how it's doing) and under QUICK_PEOPLE people.
 */
export function playNowMayJoin(r: RankedRow & { record: RoomRecord }, viewerId: string, now: number): boolean {
  if (r.seats <= 0 || r.people <= 0) return false;
  if (r.hostId === viewerId || (r.record.players ?? [r.record.host]).includes(viewerId)) return false;
  if (!joinableNow(r)) return false;
  if (r.quick) {
    if (r.people >= QUICK_PEOPLE) return false;
    if (r.phase === null && now - Date.parse(r.createdAt) > QUICK_OPEN_MS) return false;
  }
  return true;
}

/** Play now's pick: the first row of the ranked list it may join, or null (then a new room). */
export function playNowPick<T extends RankedRow & { record: RoomRecord }>(ranked: readonly T[], viewerId: string, now: number): T | null {
  return ranked.find((r) => playNowMayJoin(r, viewerId, now)) ?? null;
}
