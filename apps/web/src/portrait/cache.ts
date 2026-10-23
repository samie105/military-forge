/**
 * Where portraits are kept (§7.3.4): an LRU of object URLs in memory (96 entries), and Cache Storage
 * behind it (`mf-portraits-v1`) so a reload finds them at once. Everything here is regenerable: a
 * missing or evicted entry just renders again (Safari may clear script storage after a week unused).
 */

export const MEMORY_ENTRIES = 96;
export const DISK_CACHE = 'mf-portraits-v1';

export interface Stored {
  url: string;
  width: number;
  height: number;
}

/** Least recently used goes first; its object URL is revoked (a mounted <img> keeps its decoded picture). */
export class PortraitMemory {
  private readonly entries = new Map<string, Stored>();

  constructor(
    private readonly capacity = MEMORY_ENTRIES,
    private readonly revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): Stored | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    // most recently used last
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: Stored): void {
    const old = this.entries.get(key);
    if (old && old.url !== value.url) this.revoke(old.url);
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const [oldest, entry] = this.entries.entries().next().value as [string, Stored];
      this.entries.delete(oldest);
      this.revoke(entry.url);
    }
  }

  /** Everything (the art changed). */
  clear(): void {
    for (const e of this.entries.values()) this.revoke(e.url);
    this.entries.clear();
  }
}

/** Cache Storage when the page has it (secure contexts: https, localhost); otherwise nothing is kept on disk. */
export class PortraitDisk {
  private open: Promise<Cache | null> | null = null;

  constructor(private readonly origin: string = typeof location !== 'undefined' ? location.origin : 'http://localhost') {}

  private cache(): Promise<Cache | null> {
    if (!this.open) {
      const storage = typeof caches !== 'undefined' ? caches : null;
      this.open = storage ? storage.open(DISK_CACHE).catch(() => null) : Promise.resolve(null);
    }
    return this.open;
  }

  private url(key: string): string {
    return `${this.origin}/__mf-portrait/${encodeURIComponent(key)}`;
  }

  async get(key: string): Promise<Blob | null> {
    try {
      const res = await (await this.cache())?.match(this.url(key));
      return res ? await res.blob() : null;
    } catch {
      return null;
    }
  }

  async put(key: string, blob: Blob): Promise<void> {
    try {
      await (await this.cache())?.put(this.url(key), new Response(blob, { headers: { 'content-type': blob.type || 'image/webp' } }));
    } catch {
      /* full, blocked or private mode: memory only */
    }
  }

  /** Entries not made with the current art (`keep` says which keys stay). */
  async prune(keep: (key: string) => boolean): Promise<void> {
    try {
      const cache = await this.cache();
      if (!cache) return;
      for (const req of await cache.keys()) {
        const key = decodeURIComponent(req.url.slice(req.url.lastIndexOf('/') + 1));
        if (!keep(key)) await cache.delete(req);
      }
    } catch {
      /* nothing to do */
    }
  }
}
