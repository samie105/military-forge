/**
 * One Home for every player state (UX atlas 1 Nov, batch 3: UX-01, UX-11, UX-14, UX-15). Home and the
 * phone's Home ask this which state the player is in and what that state shows, so the two never
 * drift. Each state has one primary action (the poster's button, the only volt-weight thing on Home):
 *
 * - first: no match finished on this device yet. Play now.
 * - returning: a match played here before. Play now; "Keep this name?", Next orders and the Home
 *   stops take their turn one at a time (tour/homeQueue.ts).
 * - minor: this device or the account said under 18 (audit-2 L-03). Training is the poster, First
 *   flight and Live fire its two tickets; the online ways in (Play now, Create room, Join with code,
 *   Local room, Rooms, Friends, Squad, Lobby) are not drawn at all, so nothing on Home leads to a no.
 * - offline: the API can't be reached. Training is the poster; Create room waits with its reason;
 *   Join with code and Local room still reach a room on the same Wi-Fi.
 * - suspended: the account can't play online for now (audit-2 L-04). Training is the poster; the
 *   online ways in wait with the reason.
 *
 * Pure: the screens feed the profile, the device's age answer and the matches finished here.
 */
import type { Profile } from './store';

export type HomeState = 'first' | 'returning' | 'minor' | 'offline' | 'suspended';

/** The order matters: a suspended account is told so first; an under-18 device is training-only whatever the network does. */
export function homeState(profile: Pick<Profile, 'offline' | 'minor' | 'suspended'> | null, minorOnDevice: boolean, matchesFinished: number): HomeState {
  if (profile?.suspended) return 'suspended';
  if (profile?.minor || minorOnDevice) return 'minor';
  if (!profile || profile.offline) return 'offline';
  return matchesFinished > 0 ? 'returning' : 'first';
}

/** How a way into a room shows: drawn and live, drawn and waiting (with why), or not drawn. */
export type Way = { show: 'on' } | { show: 'off'; why: string } | { show: 'none' };

export interface HomePlan {
  state: HomeState;
  /** the poster's one primary action (Enter on Home presses it) */
  primary: 'play' | 'training';
  /** the poster's line under its title */
  line: string;
  create: Way;
  local: Way;
  join: Way;
  /** Join with code's line under its name */
  joinLine: string;
  /** the Rooms tab (an online list) */
  rooms: Way;
  /** the second ticket beside Join (or the first two, under 18): what the poster doesn't already say */
  tickets: readonly ('join' | 'training' | 'flight' | 'live-fire')[];
  /** the nameplate's tag: why Home looks like this (null: nothing to say) */
  tag: { tone: 'paper' | 'warn'; text: string } | null;
  /** Play now's bot level line under the button */
  bots: boolean;
}

export const PLAY_LINE = 'Bots fill the room and the fight starts at once. Others on Play now may join. Friends join by its code.';
export const MINOR_LINE = 'Practice against bots. Works offline.';
export const MINOR_TAG = 'Online play is 18+. Training is open to everyone.';
/** What Home says when the server can't be reached: once, in the poster (desktop and phone). It says the server, never the player's Wi-Fi. */
export const OFFLINE_LINE = "Can't reach the server. Training with bots still works.";
/** a suspended or banned account (audit-2 L-04): the server answered, it just won't let this account play online */
export const SUSPENDED_LINE = "This account can't play online right now. Training with bots still works.";
export const NEEDS_CONNECTION = 'Needs a connection';
export const JOIN_LINE = '6 letters, or paste the link';
export const OFFLINE_JOIN = 'Offline: local rooms only';
export const SUSPENDED_WHY = 'Online play is paused';

const on: Way = { show: 'on' };
const none: Way = { show: 'none' };
const off = (why: string): Way => ({ show: 'off', why });

/** What each state shows. */
export function homePlan(state: HomeState): HomePlan {
  switch (state) {
    case 'first':
    case 'returning':
      return { state, primary: 'play', line: PLAY_LINE, create: on, local: on, join: on, joinLine: JOIN_LINE, rooms: on, tickets: ['join', 'training'], tag: null, bots: true };
    case 'minor':
      return { state, primary: 'training', line: MINOR_LINE, create: none, local: none, join: none, joinLine: '', rooms: none, tickets: ['flight', 'live-fire'], tag: { tone: 'paper', text: MINOR_TAG }, bots: false };
    case 'offline':
      return { state, primary: 'training', line: OFFLINE_LINE, create: off(NEEDS_CONNECTION), local: on, join: on, joinLine: OFFLINE_JOIN, rooms: off(NEEDS_CONNECTION), tickets: ['join', 'flight'], tag: { tone: 'warn', text: 'Offline' }, bots: false };
    case 'suspended':
      return { state, primary: 'training', line: SUSPENDED_LINE, create: off(SUSPENDED_WHY), local: on, join: off(SUSPENDED_WHY), joinLine: SUSPENDED_WHY, rooms: off(SUSPENDED_WHY), tickets: ['join', 'flight'], tag: { tone: 'warn', text: 'Training only' }, bots: false };
  }
}
