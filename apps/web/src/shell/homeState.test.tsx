/**
 * One Home for every player state (UX atlas 1 Nov, batch 3: UX-01, UX-11, UX-14, UX-15): which state a
 * player is in, the one primary action each state's poster has (desktop and phone), what isn't drawn
 * under 18, and the player's own name kept for a time the API can't be reached.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGE_KEY } from './age';
import { Api, ApiError } from './api';
import { ControllerContext } from './context';
import { ShellController, offlineName, rememberName, type GameHost } from './controller';
import { MINOR_TAG, OFFLINE_LINE, SUSPENDED_LINE, homePlan, homeState, type HomeState } from './homeState';
import { Home } from './screens/Home';
import { PhoneHome } from './screens/phone/PhoneHome';
import { createShellStore, type Profile } from './store';
import { homePrimary } from './useHomePlan';
import { newFacts } from '../tour/facts';
import { recommend } from '../tour/orders';

const saved = new Map<string, string>();
const storage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
} as unknown as Storage;
beforeEach(() => {
  saved.clear();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('location', { pathname: '/', search: '', hash: '', origin: 'https://play.example', host: 'play.example', protocol: 'https:' });
});
afterEach(() => vi.unstubAllGlobals());

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ');

const online: Profile = { nickname: 'Ade', changeableAt: null, offline: false };
const PROFILES: Record<HomeState, Profile> = {
  first: online,
  returning: online,
  minor: { ...online, minor: true },
  offline: { ...online, offline: true },
  suspended: { ...online, offline: true, suspended: { until: null } },
};

describe("Home's state", () => {
  it('suspended first, then under 18 (whatever the network), then offline, then first visit or returning', () => {
    expect(homeState({ offline: true, minor: true, suspended: { until: null } }, true, 3)).toBe('suspended');
    expect(homeState({ offline: true, minor: true }, false, 3)).toBe('minor');
    expect(homeState({ offline: false }, true, 0)).toBe('minor'); // the device's answer, before the account knows
    expect(homeState({ offline: true }, false, 3)).toBe('offline');
    expect(homeState(null, false, 0)).toBe('offline');
    expect(homeState({ offline: false }, false, 0)).toBe('first');
    expect(homeState({ offline: false }, false, 1)).toBe('returning');
  });

  it('each state has one primary action: Play now online, Training otherwise', () => {
    expect(homePlan('first').primary).toBe('play');
    expect(homePlan('returning').primary).toBe('play');
    for (const s of ['minor', 'offline', 'suspended'] as const) expect(homePlan(s).primary).toBe('training');
  });

  it('under 18 nothing leads to a refusal: no room, no Join, no Rooms; First flight and Live fire instead', () => {
    const p = homePlan('minor');
    expect([p.create.show, p.local.show, p.join.show, p.rooms.show]).toEqual(['none', 'none', 'none', 'none']);
    expect(p.tickets).toEqual(['flight', 'live-fire']);
    expect(p.tag).toEqual({ tone: 'paper', text: MINOR_TAG });
    expect(p.bots).toBe(false);
  });

  it('offline and suspended: the online ways in wait and say why; a local room still works', () => {
    expect(homePlan('offline').create).toEqual({ show: 'off', why: 'Needs a connection' });
    expect(homePlan('offline').join.show).toBe('on'); // a local room's code, through the relay
    expect(homePlan('offline').line).toBe(OFFLINE_LINE);
    expect(homePlan('suspended').join).toEqual({ show: 'off', why: 'Online play is paused' });
    expect(homePlan('suspended').line).toBe(SUSPENDED_LINE);
    expect(homePlan('offline').local.show).toBe('on');
  });

  it("the poster's action: Play now online; Training goes straight to training (never the 18+ refusal)", () => {
    const ctl = { playNow: vi.fn(), go: vi.fn() };
    homePrimary(ctl, homePlan('returning'));
    expect(ctl.playNow).toHaveBeenCalledOnce();
    for (const s of ['minor', 'offline', 'suspended'] as const) homePrimary(ctl, homePlan(s));
    expect(ctl.playNow).toHaveBeenCalledOnce();
    expect(ctl.go.mock.calls).toEqual([[{ to: 'training' }], [{ to: 'training' }], [{ to: 'training' }]]);
  });
});

describe('Home and the phone Home draw the state', () => {
  const ctl = () =>
    ({ store: createShellStore({ screen: { name: 'home' } }), host: { online: null }, go: vi.fn(), playNow: vi.fn(), openOverlay: vi.fn(), openSettings: vi.fn(), openAccount: vi.fn(), api: { ping: () => Promise.resolve(30) } }) as unknown as ShellController;
  const draw = (state: HomeState, phone = false) => {
    const store = createShellStore({ profile: PROFILES[state] });
    return renderToStaticMarkup(<ControllerContext.Provider value={ctl()}>{phone ? <PhoneHome store={store} /> : <Home store={store} />}</ControllerContext.Provider>);
  };
  /** the poster's primary button's words */
  const primary = (html: string) => textOf(/<button[^>]*data-home-primary=""[^>]*>.*?<\/button>/.exec(html)?.[0] ?? '').trim();

  for (const phone of [false, true]) {
    const where = phone ? 'phone' : 'desktop';

    it(`${where}: online, Play now is the one primary, with Create room, Join and the Rooms tab`, () => {
      const html = draw('first', phone);
      expect(primary(html)).toBe('Play now');
      expect(html.match(/data-home-primary/g)).toHaveLength(1);
      expect(html).toContain('data-pad-first');
      for (const t of ['Create room', 'Rooms', 'Local room']) expect(textOf(html)).toContain(t);
    });

    it(`${where}: under 18, Training is the primary; Play now, Create room, Join, Local room and Rooms are not drawn`, () => {
      const html = draw('minor', phone);
      expect(primary(html)).toBe('Training');
      const words = textOf(html);
      for (const t of ['Play now', 'Create room', 'Join', 'Local room', 'Rooms']) expect(words).not.toContain(t);
      for (const t of ['First flight', 'Live fire', MINOR_TAG]) expect(words).toContain(t);
      // honest: nothing invites a different answer
      expect(words).not.toMatch(/change your answer|are you sure|try again/i);
    });

    it(`${where}: offline, Training is the primary, the name stays, Offline says so`, () => {
      const html = draw('offline', phone);
      expect(primary(html)).toBe('Training');
      expect(textOf(html)).toContain('Offline');
      expect(textOf(html)).toContain('Ade');
      expect(html).toMatch(/data-tour="create" disabled=""/);
    });

    it(`${where}: suspended, Training is the primary and Join waits`, () => {
      const html = draw('suspended', phone);
      expect(primary(html)).toBe('Training');
      expect(textOf(html)).toContain(SUSPENDED_LINE.replace(/'/g, "'"));
      expect(html).toMatch(/disabled=""[^>]*data-tour="join"|data-tour="join"[^>]*disabled=""/);
    });
  }

  it('desktop: Install app is no longer in the top bar as a volt word (UX-11); Enter hint follows the primary', () => {
    expect(draw('minor')).toMatch(/<kbd[^>]*>Enter<\/kbd>[^]*?Training/);
    expect(draw('first')).not.toContain('mf-install-btn__word');
  });
});

