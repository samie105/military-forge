/**
 * Small key-value interface over Redis/Valkey (docs/06 §7 "Redis keys"), with an in-memory
 * implementation for `pnpm dev` and tests without Docker. Rate limits use it now; the room
 * registry, fleet heartbeats and ticket replay protection (Milestone B) build on the same calls.
 */
export interface Kv {
  readonly kind: 'memory' | 'redis';
  get(key: string): Promise<string | null>;
  /** returns false when `onlyIfAbsent` is set and the key already exists */
  set(key: string, value: string, opts?: { ttlMs?: number; onlyIfAbsent?: boolean }): Promise<boolean>;
  /** returns true when a key was removed */
  del(key: string): Promise<boolean>;
  /**
   * Atomically adds 1 to a counter. The first increment starts the key's TTL (a fixed window);
   * later ones leave it alone. Returns the new value and the window's remaining milliseconds.
   */
  incr(key: string, windowMs: number): Promise<{ value: number; ttlMs: number }>;
  /** Sorted sets (leaderboards, docs/06 §7 `lb:{board}:{period}`): sets each member's score. */
  zadd(key: string, entries: readonly ZEntry[]): Promise<void>;
  /** The top `count` members, highest score first (ties: the later member id first, as Redis' ZREVRANGE). */
  ztop(key: string, count: number): Promise<ZEntry[]>;
  /** A member's 0-based place from the top and its score, or null when it isn't in the set. */
  zrank(key: string, member: string): Promise<{ rank: number; score: number } | null>;
  zcard(key: string): Promise<number>;
  zrem(key: string, members: readonly string[]): Promise<void>;
  /** Sets a key's time to live (any kind of key). */
  expire(key: string, ttlMs: number): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ZEntry {
  member: string;
  score: number;
}

interface Entry {
  value: string;
  /** absolute expiry in ms, or Infinity */
  expiresAt: number;
}

/** Single-process KV. Expired keys are dropped on read and by a periodic sweep. */
export class MemoryKv implements Kv {
  readonly kind = 'memory';
  private readonly entries = new Map<string, Entry>();
  private readonly zsets = new Map<string, { members: Map<string, number>; expiresAt: number }>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly now: () => number = Date.now, sweepEveryMs = 60_000) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepEveryMs);
    this.sweepTimer.unref?.();
  }

  get size(): number {
    return this.entries.size;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, opts: { ttlMs?: number; onlyIfAbsent?: boolean } = {}): Promise<boolean> {
    if (opts.onlyIfAbsent && this.live(key)) return false;
    this.entries.set(key, { value, expiresAt: opts.ttlMs !== undefined ? this.now() + opts.ttlMs : Infinity });
    return true;
  }

  async del(key: string): Promise<boolean> {
    const existed = this.live(key) !== undefined || this.zset(key) !== undefined;
    this.entries.delete(key);
    this.zsets.delete(key);
    return existed;
  }

  async zadd(key: string, entries: readonly ZEntry[]): Promise<void> {
    if (!entries.length) return;
    let z = this.zset(key);
    if (!z) this.zsets.set(key, (z = { members: new Map(), expiresAt: Infinity }));
    for (const e of entries) z.members.set(e.member, e.score);
  }

  async ztop(key: string, count: number): Promise<ZEntry[]> {
    return this.sorted(key).slice(0, Math.max(0, count));
  }

  async zrank(key: string, member: string): Promise<{ rank: number; score: number } | null> {
    const list = this.sorted(key);
    const rank = list.findIndex((e) => e.member === member);
    return rank < 0 ? null : { rank, score: list[rank]!.score };
  }

  async zcard(key: string): Promise<number> {
    return this.zset(key)?.members.size ?? 0;
  }

  async zrem(key: string, members: readonly string[]): Promise<void> {
    const z = this.zset(key);
    for (const m of members) z?.members.delete(m);
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    const at = this.now() + ttlMs;
    const e = this.live(key);
    if (e) e.expiresAt = at;
    const z = this.zset(key);
    if (z) z.expiresAt = at;
  }

  private sorted(key: string): ZEntry[] {
    const z = this.zset(key);
    if (!z) return [];
    return [...z.members].map(([member, score]) => ({ member, score })).sort((a, b) => b.score - a.score || (a.member < b.member ? 1 : a.member > b.member ? -1 : 0));
  }

  private zset(key: string) {
    const z = this.zsets.get(key);
    if (z && z.expiresAt <= this.now()) {
      this.zsets.delete(key);
      return undefined;
    }
    return z;
  }

  async incr(key: string, windowMs: number): Promise<{ value: number; ttlMs: number }> {
    const now = this.now();
    const entry = this.live(key);
    if (!entry) {
      this.entries.set(key, { value: '1', expiresAt: now + windowMs });
      return { value: 1, ttlMs: windowMs };
    }
    const value = Number(entry.value) + 1;
    if (!Number.isFinite(value)) throw new Error(`kv: ${key} is not a counter`);
    entry.value = String(value);
    return { value, ttlMs: entry.expiresAt === Infinity ? -1 : entry.expiresAt - now };
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    this.entries.clear();
    this.zsets.clear();
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    for (const [key, z] of this.zsets) if (z.expiresAt <= now) this.zsets.delete(key);
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
