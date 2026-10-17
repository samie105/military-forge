/** Redis/Valkey implementation of {@link Kv} (ioredis). */
import { Redis } from 'ioredis';
import type { Kv } from './kv';

// INCR, then start the window on the first hit only; one round trip, atomic.
const INCR_WINDOW = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {v, redis.call('PTTL', KEYS[1])}
`;

export class RedisKv implements Kv {
  readonly kind = 'redis';
  private readonly redis: Redis;

  constructor(url: string) {
    // Fail fast instead of queueing commands forever while Redis is down: a rate-limit check
    // must not hang a request.
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 5_000, lazyConnect: true });
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
