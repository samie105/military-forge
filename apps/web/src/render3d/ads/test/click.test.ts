import { readFileSync } from 'node:fs';
import { GAME_SLUG } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../../camera';
import { projectToPlane, type Rect } from '../../layers';
import { planePose } from '../../planeCamera';
import { AdBoards, checkClick, checkManifest, clickOf, creativeAt, frameIndex, houseManifest, poolEntries, visitUrl, type AdClick, type AdManifest, type AdSlot, type HousePool } from '..';

const WEB = new URL('../../../../', import.meta.url);
const json = <T>(url: URL) => JSON.parse(readFileSync(url, 'utf8')) as T;
const slots = json<AdSlot[]>(new URL('public/assets/kits/street_market/street_market.adslots.json', WEB));
const pool = json<HousePool>(new URL('public/assets/ads/street_market/house.json', WEB));

const ok: AdClick = { advertiser: 'deet', name: 'Deet Studios', url: 'https://deet.studio' };

describe('click-through config (tap-to-save)', () => {
  it('every sponsored creative has an advertiser, an https destination and a name; local house art has none', () => {
    for (const e of [...pool.sponsored!.screens, ...pool.sponsored!.hoardings]) {
      const click = clickOf(pool, e);
      expect(click, e.id).toBeDefined();
      expect(checkClick(click!), e.id).toEqual([]);
      expect(click!.url.startsWith('https://')).toBe(true);
    }
    for (const e of [...pool.screens, ...pool.hoardings]) expect(clickOf(pool, e), e.id).toBeUndefined();
    expect(pool.advertisers?.deet?.name).toBe('Deet Studios');
    expect(pool.advertisers?.worldstreet?.name).toBe('WorldStreet');
  });

  it('only trading creatives are "finance"', () => {
    const finance = [...pool.sponsored!.screens, ...pool.sponsored!.hoardings].filter((e) => e.category === 'finance');
    expect(finance.map((e) => e.advertiser)).toEqual(finance.map(() => 'worldstreet'));
    for (const e of finance) expect(e.title).toMatch(/Trade/);
  });

  it('checkClick: https only, no credentials, no bare IPs or ports, short tags', () => {
    expect(checkClick(ok)).toEqual([]);
    expect(checkClick({ ...ok, utm: 'street-market', category: 'finance' })).toEqual([]);
    for (const url of ['http://deet.studio', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pw@deet.studio', 'https://localhost/x', 'https://10.0.0.1/', 'https://deet.studio:8443/', 'deet.studio', '', `https://deet.studio/${'a'.repeat(600)}`]) {
      expect(checkClick({ ...ok, url }).length, url).toBeGreaterThan(0);
    }
    expect(checkClick({ ...ok, utm: 'has space' })).toHaveLength(1);
    expect(checkClick({ ...ok, name: '' })).toHaveLength(1);
    expect(checkClick({ ...ok, category: 'Finance!' })).toHaveLength(1);
  });

  it('checkManifest refuses a frame whose destination is not https', () => {
    const m = houseManifest('street-market', slots, pool, 0);
    const known = (c: string) => poolEntries(pool).some((e) => e.id === c);
    expect(checkManifest(m, slots, known)).toEqual([]);
    const bad: AdManifest = { ...m, slots: m.slots.map((s, i) => (i === 0 ? { ...s, frames: s.frames.map((f, j) => (j === 0 ? { ...f, click: { ...ok, url: 'http://deet.studio' } } : f)) } : s)) };
    expect(checkManifest(bad, slots, known).join('\n')).toMatch(/not https/);
    // an unusable destination in the pool: the creative still shows, it just can't be saved
    const noUrl: HousePool = { ...pool, advertisers: { ...pool.advertisers, deet: { name: 'Deet Studios', url: 'http://deet.studio' } } };
    const deet = pool.sponsored!.screens.find((e) => e.advertiser === 'deet' && !e.url)!;
    expect(clickOf(noUrl, deet)).toBeUndefined();
  });

  it('a Visit link carries the game as utm_source, billboard as medium, the tag and the creative; nothing about the player', () => {
    const u = new URL(visitUrl({ ...ok, url: 'https://academy.worldstreetgold.com/start?ref=x', utm: 'street-market' }, 'house:ws-academy-motion'));
    expect(u.origin).toBe('https://academy.worldstreetgold.com');
    expect(u.pathname).toBe('/start');
    expect(Object.fromEntries(u.searchParams)).toEqual({ ref: 'x', utm_source: GAME_SLUG, utm_medium: 'billboard', utm_campaign: 'street-market', utm_content: 'ws-academy-motion' });
  });
});

describe('which creative is under a point', () => {
  const cam = new Camera();
  cam.resize(1280, 720);
  const s1 = slots[0]!;
  cam.x = s1.pos[0];
  cam.y = s1.pos[1] - 2;
  const pose = planePose(cam);
  const m = houseManifest('street-market', slots, pool, 3);
  const lit = slots.map(() => 1);
  const r: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  projectToPlane({ x0: s1.pos[0] - s1.size[0] / 2, x1: s1.pos[0] + s1.size[0] / 2, y0: s1.pos[1] - s1.size[1] / 2, y1: s1.pos[1] + s1.size[1] / 2 }, s1.pos[2], pose.x, pose.y, pose.z, r);
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;

  it('the frame showing now on a lit board; nothing off the board or on a dark one', () => {
    const t = 12_000;
    const hit = creativeAt(slots, m, lit, pose, t, cx, cy);
    expect(hit?.slot.slotId).toBe(s1.slotId);
    expect(hit?.frame).toBe(m.slots[0]!.frames[frameIndex(s1, t)]);
    expect(creativeAt(slots, m, lit, pose, t, r.x1 + 0.2, cy)).toBeNull();
    expect(creativeAt(slots, m, slots.map(() => 0.3), pose, t, cx, cy)).toBeNull();
  });

  it('during a beat’s crossfade: the outgoing frame until half way, then the incoming one', () => {
    const early = creativeAt(slots, m, lit, pose, 20_100, cx, cy)!;
    const late = creativeAt(slots, m, lit, pose, 20_400, cx, cy)!;
    expect(early.frame).toBe(m.slots[0]!.frames[frameIndex(s1, 19_999)]);
    expect(late.frame).toBe(m.slots[0]!.frames[frameIndex(s1, 20_000)]);
  });

  it('the boards answer only once their creatives are in and a surface is lit', () => {
    const boards = new AdBoards('street-market', slots, pool, '/assets/ads/street_market/');
    boards.update(12_000, pose, 1 / 60, 3);
    // tests upload nothing: every surface stays switched off, so nothing can be saved
    expect(boards.pickAt(cx, cy)).toBeNull();
    boards.dispose();
  });
});
