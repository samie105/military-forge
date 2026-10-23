/**
 * Invites (the owner's 23 Oct ask): invite a friend to your room from the friends panel, the
 * lobby or the pause menu. The friend gets it at once over the push channel (events/), as a toast
 * with Join and Decline, in the menus and mid-match. An invite lasts 2 minutes. Joining is the usual
 * room flow (`/r/CODE`, POST /rooms/:code/join for the ticket); accepting also puts you in the
 * inviter's party (party.ts).
 *
 * Invites live in Valkey only (they're 2 minutes long): `inv:{id}` (the invite, with its answer once
 * given), `inv:to:{userId}` and `inv:from:{userId}` (ids, newest last), all expiring with the
 * newest invite. Only friends can invite each other, so a block (which ends the friendship) stops
 * invites too.
 */
import { randomBytes } from 'node:crypto';
import { normalizeRoomCode } from '@military-forge/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { profiles } from '../db/schema';
import type { EventBus } from '../events/bus';
import type { FriendsService } from '../friends/service';
import { ApiError } from '../http/errors';
import type { Kv } from '../kv/kv';
import type { PresenceService } from '../presence/presence';
import type { PartyService } from './party';

export const INVITE_TTL_MS = 120_000;
/** the same invite again (same friend, same room) no sooner than this: a double tap, a stuck button */
export const REINVITE_MS = 5_000;
/** invites kept per list (to you, from you) */
const LIST_MAX = 20;

export type InviteAnswer = 'accepted' | 'declined';

export interface Invite {
  id: string;
  from: { id: string; nickname: string };
  to: { id: string; nickname: string };
  /** the room's code */
  room: string;
  at: string;
  expiresAt: string;
  /** set once the friend answers */
  answer?: InviteAnswer;
}

const invKey = (id: string) => `inv:${id}`;
const toKey = (userId: string) => `inv:to:${userId}`;
const fromKey = (userId: string) => `inv:from:${userId}`;

export class InviteService {
  constructor(
    private readonly db: Db,
    private readonly kv: Kv,
    private readonly bus: EventBus,
    private readonly friends: FriendsService,
    private readonly presence: PresenceService,
    private readonly party: PartyService,
    private readonly now: () => number,
  ) {}

  private async nickname(userId: string): Promise<string> {
    const [row] = await this.db.select({ nickname: profiles.nickname }).from(profiles).where(eq(profiles.userId, userId));
    return row?.nickname ?? 'A friend';
  }

  private async read(id: string): Promise<Invite | null> {
    const raw = await this.kv.get(invKey(id));
    if (!raw) return null;
    try {
      const inv = JSON.parse(raw) as Invite;
      return Date.parse(inv.expiresAt) > this.now() ? inv : null;
    } catch {
      return null;
    }
  }

  private async ids(key: string): Promise<string[]> {
    try {
      return JSON.parse((await this.kv.get(key)) ?? '[]') as string[];
    } catch {
      return [];
    }
  }

  private async push(key: string, id: string): Promise<void> {
    const ids = [...(await this.ids(key)).filter((x) => x !== id), id].slice(-LIST_MAX);
    await this.kv.set(key, JSON.stringify(ids), { ttlMs: INVITE_TTL_MS });
  }

  private async list(key: string): Promise<Invite[]> {
    const ids = await this.ids(key);
    const raws = ids.length ? await this.kv.mget(ids.map(invKey)) : [];
    const out: Invite[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      try {
        const inv = JSON.parse(raw) as Invite;
        if (Date.parse(inv.expiresAt) > this.now()) out.push(inv);
      } catch {
        /* skip */
      }
    }
    return out.reverse();
  }

  /** Invites to you still waiting for an answer, newest first. */
  async incoming(userId: string): Promise<Invite[]> {
    return (await this.list(toKey(userId))).filter((i) => !i.answer && i.to.id === userId);
  }

  /** Your invites from the last 2 minutes, with their answers, newest first. */
  async sent(userId: string): Promise<Invite[]> {
    return (await this.list(fromKey(userId))).filter((i) => i.from.id === userId);
  }

  /**
   * Invite friend `toId` to `room` (default: the room your presence says you're in). Inviting the
   * same friend to the same room again sends it again with a fresh 2 minutes.
   */
  async send(fromId: string, toId: string, rawRoom: string | null): Promise<Invite> {
    if (fromId === toId) throw new ApiError(400, 'cannot_invite_self', "That's you");
    if (!(await this.friends.areFriends(fromId, toId))) throw new ApiError(403, 'not_friends', 'You can invite friends only: send them the room link instead');
    const room = rawRoom ? normalizeRoomCode(rawRoom) : (await this.presence.get(fromId)).room;
    if (!room || !(await this.kv.get(`room:${room}`))) throw new ApiError(404, 'room_not_found', 'Make or join a room first, then invite');
    const theirs = await this.presence.get(toId);
    if (theirs.room === room) throw new ApiError(409, 'already_in_room', "They're in this room already");

    const at = this.now();
    const previous = (await this.sent(fromId)).find((i) => i.to.id === toId && i.room === room && !i.answer);
    if (previous && at - Date.parse(previous.at) < REINVITE_MS) {
      const retryAfter = Math.ceil((REINVITE_MS - (at - Date.parse(previous.at))) / 1000);
      throw new ApiError(429, 'rate_limited', 'Invite sent: give them a moment', { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    const invite: Invite = {
      id: previous?.id ?? `i_${randomBytes(9).toString('base64url')}`,
      from: { id: fromId, nickname: await this.nickname(fromId) },
      to: { id: toId, nickname: await this.nickname(toId) },
      room,
      at: new Date(at).toISOString(),
      expiresAt: new Date(at + INVITE_TTL_MS).toISOString(),
    };
    await this.kv.set(invKey(invite.id), JSON.stringify(invite), { ttlMs: INVITE_TTL_MS });
    await this.push(toKey(toId), invite.id);
    await this.push(fromKey(fromId), invite.id);
    void this.bus.publish(toId, { type: 'invite', invite }).catch(() => {});
    return invite;
  }

  private async answer(userId: string, id: string, answer: InviteAnswer): Promise<Invite> {
    const inv = await this.read(id);
    if (!inv || inv.to.id !== userId) throw new ApiError(404, 'invite_not_found', 'That invite has expired');
    if (inv.answer) throw new ApiError(409, 'invite_answered', `You already ${inv.answer} it`);
    inv.answer = answer;
    const left = Math.max(1, Date.parse(inv.expiresAt) - this.now());
    await this.kv.set(invKey(id), JSON.stringify(inv), { ttlMs: left });
    void this.bus.publish(inv.from.id, { type: 'invite_answered', id, to: userId, answer }).catch(() => {});
    // the toast goes away on the player's other tabs and devices too
    void this.bus.publish(userId, { type: 'invite_gone', id }).catch(() => {});
    return inv;
  }

  /** Accept: the room's code to join (the usual join flow), and you're in the inviter's party. */
  async accept(userId: string, id: string): Promise<{ invite: Invite; room: string; party: boolean }> {
    const invite = await this.answer(userId, id, 'accepted');
    const party = await this.party.join(userId, invite.from.id);
    return { invite, room: invite.room, party };
  }

  async decline(userId: string, id: string): Promise<void> {
    await this.answer(userId, id, 'declined');
  }
}