describe('the name offline (UX-15)', () => {
  it("the player's own name, as the API last knew it, is the offline name; a stand-in only on a device never online", () => {
    rememberName('Kemi', () => storage);
    expect(offlineName(undefined, () => storage)).toBe('Kemi');
    saved.clear();
    rememberName('', () => storage);
    expect(saved.size).toBe(0);
  });

  it('the controller keeps the name as it signs in, and the offline Home after a failed start uses it', async () => {
    const host = { local: null, online: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost;
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('history', { pushState: vi.fn(), replaceState: vi.fn(), state: null });
    const store = createShellStore();
    new ShellController(store, host, {} as Api);
    store.setState({ profile: { nickname: 'Kemi', changeableAt: null, offline: false } });
    expect(saved.get('profile.offlineName.v1')).toBe('Kemi');
    // next start: the API is down
    const down = createShellStore();
    const ctl = new ShellController(down, host, { restore: vi.fn(async () => Promise.reject(new ApiError(0, 'network', 'offline'))) } as unknown as Api);
    await ctl.boot();
    expect(down.getState().profile).toMatchObject({ nickname: 'Kemi', offline: true });
  });

  it('an under-18 device stays under 18 offline (training only, no friends)', async () => {
    saved.set(AGE_KEY, JSON.stringify({ adult: false, at: 1 }));
    const host = { local: null, online: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost;
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('history', { pushState: vi.fn(), replaceState: vi.fn(), state: null });
    const store = createShellStore();
    const ctl = new ShellController(store, host, { restore: vi.fn(async () => Promise.reject(new ApiError(0, 'network', 'offline'))) } as unknown as Api);
    await ctl.boot();
    expect(store.getState().profile).toMatchObject({ offline: true, minor: true });
    expect(homeState(store.getState().profile, false, 0)).toBe('minor');
  });
});

describe('Next orders follow the state', () => {
  const ctx = { offline: false, touch: false, pad: false, drillDone: false };
  it('under 18 no card leads to a room (Create room, Join, a local room)', () => {
    const f = { ...newFacts(0), invited: true, kills: 3, matches: { local: 1, online: 0, finished: 1, wonInARow: 0 } };
    const kinds = (c: Parameters<typeof recommend>[1]) => recommend(f, c, 1).map((x) => x.action.kind);
    expect(kinds(ctx)).toEqual(expect.arrayContaining(['create']));
    for (const k of kinds({ ...ctx, minor: true })) expect(['create', 'join', 'local']).not.toContain(k);
    expect(kinds({ ...ctx, offline: true, minor: true })).not.toContain('local');
  });

  it("a suspended account's local-room card says why honestly (not the server)", () => {
    const f = newFacts(0);
    expect(recommend(f, { ...ctx, offline: true }, 1).find((c) => c.id === 'host-local')?.reason).toBe("The game server can't be reached");
    expect(recommend(f, { ...ctx, offline: true, suspended: true }, 1).find((c) => c.id === 'host-local')?.reason).toBe('Online play is paused');
  });
});
