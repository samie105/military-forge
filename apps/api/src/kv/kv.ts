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
  ping(): Promise<boolean>;
  close(): Promise<void>;
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
    const existed = this.live(key) !== undefined;
    this.entries.delete(key);
    return existed;
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
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
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
