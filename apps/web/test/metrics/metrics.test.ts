/** Play stats on the device (src/metrics, docs/16): the consent rules, the sender, ad views, the house-ad audience weighting. */
import type { ClientBatch } from '@military-forge/shared';
import { describe, expect, it } from 'vitest';
import { AdViewCounter } from '../../src/metrics/adViews';
import { MetricsClient, newSessionId, type Transport } from '../../src/metrics/client';
import { CONSENT_KEY, Consent, analyticsOn, anonymousOn, promptDue, readChoice } from '../../src/metrics/consent';
import { affinity, contextTags, type AdContext } from '../../src/render3d/ads/audience';
import { houseManifest, type AdSlot, type HousePool } from '../../src/render3d/ads/manifest';

function store() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

function fakeTransport() {
  const sent: { body: ClientBatch; token: string | null; beacon: boolean }[] = [];
  const t: Transport = {
    async post(_url, body, token) {
      sent.push({ body: JSON.parse(body) as ClientBatch, token, beacon: false });
    },
    beacon(_url, body) {
      sent.push({ body: JSON.parse(body) as ClientBatch, token: null, beacon: true });
      return true;
    },
  };
  return { sent, t };
}

describe('consent', () => {
  it('asks where opt-in, tells where opt-out, and never asks a browser that said no', () => {
    const c = new Consent(store(), false);
    expect(promptDue(c.get())).toBeNull(); // the API hasn't answered
    c.configure('opt-in', false);
    expect([promptDue(c.get()), analyticsOn(c.get())]).toEqual(['ask', false]);
    c.configure('opt-out', false);
    expect([promptDue(c.get()), analyticsOn(c.get())]).toEqual(['tell', true]);
    const gpc = new Consent(store(), true);
    gpc.configure('opt-out', false);
    expect([promptDue(gpc.get()), analyticsOn(gpc.get()), anonymousOn(gpc.get())]).toEqual([null, false, false]);
    gpc.set(true, 'settings'); // the player's own yes wins over the browser's signal
    expect([analyticsOn(gpc.get()), anonymousOn(gpc.get())]).toEqual([true, true]);
  });

  it('keeps the answer on the device; Delete my data makes it a no', () => {
    const s = store();
    const c = new Consent(s, false, () => 42);
    c.set(true, 'prompt');
    expect(readChoice(s)).toEqual({ analytics: true, at: 42, via: 'prompt' });
    expect(new Consent(s, false).get().choice?.analytics).toBe(true);
    c.reset();
    expect(s.m.has(CONSENT_KEY)).toBe(false);
    expect(analyticsOn(c.get())).toBe(false);
  });
});

describe('MetricsClient', () => {
  it('holds personal events until a yes, sends anonymous ones without ids, and drops what waited on a no', async () => {
    const c = new Consent(store(), false);
    const { sent, t } = fakeTransport();
    const client = new MetricsClient({ consent: c, transport: t, token: () => 'tok', build: 'b1', now: () => 1000 });
    client.track({ k: 'funnel', step: 'landing' });
    client.track({ k: 'error', e: 'route-failed', where: 'locker' });
    expect(client.waiting().pending).toHaveLength(1);
    await client.flush();
    expect(sent[0]!.body).toMatchObject({ consent: 'none', sid: null, events: [{ k: 'error', t: 1000 }] });
    expect(sent[0]!.token).toBeNull();
    c.configure('opt-in', false);
    c.set(true, 'prompt');
    await client.flush();
    expect(sent[1]!.body).toMatchObject({ consent: 'analytics', sid: client.sid, build: 'b1', events: [{ k: 'funnel', step: 'landing' }] });
    expect(sent[1]!.token).toBe('tok');

    const no = new Consent(store(), false);
    const c2 = new MetricsClient({ consent: no, transport: t });
    c2.track({ k: 'feature', f: 'locker' });
    no.configure('opt-in', false);
    no.set(false, 'prompt');
    expect(c2.waiting()).toEqual({ queue: [], pending: [] });
  });

  it('beacons what is left when the page goes, in batches of at most 50', async () => {
    const c = new Consent(store(), false);
    c.set(true, 'settings');
    const { sent, t } = fakeTransport();
    const client = new MetricsClient({ consent: c, transport: t });
    for (let i = 0; i < 24; i++) client.track({ k: 'feature', f: 'settings' });
    for (let i = 0; i < 40; i++) client.track({ k: 'session.active', s: 1 });
    await client.flush(true);
    expect(sent.every((s) => s.body.events.length <= 50)).toBe(true);
    expect(sent.reduce((a, s) => a + s.body.events.length, 0)).toBe(64);
    expect(sent.some((s) => s.beacon)).toBe(true);
  });

  it('with a yes, waits for the session token before a normal send (the page closing sends anyway)', async () => {
    const c = new Consent(store(), false);
    c.set(true, 'settings');
    const { sent, t } = fakeTransport();
    let token: string | null = null;
    const client = new MetricsClient({ consent: c, transport: t, token: () => token, waitForToken: true });
    client.track({ k: 'funnel', step: 'home' });
    await client.flush();
    expect(sent).toHaveLength(0);
    token = 'tok';
    await client.flush();
    expect(sent.map((s) => s.token)).toEqual(['tok']);
    client.track({ k: 'feature', f: 'locker' });
    token = null;
    await client.flush(true);
    expect(sent.at(-1)!.beacon).toBe(true);
  });

  it('makes a fresh random session id per page load', () => {
    const a = newSessionId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(newSessionId()).not.toBe(a);
  });
});

