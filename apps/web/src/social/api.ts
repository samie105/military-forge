/**
 * The API's /friends routes as the web app uses them (apps/api src/friends). Same session as the
 * shell (shell/api.ts `authed`), so a stale token refreshes and errors arrive as ApiError.
 */
import type { Api } from '../shell/api';

export type PresenceStatus = 'online' | 'in_room' | 'offline';

/** A player's soldier as cosmetic wire ids (their avatar); null: no saved look (the silhouette). */
export type LookIds = number[] | null;

export interface Friend {
  id: string;
  nickname: string;
  status: PresenceStatus;
  /** in_room: the room's code */
  room: string | null;
  lastSeenAt: string | null;
  since: string;
  /** in_room: a match is on (true) or the room is in its lobby (false); absent from older pages */
  playing?: boolean;
  look?: LookIds;
}

export interface Person {
  id: string;
  nickname: string;
  at: string;
  look?: LookIds;
}

/** Where you stand with a player a search or Played with recently shows. */
export type Relation = 'none' | 'sent' | 'incoming' | 'friends';

/** A player found by name (GET /friends/search), or met in a match (GET /friends/recent). */
export interface FoundPlayer {
  id: string;
  nickname: string;
  level: number;
  look: LookIds;
  relation: Relation;
  /** Played with recently: when the last match together ended */
  at?: string;
}

export interface FriendsList {
  /** shown as `7KQ4-M9XP` */
  code: string;
  friends: Friend[];
  incoming: Person[];
  outgoing: Person[];
  blocked: Person[];
  max: number;
  /** "Let players find me by name" (absent from an older API: on) */
  findable?: boolean;
  /** who may send you friend requests (absent from an older API: anyone) */
  requestsFrom?: RequestsFrom;
}

/** Who may send you friend requests (apps/api profiles.requests_from). */
export type RequestsFrom = 'anyone' | 'played' | 'code';

/** Why a player is reported (apps/api REPORT_REASONS). */
export type ReportReason = 'name' | 'voice' | 'cheating' | 'spam' | 'underage' | 'other';

/** Where the Report sheet was opened (apps/api REPORT_PLACES). */
export type ReportPlace = 'scoreboard' | 'lobby' | 'results' | 'deathcam' | 'friends' | 'search' | 'recent' | 'request' | 'invite' | 'comms' | 'other';

/** A report about a player: by account id (the friends panel's rows) or exact name (a room's rows). */
export type PlayerReport = ({ id: string } | { name: string }) & { reason: ReportReason; note?: string; room?: string; place?: ReportPlace };

export type RequestResult = { status: 'requested'; user: Person } | { status: 'friends'; friend: Friend };

/** An invite to a room (apps/api invites/service.ts): 2 minutes long. */
export interface Invite {
  id: string;
  from: { id: string; nickname: string };
  to: { id: string; nickname: string };
  room: string;
  at: string;
  expiresAt: string;
  answer?: 'accepted' | 'declined';
}

/** The friends who came to a room together (apps/api invites/party.ts). */
export interface Party {
  id: string;
  members: { id: string; nickname: string }[];
  max: number;
}

/** The friend code alphabet (apps/api friends/code.ts): no 0/O, 1/I/L or U. */
const CODE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

/** What someone typed looks like a friend code (`7kq4-m9xp`, `7KQ4 M9XP`): the stored form, else null. */
export function asFriendCode(text: string): string | null {
  const code = text.toUpperCase().replace(/[\s-]+/g, '');
  return CODE.test(code) ? code : null;
}

export class FriendsApi {
  constructor(private readonly api: Pick<Api, 'authed'>) {}

  list(): Promise<FriendsList> {
    return this.api.authed<FriendsList>('GET', '/friends');
  }

  request(target: { name: string } | { code: string }): Promise<RequestResult> {
    return this.api.authed<RequestResult>('POST', '/friends/requests', target);
  }

  accept(id: string): Promise<{ friend: Friend }> {
    return this.api.authed('POST', `/friends/requests/${encodeURIComponent(id)}/accept`, {});
  }

  decline(id: string): Promise<void> {
    return this.api.authed('POST', `/friends/requests/${encodeURIComponent(id)}/decline`, {});
  }

  cancel(id: string): Promise<void> {
    return this.api.authed('DELETE', `/friends/requests/${encodeURIComponent(id)}`);
  }

  remove(id: string): Promise<void> {
    return this.api.authed('DELETE', `/friends/${encodeURIComponent(id)}`);
  }

  block(id: string): Promise<void> {
    return this.api.authed('POST', '/friends/blocks', { id });
  }

  /** Block by exact name: a room's players carry no account id. */
  blockByName(name: string): Promise<void> {
    return this.api.authed('POST', '/friends/blocks', { name });
  }

  /** Report a player (the Report sheet): 201 a new report, 200 one already made today. */
  report(body: PlayerReport): Promise<{ id: number; already?: true }> {
    return this.api.authed('POST', '/reports/player', body);
  }

  unblock(id: string): Promise<void> {
    return this.api.authed('DELETE', `/friends/blocks/${encodeURIComponent(id)}`);
  }

  newCode(): Promise<{ code: string }> {
    return this.api.authed('POST', '/friends/code', {});
  }

  /** Players whose name starts with `q` (2 letters at least), closest first, at most 8. */
  search(q: string): Promise<{ players: FoundPlayer[] }> {
    return this.api.authed('GET', `/friends/search?q=${encodeURIComponent(q)}`);
  }

  /** The people from your last matches who aren't friends yet. */
  recent(): Promise<{ players: FoundPlayer[] }> {
    return this.api.authed('GET', '/friends/recent');
  }

  setFindable(findable: boolean): Promise<{ findable: boolean }> {
    return this.api.authed('PUT', '/friends/settings', { findable });
  }

  setRequestsFrom(requestsFrom: RequestsFrom): Promise<{ findable: boolean; requestsFrom: RequestsFrom }> {
    return this.api.authed('PUT', '/friends/settings', { requestsFrom });
  }

  /** `now`: the server's clock, so a phone with a wrong clock still counts down right */
  invites(): Promise<{ incoming: Invite[]; sent: Invite[]; now?: string }> {
    return this.api.authed('GET', '/invites');
  }

  invite(to: string, room: string | null): Promise<{ invite: Invite }> {
    return this.api.authed('POST', '/invites', { to, ...(room ? { room } : {}) });
  }

  acceptInvite(id: string): Promise<{ invite: Invite; room: string; party: boolean }> {
    return this.api.authed('POST', `/invites/${encodeURIComponent(id)}/accept`, {});
  }

  declineInvite(id: string): Promise<void> {
    return this.api.authed('POST', `/invites/${encodeURIComponent(id)}/decline`, {});
  }

  party(): Promise<{ party: Party | null }> {
    return this.api.authed('GET', '/party');
  }

  leaveParty(): Promise<void> {
    return this.api.authed('POST', '/party/leave', {});
  }
}
