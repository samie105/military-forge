/**
 * Parties: the friends who came to a room together. Accepting an invite puts you in the inviter's
 * party (a new one for the two of you when they had none); you leave by leaving it or by accepting
 * someone else's invite. A party lives in Valkey (`party:{id}`, `partyof:{userId}`) for 6 hours
 * after its last change, holds at most 8, and has no leader rights yet.
 *
 * What it's for: the party strip on Home and in the lobby, and party voice: the join ticket carries
 * the party id (rooms/routes.ts), so the game server lets party mates hear each other anywhere in
 * the room (protocol v18). Party mates who aren't friends see each other's name only, never their
 * presence: presence stays friends-only.
 */
import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { profiles } from '../db/schema';
import type { EventBus } from '../events/bus';
import type { Kv } from '../kv/kv';

export const PARTY_TTL_MS = 6 * 3600_000;
export const MAX_PARTY = 8;

interface PartyRecord {
  id: string;
  members: string[];
  at: string;
}

export interface PartyView {
  id: string;
  members: { id: string; nickname: string }[];
  max: number;
}

const partyKey = (id: string) => `party:${id}`;
const ofKey = (userId: string) => `partyof:${userId}`;

export class PartyService {
  constructor(
    private readonly db: Db,
    private readonly kv: Kv,
    private readonly bus: EventBus,
    private readonly now: () => number,
  ) {}

  private async read(id: string): Promise<PartyRecord | null> {
    const raw = await this.kv.get(partyKey(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PartyRecord;
    } catch {
      return null;
    }
  }

  private async write(p: PartyRecord): Promise<void> {
    await this.kv.set(partyKey(p.id), JSON.stringify(p), { ttlMs: PARTY_TTL_MS });
    for (const m of p.members) await this.kv.set(ofKey(m), p.id, { ttlMs: PARTY_TTL_MS });
  }

  private tell(members: readonly string[]): void {
    for (const m of members) void this.bus.publish(m, { type: 'party' }).catch(() => {});
  }

  /** The player's party id, or null; a live party's clock starts over (it's in use). */
  async partyOf(userId: string): Promise<string | null> {
    const id = await this.kv.get(ofKey(userId));
    if (!id) return null;
    const p = await this.read(id);
    if (!p || !p.members.includes(userId)) {
      await this.kv.del(ofKey(userId));
      return null;
    }
    await this.write(p);
    return id;
  }

  async view(userId: string): Promise<PartyView | null> {
    const id = await this.kv.get(ofKey(userId));
    const p = id ? await this.read(id) : null;
    if (!p || !p.members.includes(userId)) return null;
    const names = await this.db.select({ id: profiles.userId, nickname: profiles.nickname }).from(profiles).where(inArray(profiles.userId, p.members));
    const byId = new Map(names.map((n) => [n.id, n.nickname]));
    return { id: p.id, members: p.members.filter((m) => byId.has(m)).map((m) => ({ id: m, nickname: byId.get(m)! })), max: MAX_PARTY };
  }

  /** `userId` joins `hostId`'s party (made for the two of them when there's none). False when it's full. */
  async join(userId: string, hostId: string): Promise<boolean> {
    if (userId === hostId) return false;
    const hostParty = await this.partyOf(hostId);
    let p = hostParty ? await this.read(hostParty) : null;
    if (p?.members.includes(userId)) return true;
    if (p && p.members.length >= MAX_PARTY) return false;
    await this.leave(userId);
    if (!p) p = { id: `p_${randomBytes(9).toString('base64url')}`, members: [hostId], at: new Date(this.now()).toISOString() };
    p.members.push(userId);
    p.at = new Date(this.now()).toISOString();
    await this.write(p);
    this.tell(p.members);
    return true;
  }

  async leave(userId: string): Promise<void> {
    const id = await this.kv.get(ofKey(userId));
    await this.kv.del(ofKey(userId));
    const p = id ? await this.read(id) : null;
    if (!p || !p.members.includes(userId)) return;
    p.members = p.members.filter((m) => m !== userId);
    // a party of one is no party
    if (p.members.length <= 1) {
      await this.kv.del(partyKey(p.id));
      for (const m of p.members) await this.kv.del(ofKey(m));
    } else {
      p.at = new Date(this.now()).toISOString();
      await this.write(p);
    }
    this.tell([...p.members, userId]);
  }
}
