/**
 * The API's /friends routes as the web app uses them (apps/api src/friends). Same session as the
 * shell (shell/api.ts `authed`), so a stale token refreshes and errors arrive as ApiError.
 */
import type { Api } from '../shell/api';

export type PresenceStatus = 'online' | 'in_room' | 'offline';

export interface Friend {
  id: string;
  nickname: string;
  status: PresenceStatus;
  /** in_room: the room's code */
  room: string | null;
  lastSeenAt: string | null;
  since: string;
}

export interface Person {
  id: string;
  nickname: string;
  at: string;
}

export interface FriendsList {
  /** shown as `7KQ4-M9XP` */
  code: string;
  friends: Friend[];
  incoming: Person[];
  outgoing: Person[];
  blocked: Person[];
  max: number;
}

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

  unblock(id: string): Promise<void> {
    return this.api.authed('DELETE', `/friends/blocks/${encodeURIComponent(id)}`);
  }

  newCode(): Promise<{ code: string }> {
    return this.api.authed('POST', '/friends/code', {});
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
