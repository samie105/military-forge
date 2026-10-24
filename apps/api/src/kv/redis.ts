/** Redis/Valkey implementation of {@link Kv} (ioredis). */
import { Redis } from 'ioredis';
import type { Kv, ZEntry } from './kv';

// INCR, then start the window on the first hit only; one round trip, atomic.
const INCR_WINDOW = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {v, redis.call('PTTL', KEYS[1])}
`;

export class RedisKv implements Kv {
  readonly kind = 'redis';
  private readonly redis: Redis;

  /** @param opts.keyPrefix put in front of every key (tests: a run of its own on a shared Valkey) */
  constructor(url: string, opts: { keyPrefix?: string } = {}) {
    // Fail fast instead of queueing commands forever while Redis is down: a rate-limit check
    // must not hang a request.
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 5_000, lazyConnect: true, ...(opts.keyPrefix ? { keyPrefix: opts.keyPrefix } : {}) });
    quietRedisErrors(this.redis, 'kv');
  }

  /** Connects and checks the server answers; throws if it doesn't. */
  async connect(): Promise<this> {
    await this.redis.connect();
    await this.redis.ping();
    return this;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async mget(keys: readonly string[]): Promise<(string | null)[]> {
    if (!keys.length) return [];
    return this.redis.mget(...keys);
  }

  async set(key: string, value: string, opts: { ttlMs?: number; onlyIfAbsent?: boolean } = {}): Promise<boolean> {
    const { ttlMs, onlyIfAbsent } = opts;
    let res: 'OK' | null;
    if (ttlMs !== undefined && onlyIfAbsent) res = await this.redis.set(key, value, 'PX', ttlMs, 'NX');
    else if (ttlMs !== undefined) res = await this.redis.set(key, value, 'PX', ttlMs);
    else if (onlyIfAbsent) res = await this.redis.set(key, value, 'NX');
    else res = await this.redis.set(key, value);
    return res === 'OK';
  }

  async del(key: string): Promise<boolean> {
    return (await this.redis.del(key)) > 0;
  }

  async incr(key: string, windowMs: number): Promise<{ value: number; ttlMs: number }> {
    const [value, ttlMs] = (await this.redis.eval(INCR_WINDOW, 1, key, windowMs)) as [number, number];
    return { value, ttlMs };
  }

  async zadd(key: string, entries: readonly ZEntry[]): Promise<void> {
    if (!entries.length) return;
    await this.redis.zadd(key, ...entries.flatMap((e) => [e.score, e.member]));
  }

  async ztop(key: string, count: number): Promise<ZEntry[]> {
    if (count <= 0) return [];
    const flat = await this.redis.zrevrange(key, 0, count - 1, 'WITHSCORES');
    const out: ZEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ member: flat[i]!, score: Number(flat[i + 1]) });
    return out;
  }

  async zrank(key: string, member: string): Promise<{ rank: number; score: number } | null> {
    const [rank, score] = await Promise.all([this.redis.zrevrank(key, member), this.redis.zscore(key, member)]);
    return rank === null || score === null ? null : { rank, score: Number(score) };
  }

  async zcard(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  async zrem(key: string, members: readonly string[]): Promise<void> {
    if (members.length) await this.redis.zrem(key, ...members);
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    await this.redis.pexpire(key, ttlMs);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

/**
 * Valkey going away and coming back (a restart: the box's deploy restarted it, 24 Oct 2026) is
 * routine: ioredis reconnects by itself. Without a listener every failed try printed an "Unhandled
 * error event" stack. One line when it goes, one when it's back.
 */
export function quietRedisErrors(redis: Redis, name: string, log: (msg: string) => void = console.warn): void {
  let down = false;
  redis.on('error', (e: Error) => {
    if (down) return;
    down = true;
    log(`[valkey] ${name}: ${e.message}; reconnecting`);
  });
  redis.on('ready', () => {
    if (!down) return;
    down = false;
    log(`[valkey] ${name}: back`);
  });
}
