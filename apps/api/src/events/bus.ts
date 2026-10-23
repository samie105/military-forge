/**
 * The social push channel's fan-out: an event published for a player reaches every stream that
 * player has open (GET /events, events/routes.ts), on any API process.
 *
 * In one process (dev, tests, today's single API on the box) a Map of listeners does it. With
 * REDIS_URL the events go through Valkey pub/sub on `ev:{userId}` (one pattern subscription per
 * process), so several API processes behind one proxy deliver to whichever holds the stream.
 * Events are fire-and-forget: a player with no stream open misses them and catches up from the
 * REST routes (GET /friends, GET /invites) when they next look.
 */
import { Redis } from 'ioredis';

/** What travels to the browser (JSON, one SSE `event:` per type). */
export type SocialEvent =
  /** something in your friends list changed (a request, an accept, a removal): reload it */
  | { type: 'friends' }
  /** a friend's presence changed (online, in a room and which, offline) */
  | { type: 'presence'; id: string; status: 'online' | 'in_room' | 'offline'; room: string | null }
  /** an invite to a room, for you */
  | { type: 'invite'; invite: unknown }
  /** an invite to you is no longer good (answered elsewhere, cancelled) */
  | { type: 'invite_gone'; id: string }
  /** your invite was answered */
  | { type: 'invite_answered'; id: string; to: string; answer: 'accepted' | 'declined' }
  /** your party changed (someone joined or left): reload it */
  | { type: 'party' };

export type Listener = (event: SocialEvent) => void;

export interface EventBus {
  publish(userId: string, event: SocialEvent): Promise<void>;
  /** Listen for one player's events; returns the stop. */
  subscribe(userId: string, listener: Listener): () => void;
  /** How many streams this process holds for a player (a cap per player). */
  listeners(userId: string): number;
  close(): Promise<void>;
}

class Local {
  private readonly byUser = new Map<string, Set<Listener>>();

  add(userId: string, listener: Listener): () => void {
    let set = this.byUser.get(userId);
    if (!set) this.byUser.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.byUser.delete(userId);
    };
  }

  deliver(userId: string, event: SocialEvent): void {
    for (const l of this.byUser.get(userId) ?? []) {
      try {
        l(event);
      } catch {
        /* one broken stream never stops the others */
      }
    }
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}

export class MemoryBus implements EventBus {
  private readonly local = new Local();

  async publish(userId: string, event: SocialEvent): Promise<void> {
    this.local.deliver(userId, event);
  }

  subscribe(userId: string, listener: Listener): () => void {
    return this.local.add(userId, listener);
  }

  listeners(userId: string): number {
    return this.local.count(userId);
  }

  async close(): Promise<void> {}
}

/** Valkey pub/sub: one publisher connection, one subscriber connection per process. */
export class RedisBus implements EventBus {
  private readonly local = new Local();
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly prefix: string;

  /** @param prefix channel prefix (tests on a shared Valkey get their own) */
  constructor(url: string, prefix = '') {
    this.prefix = `${prefix}ev:`;
    this.pub = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 5_000, lazyConnect: true });
    this.sub = new Redis(url, { connectTimeout: 5_000, lazyConnect: true });
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      let event: SocialEvent;
      try {
        event = JSON.parse(message) as SocialEvent;
      } catch {
        return;
      }
      this.local.deliver(channel.slice(this.prefix.length), event);
    });
  }

  async connect(): Promise<this> {
    await Promise.all([this.pub.connect(), this.sub.connect()]);
    await this.sub.psubscribe(`${this.prefix}*`);
    return this;
  }

  async publish(userId: string, event: SocialEvent): Promise<void> {
    await this.pub.publish(`${this.prefix}${userId}`, JSON.stringify(event));
  }

  subscribe(userId: string, listener: Listener): () => void {
    return this.local.add(userId, listener);
  }

  listeners(userId: string): number {
    return this.local.count(userId);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
