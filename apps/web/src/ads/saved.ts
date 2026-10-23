/**
 * The saved-ads queue (tap-to-save, the owner's ask of 23 Oct 2026): what a player saved from the
 * billboards while playing, shown after the match (the results screen, and Home) with a Visit link.
 * Nothing here opens a page: only the player's own tap on Visit does (popups need a user gesture).
 *
 * - On this device only (localStorage), never sent anywhere.
 * - One card per destination: saving a second creative that leads to the same page refreshes the
 *   card (its link then names the newer creative) instead of adding one.
 * - A card stays until it's visited or removed, or for 24 h.
 * - Saves and visits are counted per creative, on this device too. `AD_STATS_UPLOAD` is off: there is
 *   no ads backend, and nothing is uploaded until the owner turns that on.
 */
import { FINANCE_NOTE, visitUrl, type AdClick } from '../render3d/ads/click';

export const SAVED_KEY = 'mf.ads.saved.v1';
export const STATS_KEY = 'mf.ads.stats.v1';
/** how long a saved ad stays when it isn't visited */
export const SAVED_TTL_MS = 24 * 60 * 60 * 1000;
/** the list never grows past this (the oldest goes) */
export const SAVED_MAX = 12;
/** No upload hook yet: counts stay on the device (owner-decisions: analytics on-device until opted in). */
export const AD_STATS_UPLOAD = false;

export interface SavedAd {
  /** the destination (no UTM): the de-duplication key */
  dest: string;
  /** the page a Visit opens (UTM-tagged) */
  url: string;
  /** the creative saved last for it ("house:deet-napkin-motion") */
  creative: string;
  advertiser: string;
  /** "Deet Studios" */
  name: string;
  /** the words on the creative */
  title: string;
  /** the creative's picture (under the page's base URL), or null */
  image: string | null;
  category?: string;
  /** ms since the epoch */
  savedAt: number;
}

export interface AdStats {
  saves: Record<string, number>;
  visits: Record<string, number>;
}

/** The storage the queue uses (localStorage in the app; a map in tests). */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked: the queue lives for the page only
  }
}

/** The card's small print for a finance creative, else ''. */
export function noteFor(ad: Pick<SavedAd, 'category'>): string {
  return ad.category === 'finance' ? FINANCE_NOTE : '';
}

/** Fresh, well-formed entries of `raw` (anything a stale or edited store holds), newest first. */
export function cleanSaved(raw: unknown, now: number): SavedAd[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SavedAd[] = [];
  for (const r of raw as Partial<SavedAd>[]) {
    if (!r || typeof r.url !== 'string' || typeof r.dest !== 'string' || typeof r.name !== 'string' || typeof r.savedAt !== 'number' || typeof r.creative !== 'string') continue;
    if (!r.url.startsWith('https://') || !r.dest.startsWith('https://') || now - r.savedAt >= SAVED_TTL_MS || r.savedAt > now + 60_000 || seen.has(r.dest)) continue;
    seen.add(r.dest);
    out.push({
      dest: r.dest,
      url: r.url,
      creative: r.creative,
      advertiser: typeof r.advertiser === 'string' ? r.advertiser : '',
      name: r.name,
      title: typeof r.title === 'string' ? r.title : '',
      image: typeof r.image === 'string' ? r.image : null,
      ...(typeof r.category === 'string' ? { category: r.category } : {}),
      savedAt: r.savedAt,
    });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt).slice(0, SAVED_MAX);
}

export type SaveResult = 'saved' | 'again';

export class SavedAds {
  private memory: SavedAd[] = [];
  private stats: AdStats = { saves: {}, visits: {} };
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly SavedAd[] = [];

  constructor(
    private readonly store: KeyValue | null = defaultStore(),
    private readonly now: () => number = Date.now,
  ) {
    this.memory = cleanSaved(this.read(SAVED_KEY), this.now());
    const s = this.read(STATS_KEY) as Partial<AdStats> | null;
    if (s && typeof s === 'object') this.stats = { saves: { ...(s.saves ?? {}) }, visits: { ...(s.visits ?? {}) } };
    this.snapshot = this.memory;
  }

  private read(key: string): unknown {
    try {
      const raw = this.store?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private write(): void {
    try {
      this.store?.setItem(SAVED_KEY, JSON.stringify(this.memory));
      this.store?.setItem(STATS_KEY, JSON.stringify(this.stats));
    } catch {
      // full or blocked: the list still holds for this page
    }
    this.snapshot = [...this.memory];
    for (const fn of this.listeners) fn();
  }

  /** What to show, newest first: the same array until something changes (React's external store). */
  list(): readonly SavedAd[] {
    return this.snapshot;
  }

  /** Drops expired cards (a screen calls it when it shows the list). */
  prune(): void {
    const fresh = cleanSaved(this.memory, this.now());
    if (fresh.length === this.memory.length) return;
    this.memory = fresh;
    this.write();
  }

  /** Saves a creative's ad: a new card, or the card for the same page refreshed ('again'). */
  save(click: AdClick, creative: string, title: string, image: string | null): SaveResult {
    const url = visitUrl(click, creative);
    const now = this.now();
    this.memory = cleanSaved(this.memory, now);
    const dest = click.url;
    const again = this.memory.some((a) => a.dest === dest);
    const entry: SavedAd = { dest, url, creative, advertiser: click.advertiser, name: click.name, title, image, ...(click.category ? { category: click.category } : {}), savedAt: now };
    this.memory = [entry, ...this.memory.filter((a) => a.dest !== dest)].slice(0, SAVED_MAX);
    this.stats.saves[creative] = (this.stats.saves[creative] ?? 0) + 1;
    this.write();
    return again ? 'again' : 'saved';
  }

  /** The player opened it: counted, and the card goes. */
  visited(url: string): void {
    const ad = this.memory.find((a) => a.url === url);
    if (!ad) return;
    this.stats.visits[ad.creative] = (this.stats.visits[ad.creative] ?? 0) + 1;
    this.memory = this.memory.filter((a) => a.url !== url);
    this.write();
  }

  remove(url: string): void {
    if (!this.memory.some((a) => a.url === url)) return;
    this.memory = this.memory.filter((a) => a.url !== url);
    this.write();
  }

  counts(): AdStats {
    return { saves: { ...this.stats.saves }, visits: { ...this.stats.visits } };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

let shared: SavedAds | null = null;

/** The app's one queue. */
export function savedAds(): SavedAds {
  return (shared ??= new SavedAds());
}
