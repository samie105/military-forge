/**
 * The API's Rooms list and Online now routes as the page uses them (apps/api src/rooms, src/online).
 * Same session as the shell (shell/api.ts `authed`): a stale token refreshes, errors arrive as ApiError.
 */
import type { LfgMode, OnlineCounts, RoomLang, RoomRow, RoomTag, RoomVisibility } from '@military-forge/shared';
import type { Api } from '../shell/api';
import type { LookIds } from '../social/api';

/** A room's listing as its lobby shows it (GET /rooms/:code/settings). */
export interface RoomSettings {
  visibility: RoomVisibility;
  tag: RoomTag | null;
  lang: RoomLang | null;
  /** you are its host */
  host: boolean;
  /** a Play now room: always listed as Open */
  quick: boolean;
  /** when Post to Lobby works again (ISO); null: now */
  nextPostAt: string | null;
}

export interface OnlineSettings {
  appearOffline: boolean;
  showToRecent: boolean;
}

export interface LfgState {
  mode: LfgMode;
  until: string;
}

export interface OnlineNow {
  counts: OnlineCounts;
  settings: OnlineSettings;
  lfg: LfgState | null;
}

/** Someone on now: a recent player, or one looking for a match. */
export interface OnlinePlayer {
  id: string;
  nickname: string;
  level: number;
  look: LookIds;
  friend: boolean;
  where: 'lobby' | 'match' | null;
  /** their room's code when it's in your Rooms list */
  room: string | null;
  mode?: LfgMode;
}

export class RoomsApi {
  constructor(private readonly api: Pick<Api, 'authed'>) {}

  async list(): Promise<RoomRow[]> {
    return (await this.api.authed<{ rooms: RoomRow[] }>('GET', '/rooms')).rooms;
  }

  settings(code: string): Promise<RoomSettings> {
    return this.api.authed<RoomSettings>('GET', `/rooms/${encodeURIComponent(code)}/settings`);
  }

  update(code: string, change: Partial<Pick<RoomSettings, 'visibility' | 'tag' | 'lang'>>): Promise<RoomSettings> {
    return this.api.authed<RoomSettings>('PATCH', `/rooms/${encodeURIComponent(code)}`, change);
  }

  post(code: string): Promise<RoomSettings & { posted: true }> {
    return this.api.authed<RoomSettings & { posted: true }>('POST', `/rooms/${encodeURIComponent(code)}/post`, {});
  }

  online(): Promise<OnlineNow> {
    return this.api.authed<OnlineNow>('GET', '/online');
  }

  async recent(): Promise<OnlinePlayer[]> {
    return (await this.api.authed<{ players: OnlinePlayer[] }>('GET', '/online/recent')).players;
  }

  async looking(): Promise<OnlinePlayer[]> {
    return (await this.api.authed<{ players: OnlinePlayer[] }>('GET', '/online/lfg')).players;
  }

  startLooking(mode: LfgMode): Promise<LfgState> {
    return this.api.authed<LfgState>('PUT', '/online/lfg', { mode });
  }

  async stopLooking(): Promise<void> {
    await this.api.authed<unknown>('DELETE', '/online/lfg');
  }

  setOnlineSettings(change: Partial<OnlineSettings>): Promise<OnlineSettings> {
    return this.api.authed<OnlineSettings>('PUT', '/online/settings', change);
  }

  /** Invite a player to your room (a friend, or someone looking for a match). */
  async invite(to: string, room: string): Promise<void> {
    await this.api.authed<unknown>('POST', '/invites', { to, room });
  }
}
