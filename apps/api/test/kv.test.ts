import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../src/ids';
import { MemoryKv, type Kv } from '../src/kv/kv';
import { RedisKv } from '../src/kv/redis';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The same contract for every backend; Redis/Valkey only when TEST_REDIS_URL is set (docker compose up -d). */
function contract(name: string, make: () => Promise<{ kv: Kv; wait: (ms: number) => Promise<void> }>) {
  describe(`Kv contract: ${name}`, () => {
    let ctx: Awaited<ReturnType<typeof make>>;
    const key = (k: string) => `test:${newId('s')}:${k}`;
    afterAll(() => ctx?.kv.close());

    it('get/set/del', async () => {
      ctx = await make();
      const { kv } = ctx;
      const k = key('a');
      expect(await kv.get(k)).toBeNull();
      expect(await kv.set(k, 'one')).toBe(true);
      expect(await kv.get(k)).toBe('one');
      expect(await kv.set(k, 'two', { onlyIfAbsent: true })).toBe(false);
      expect(await kv.get(k)).toBe('one');
      expect(await kv.del(k)).toBe(true);
      expect(await kv.del(k)).toBe(false);
      expect(await kv.set(k, 'three', { onlyIfAbsent: true })).toBe(true);
      expect(await kv.ping()).toBe(true);
    });

    it('expires keys after their TTL', async () => {
      const { kv, wait } = ctx;
      const k = key('ttl');
      await kv.set(k, 'x', { ttlMs: 50, onlyIfAbsent: true });
      expect(await kv.get(k)).toBe('x');
      await wait(80);
      expect(await kv.get(k)).toBeNull();
      expect(await kv.set(k, 'y', { onlyIfAbsent: true })).toBe(true);
    });

    it('incr counts in a fixed window started by the first hit', async () => {
      const { kv, wait } = ctx;
      const k = key('n');
      expect((await kv.incr(k, 100)).value).toBe(1);
      await wait(40);
      const second = await kv.incr(k, 100);
      expect(second.value).toBe(2);
      expect(second.ttlMs).toBeGreaterThan(0);
      expect(second.ttlMs).toBeLessThanOrEqual(65);
      await wait(80);
      expect(await kv.incr(k, 100)).toEqual({ value: 1, ttlMs: 100 });
    });
  });
}

contract('memory', async () => {
  let t = 0;
  const kv = new MemoryKv(() => t);
  return { kv, wait: async (ms) => void (t += ms) };
});

if (process.env.TEST_REDIS_URL) {
  contract('redis', async () => ({ kv: await new RedisKv(process.env.TEST_REDIS_URL!).connect(), wait: sleep }));
}

describe('MemoryKv', () => {
  it('sweep drops expired keys', async () => {
    let t = 0;
    const kv = new MemoryKv(() => t);
    await kv.set('a', '1', { ttlMs: 10 });
    await kv.set('b', '1');
    t = 20;
    kv.sweep();
    expect(kv.size).toBe(1);
    await kv.close();
  });
});