describe('ad views', () => {
  it('counts a creative after a continuous second viewable, adds its time, and only while viewing is possible', () => {
    const v = new AdViewCounter();
    const deet = { creative: 'house:deet-a', advertiser: 'deet', visible: 0.8, share: 0.04 };
    const tiny = { creative: 'house:deet-b', advertiser: 'deet', visible: 1, share: 0.01 };
    for (let i = 0; i < 4; i++) v.check([deet, tiny], true);
    v.check([deet], false); // a menu came up: the run breaks
    for (let i = 0; i < 4; i++) v.check([deet], true);
    expect(v.drain()).toEqual([]);
    for (let i = 0; i < 5; i++) v.check([deet], true);
    expect(v.drain()).toEqual([{ k: 'ad.view', c: 'house:deet-a', adv: 'deet', ms: 1000, share: 40 }]);
    expect(v.drain()).toEqual([]);
  });
});

describe('house-ad audience', () => {
  const ctx: AdContext = { device: 'touch', sessionBand: 'short', timeOfDay: 'evening', modePref: 'team', tenure: 'new' };

  it('gives a creative a turn per matching audience, at most 3, never to finance', () => {
    expect([...contextTags(ctx)].sort()).toEqual(['device:touch', 'mode:team', 'session:short', 'tenure:new', 'time:evening']);
    expect(affinity({ prefer: ['device:touch', 'time:evening', 'mode:team'] }, ctx)).toBe(3);
    expect(affinity({ prefer: ['device:pad'] }, ctx)).toBe(1);
    expect(affinity({ prefer: ['device:touch'], category: 'finance' }, ctx)).toBe(1);
    expect(affinity({ prefer: ['device:touch'] }, null)).toBe(1);
  });

  it('weights within an advertiser’s share and leaves the shares alone', () => {
    const slot: AdSlot = { slotId: 'm/S1', kind: 'screen', format: '4:3', frames: 6, dwellMs: 10_000, phaseIdx: 0, pos: [0, 0, -6], size: [4, 3], yawDeg: 0, houseSet: [], tags: [] };
    const e = (id: string, advertiser: string, prefer?: string[]) => ({ id, file: `${id}.webp`, title: id, advertiser, ...(prefer ? { prefer } : {}) });
    const pool: HousePool = {
      version: 1,
      map: 'm',
      screens: [],
      hoardings: [],
      sponsored: { screens: [e('house:d1', 'deet', ['device:touch']), e('house:d2', 'deet'), e('house:w1', 'ws')], hoardings: [] },
      advertisers: { deet: { name: 'Deet', url: 'https://deet.example', weight: 2 }, ws: { name: 'WS', url: 'https://ws.example', weight: 1 } },
    };
    const frames = (aff?: (x: { prefer?: string[] }) => number) => houseManifest('m', [slot], pool, 0, aff ? { affinity: aff } : {}).slots[0]!.frames.map((f) => f.c);
    const plain = frames();
    const touch = frames((x) => affinity(x, ctx));
    expect(plain.filter((c) => c.startsWith('house:w')).length).toBe(touch.filter((c) => c.startsWith('house:w')).length);
    expect(touch.filter((c) => c === 'house:d1').length).toBeGreaterThan(plain.filter((c) => c === 'house:d1').length);
  });
});
