/**
 * The Rooms list's and Online now's words, kept plain and short (and tested: rooms.test.tsx). People and
 * bots are always counted apart, and bots are always called bots.
 */
import { maps } from '@military-forge/content';
import { LANG_LABELS, ONLINE_FEW, TAG_LABELS, type OnlineCounts, type RoomLang, type RoomRow } from '@military-forge/shared';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 players · 4 bots"; before the room has said how many bots: "1 player · bots fill the rest". */
export function peopleLine(people: number, bots: number | null): string {
  const p = plural(people, 'player', 'players');
  if (bots === null) return `${p} · bots fill the rest`;
  return bots > 0 ? `${p} · ${plural(bots, 'bot', 'bots')}` : `${p} · no bots`;
}

/** "In lobby", "Starting", "In match · 2:40 left", "Results". */
export function phaseLine(r: Pick<RoomRow, 'phase' | 'timeLeftS'>): string {
  switch (r.phase) {
    case null:
    case 'lobby':
      return 'In lobby';
    case 'starting':
      return 'Starting';
    case 'playing':
      return r.timeLeftS === null ? 'In match' : `In match · ${clock(r.timeLeftS)} left`;
    case 'results':
      return 'Results';
  }
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "5 seats left", "1 seat left", "Full". */
export function seatsLine(seats: number): string {
  return seats > 0 ? `${plural(seats, 'seat', 'seats')} left` : 'Full';
}

/** The mode: "Deathmatch", "Team deathmatch · 2 teams"; null while the room hasn't said. */
export function modeLine(teams: number | null): string | null {
  if (teams === null) return null;
  return teams > 0 ? `Team deathmatch · ${teams} teams` : 'Deathmatch';
}

export function mapLine(id: string | null): string | null {
  return id ? (maps[id]?.name ?? id) : null;
}

export function tagLine(tag: RoomRow['tag']): string | null {
  return tag ? TAG_LABELS[tag] : null;
}

export function langLine(lang: RoomLang | null): string | null {
  return lang ? LANG_LABELS[lang] : null;
}

/**
 * Online now's headline: "14 players online · 6 in matches"; with fewer than 5 on, how many played
 * today instead ("23 played today"), as a small number reads as empty. People only, never bots.
 */
export function countsLine(c: OnlineCounts): string {
  if (c.online < ONLINE_FEW) return c.playedToday > 0 ? `${c.playedToday} played today` : 'Quiet right now';
  return `${plural(c.online, 'player', 'players')} online · ${c.inMatches} in ${c.inMatches === 1 ? 'a match' : 'matches'}`;
}

/** A row read out in one go (screen readers): what, where, who, how full. */
export function rowLabel(r: RoomRow): string {
  return [modeLine(r.teams) ?? 'New room', mapLine(r.map), `${r.host.name}'s room${r.host.friend ? ', a friend' : ''}`, peopleLine(r.people, r.bots), phaseLine(r), seatsLine(r.seats), tagLine(r.tag), langLine(r.lang), r.friendInside ? 'A friend is inside' : null]
    .filter(Boolean)
    .join('. ');
}

export type ModeFilter = 'all' | 'ffa' | 'teams';

export interface RoomFilters {
  mode: ModeFilter;
  /** show full rooms too (they offer Watch) */
  showFull: boolean;
  /** only rooms with a friend in them, or a friend's */
  friends: boolean;
  /** only rooms marked with this language; null: any */
  lang: RoomLang | null;
}

export const DEFAULT_FILTERS: RoomFilters = { mode: 'all', showFull: false, friends: false, lang: null };

/** The rows the filters let through, in the server's order. */
export function filterRooms(rows: readonly RoomRow[], f: RoomFilters): RoomRow[] {
  return rows.filter((r) => {
    if (!f.showFull && r.seats <= 0) return false;
    if (f.mode === 'ffa' && r.teams !== 0) return false;
    if (f.mode === 'teams' && !(r.teams !== null && r.teams > 0)) return false;
    if (f.friends && !r.friendInside && !r.host.friend) return false;
    if (f.lang && r.lang !== f.lang) return false;
    return true;
  });
}

/** The languages the rooms are marked with (the filter offers only those). */
export function langsIn(rows: readonly RoomRow[]): RoomLang[] {
  return [...new Set(rows.flatMap((r) => (r.lang ? [r.lang] : [])))];
}
