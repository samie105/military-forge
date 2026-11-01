/**
 * The Lobby feed's publisher and reader (the interface: packages/shared/src/lobbyFeed.ts). Rooms'
 * Post to Lobby publishes here; the Lobby feed workstream (feat/lobby-feed) streams and shows it.
 *
 * - `publish` sends `{ type: 'lobby_feed', event }` on the bus topic LOBBY_FEED_TOPIC (every API
 *   process hears it through Valkey pub/sub, as players' own events) and keeps the newest
 *   LOBBY_FEED_KEEP in the sorted set LOBBY_FEED_KEY (score: `at`).
 * - `recent` reads what a feed opening now should show (newest first, younger than LOBBY_FEED_TTL_MS).
 * - `subscribe` hears new events in this process (the feed's own stream route builds on it).
 */
import { LOBBY_FEED_KEEP, LOBBY_FEED_KEY, LOBBY_FEED_TOPIC, LOBBY_FEED_TTL_MS, type LobbyFeedEvent } from '@military-forge/shared';
import type { EventBus } from '../events/bus';
import type { Kv } from '../kv/kv';

export interface LobbyFeed {
  publish(event: LobbyFeedEvent): Promise<void>;
  recent(limit?: number): Promise<LobbyFeedEvent[]>;
  subscribe(listener: (event: LobbyFeedEvent) => void): () => void;
}

export class BusLobbyFeed implements LobbyFeed {
  constructor(
    private readonly kv: Kv,
    private readonly bus: EventBus,
    private readonly now: () => number,
  ) {}

  async publish(event: LobbyFeedEvent): Promise<void> {
    await this.kv.zadd(LOBBY_FEED_KEY, [{ member: JSON.stringify(event), score: event.at }]);
    const all = await this.kv.ztop(LOBBY_FEED_KEY, LOBBY_FEED_KEEP + 20);
    const old = all.slice(LOBBY_FEED_KEEP).map((e) => e.member);
    if (old.length) await this.kv.zrem(LOBBY_FEED_KEY, old);
    await this.kv.expire(LOBBY_FEED_KEY, LOBBY_FEED_TTL_MS);
    await this.bus.publish(LOBBY_FEED_TOPIC, { type: 'lobby_feed', event });
  }

  async recent(limit = LOBBY_FEED_KEEP): Promise<LobbyFeedEvent[]> {
    const since = this.now() - LOBBY_FEED_TTL_MS;
    const out: LobbyFeedEvent[] = [];
    for (const e of await this.kv.ztop(LOBBY_FEED_KEY, Math.min(limit, LOBBY_FEED_KEEP))) {
      if (e.score < since) break;
      try {
        out.push(JSON.parse(e.member) as LobbyFeedEvent);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  subscribe(listener: (event: LobbyFeedEvent) => void): () => void {
    return this.bus.subscribe(LOBBY_FEED_TOPIC, (e) => {
      if (e.type === 'lobby_feed') listener(e.event);
    });
  }
}
