/** Tap-to-save's queue (de-duplication, expiry, counts) and its cards (results screen, Home). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SavedAdsList } from '../../src/ads/SavedAds';
import { AD_STATS_UPLOAD, SAVED_KEY, SAVED_MAX, SAVED_TTL_MS, STATS_KEY, SavedAds, cleanSaved, type KeyValue } from '../../src/ads/saved';
import { hintLine } from '../../src/ads/mount';
import { savedLine } from '../../src/ads/toast';
import { DEFAULT_KEY_BINDINGS } from '../../src/input';
import type { AdClick } from '../../src/render3d/ads/click';

class Mem implements KeyValue {
  readonly m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const deet: AdClick = { advertiser: 'deet', name: 'Deet Studios', url: 'https://deet.studio', utm: 'street-market' };
const ws: AdClick = { advertiser: 'worldstreet', name: 'WorldStreet', url: 'https://worldstreetgold.com', utm: 'street-market', category: 'finance' };

function queue(store = new Mem()) {
  const clock = { t: 1_000_000 };
  return { q: new SavedAds(store, () => clock.t), clock, store };
}

describe('the saved-ads queue', () => {
  it('saves, newest first, and survives a reload (localStorage)', () => {
    const { q, clock, store } = queue();
    expect(q.save(deet, 'house:deet-napkin-motion', 'Napkin to live URL.', '/a.webp')).toBe('saved');
    clock.t += 1000;
    q.save(ws, 'house:ws-brand-motion', 'Trade the world.', null);
    expect(q.list().map((a) => a.name)).toEqual(['WorldStreet', 'Deet Studios']);
    const again = new SavedAds(store, () => clock.t);
    expect(again.list().map((a) => a.name)).toEqual(['WorldStreet', 'Deet Studios']);
    expect(again.list()[0]!.category).toBe('finance');
  });

  it('de-duplicates: the same creative twice is one card (refreshed, "again")', () => {
    const { q, clock } = queue();
    q.save(deet, 'house:deet-napkin-motion', 'A', null);
    clock.t += 5000;
    expect(q.save(deet, 'house:deet-napkin-motion', 'A', null)).toBe('again');
    expect(q.list()).toHaveLength(1);
    expect(q.list()[0]!.savedAt).toBe(clock.t);
    // another creative with the same destination: still one card, its link now naming the newer creative
    expect(q.save(deet, 'house:deet-friday-motion', 'B', null)).toBe('again');
    expect(q.list()).toHaveLength(1);
    expect(q.list()[0]!.url).toMatch(/utm_content=deet-friday-motion/);
    // another page of the same advertiser: its own card
    q.save({ advertiser: 'worldstreet', name: 'WorldStreet', url: 'https://academy.worldstreetgold.com' }, 'house:ws-academy-motion', 'C', null);
    q.save(ws, 'house:ws-brand-motion', 'D', null);
    expect(q.list().map((a) => a.dest)).toEqual(['https://worldstreetgold.com', 'https://academy.worldstreetgold.com', 'https://deet.studio']);
    expect(q.counts().saves).toEqual({ 'house:deet-napkin-motion': 2, 'house:deet-friday-motion': 1, 'house:ws-academy-motion': 1, 'house:ws-brand-motion': 1 });
  });

  it('expires after 24 h, and drops anything malformed or not https from storage', () => {
    const { q, clock, store } = queue();
    q.save(deet, 'house:deet-napkin-motion', 'A', null);
    clock.t += SAVED_TTL_MS - 1;
    q.prune();
    expect(q.list()).toHaveLength(1);
    clock.t += 1;
    q.prune();
    expect(q.list()).toHaveLength(0);
    expect(JSON.parse(store.getItem(SAVED_KEY)!)).toEqual([]);
    const now = 5_000_000;
    const good = { dest: 'https://deet.studio', url: 'https://deet.studio/?utm_source=x', creative: 'house:deet-x', advertiser: 'deet', name: 'Deet Studios', title: 't', image: null, savedAt: now - 10 };
    expect(cleanSaved([good, { ...good, url: 'http://deet.studio' }, { ...good, url: 'javascript:alert(1)' }, { ...good, dest: 'http://x.y' }, { ...good, savedAt: 'x' }, null, 7, { ...good }], now)).toEqual([good]);
    expect(cleanSaved('nope', now)).toEqual([]);
  });

  it('keeps at most SAVED_MAX cards', () => {
    const { q, clock } = queue();
    for (let i = 0; i < SAVED_MAX + 5; i++) {
      clock.t += 10;
      q.save({ ...deet, url: `https://deet.studio/p${i}` }, `house:deet-${i}`, '', null);
    }
    expect(q.list()).toHaveLength(SAVED_MAX);
    expect(q.list()[0]!.creative).toBe(`house:deet-${SAVED_MAX + 4}`);
  });

  it('a visit counts and removes the card; Remove just removes; counts stay on the device', () => {
    const { q, store } = queue();
    q.save(deet, 'house:deet-napkin-motion', 'A', null);
    q.save(ws, 'house:ws-brand-motion', 'B', null);
    let calls = 0;
    const off = q.subscribe(() => calls++);
    q.visited(q.list().find((a) => a.advertiser === 'deet')!.url);
    q.remove(q.list()[0]!.url);
    off();
    expect(calls).toBe(2);
    expect(q.list()).toEqual([]);
    expect(q.counts().visits).toEqual({ 'house:deet-napkin-motion': 1 });
    expect(JSON.parse(store.getItem(STATS_KEY)!).visits).toEqual({ 'house:deet-napkin-motion': 1 });
    expect(AD_STATS_UPLOAD).toBe(false);
  });

  it('works with storage blocked (the list lives for the page)', () => {
    const q = new SavedAds({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    q.save(deet, 'house:deet-napkin-motion', 'A', null);
    expect(q.list()).toHaveLength(1);
  });
});

describe('the cards and the toast', () => {
  it('nothing at all when nothing is saved', () => {
    const { q } = queue();
    expect(renderToStaticMarkup(<SavedAdsList where="results" queue={q} />)).toBe('');
  });

  it('a card per ad: Visit is a real new-tab link (noopener), Remove a labelled button; finance cards carry the risk line', () => {
    const { q } = queue();
    q.save(deet, 'house:deet-napkin-motion', 'DEET Studios: Napkin to live URL.', '/assets/ads/street_market/deet-napkin-motion.webp');
    q.save(ws, 'house:ws-brand-motion', 'WorldStreet: Trade the world.', null);
    const html = renderToStaticMarkup(<SavedAdsList where="results" queue={q} />);
    expect(html).toContain('Saved ads');
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://deet.studio/?utm_source=military-forge&amp;utm_medium=billboard&amp;utm_campaign=street-market&amp;utm_content=deet-napkin-motion"');
    expect(html).toContain('aria-label="Remove the Deet Studios ad"');
    expect(html).toContain('(opens in a new tab)');
    expect(html.match(/Trading involves risk\. 18\+\./g)).toHaveLength(1);
    expect(html).toContain('Napkin to live URL.');
    expect(html).not.toContain('DEET Studios: Napkin');
  });

  it('the toast says what was saved and when it will show; the hint names the player’s own key', () => {
    expect(savedLine('Deet Studios', false)).toBe("Saved · Deet Studios · we'll show it after the match");
    expect(savedLine('WorldStreet', true)).toMatch(/^Already saved · WorldStreet/);
    expect(hintLine('keys', DEFAULT_KEY_BINDINGS)).toMatch(/press E to save/);
    expect(hintLine('touch', DEFAULT_KEY_BINDINGS)).toMatch(/Tap it/);
  });
});
