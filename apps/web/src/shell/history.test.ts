/**
 * The back stack (history.ts; audit 2 N-07, N-18, N-19; audit 1 C-01, C-02, C-43, A-35): every row of
 * the nav audit's "what Back does, per screen" table, on a fake browser history that behaves like a
 * real one (pushState truncates Forward, go() is asynchronous and fires popstate, a #hash set by
 * assignment makes an untagged entry).
 */
import { MatchPhase } from '@military-forge/sim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGE_KEY } from './age';
import type { Api } from './api';
import { ShellController, tabTitle, type GameHost } from './controller';
import { activeRouteBack, setActiveRouteBack } from './focus';
import { NavHistory, closeTop, type NavWindow } from './history';
import type { MatchView } from './matchView';
import type { LobbyView } from './onlineView';
import { createShellStore, findRoute, registerRoute, type ShellState } from './store';

/** A tab's session history: entries, the one shown, popstate and hashchange as browsers send them. */
class FakeBrowser implements NavWindow {
  entries: { state: unknown; url: string }[];
  index = 0;
  /** traversals asked for (history.go), delivered by flush() like the browser's task */
  private pending: number[] = [];
  private listeners: Record<string, Set<() => void>> = { popstate: new Set(), hashchange: new Set() };
  /** the page went past its first entry (to the previous site, or about:blank) */
  leftSite = false;

  constructor(url = '/') {
    this.entries = [{ state: null, url }];
  }

  get history(): NavWindow['history'] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const b = this;
    return {
      get state() {
        return b.entries[b.index]!.state;
      },
      pushState(state: unknown, _t: string, url?: string | URL | null) {
        b.entries.splice(b.index + 1);
        b.entries.push({ state: structuredClone(state), url: String(url ?? b.url) });
        b.index++;
      },
      replaceState(state: unknown, _t: string, url?: string | URL | null) {
        b.entries[b.index] = { state: structuredClone(state), url: String(url ?? b.url) };
      },
      go(delta?: number) {
        b.pending.push(delta ?? 0);
      },
    } as NavWindow['history'];
  }

  get url(): string {
    return this.entries[this.index]!.url;
  }

  get location(): NavWindow['location'] {
    const u = new URL(this.url, 'https://play.example');
    return { pathname: u.pathname, search: u.search, hash: u.hash };
  }

  addEventListener(type: 'popstate' | 'hashchange', fn: () => void): void {
    this.listeners[type]!.add(fn);
  }

  removeEventListener(type: 'popstate' | 'hashchange', fn: () => void): void {
    this.listeners[type]!.delete(fn);
  }

  setTimeout(): number {
    return 0; // traversals are delivered by flush(): no timeouts needed
  }

  clearTimeout(): void {}

  /** The browser's Back button (or Android's back gesture): `steps` entries at once (a long-press list). */
  back(steps = 1): void {
    this.move(-steps);
    this.flush();
  }

  forward(): void {
    this.move(1);
    this.flush();
  }

  /** `location.hash = …` (a Home tab): a new untagged entry, then popstate and hashchange. */
  setHash(hash: string): void {
    const u = new URL(this.url, 'https://play.example');
    u.hash = hash;
    this.entries.splice(this.index + 1);
    this.entries.push({ state: null, url: u.pathname + u.search + u.hash });
    this.index++;
    this.fire('popstate');
    this.fire('hashchange');
  }

  /** Delivers what history.go() asked for, the way the browser's task would. */
  flush(): void {
    for (let guard = 0; this.pending.length > 0 && guard < 20; guard++) this.move(this.pending.shift()!);
  }

  private move(delta: number): void {
    const to = this.index + delta;
    if (to < 0) {
      this.leftSite = true;
      return;
    }
    if (to >= this.entries.length || delta === 0) return;
    const hashBefore = this.location.hash;
    this.index = to;
    this.fire('popstate');
    if (this.location.hash !== hashBefore) this.fire('hashchange');
  }

  private fire(type: string): void {
    for (const fn of [...this.listeners[type]!]) fn();
  }
}

describe('NavHistory: one entry per layer', () => {
  it('opening pushes one entry, closing goes back over it: history never grows on close (C-02)', () => {
    const b = new FakeBrowser();
    const nav = new NavHistory(b);
    for (let i = 0; i < 3; i++) {
      nav.push({ key: 'route:locker', hash: '#/locker' });
      expect(b.url).toBe('/#/locker');
      nav.close('route:locker');
      b.flush();
      expect(b.url).toBe('/');
    }
    expect(b.entries.length).toBe(2); // Home and the one Forward entry, not seven
    expect(b.index).toBe(0);
    nav.dispose();
  });

  it("the browser's Back closes the top layer only, and tells it", () => {
    const b = new FakeBrowser();
    const nav = new NavHistory(b);
    const popped: string[] = [];
    nav.push({ key: 'route:locker', hash: '#/locker', popped: () => popped.push('locker') });
    nav.push({ key: 'overlay:settings', hash: '#/settings/audio', popped: () => popped.push('settings') });
    b.back();
    expect(popped).toEqual(['settings']);
    expect(nav.keys()).toEqual(['route:locker']);
    b.back();
    expect(popped).toEqual(['settings', 'locker']);
    expect(nav.keys()).toEqual([]);
    nav.dispose();
  });

  it('a jump of several entries (a long-pressed Back) closes each layer it passed, top first', () => {
    const b = new FakeBrowser();
    const nav = new NavHistory(b);
    const popped: string[] = [];
    for (const k of ['a', 'b', 'c']) nav.push({ key: k, hash: `#/${k}`, popped: () => popped.push(k) });
    b.back(3);
    expect(popped).toEqual(['c', 'b', 'a']);
    expect(nav.keys()).toEqual([]);
    nav.dispose();
  });

  it('Forward never brings a closed layer back: it steps straight back', () => {
    const b = new FakeBrowser();
    const nav = new NavHistory(b);
    nav.push({ key: 'route:locker', hash: '#/locker' });
    b.back();
    b.forward();
    expect(nav.keys()).toEqual([]);
    expect(b.url).toBe('/');
    nav.dispose();
  });

  it('a #hash set by assignment (a Home tab) becomes the layer it names, on the entry the browser made', () => {
    const b = new FakeBrowser();
    const nav = new NavHistory(b);
    nav.resolve = (hash) => (hash === '#/armory' ? { key: 'route:armory', hash } : null);
    b.setHash('#/armory');
    expect(nav.routeId()).toBe('armory');
    expect(b.entries.length).toBe(2);
    nav.close('route:armory');
    b.flush();
    expect(b.url).toBe('/');
    // an anchor (the landing's #about) is no layer
    b.setHash('#about');
    expect(nav.keys()).toEqual([]);
    nav.dispose();
  });

  it('pushes asked for while a close is on its way wait for it (no entry lands under the one going)', () => {
    const b = new FakeBrowser();
    const nav = new NavHistory(b);
    nav.push({ key: 'overlay:join', hash: '#/join' });
    nav.close('overlay:join');
    nav.push({ key: 'play', hash: '', path: '/r/KMTXRA' });
    expect(b.url).toBe('/#/join'); // the browser hasn't gone back yet
    b.flush();
    expect(b.url).toBe('/r/KMTXRA');
    expect(b.entries.map((e) => e.url)).toEqual(['/', '/r/KMTXRA']);
    nav.dispose();
  });

  it('never goes back past the page’s first entry: a layer the page opened on closes by rewriting the address', () => {
    const b = new FakeBrowser('/r/KMTXRA');
    const nav = new NavHistory(b);
    nav.setBasePath('/');
    b.flush();
    expect(b.url).toBe('/');
    nav.push({ key: 'x', hash: '#/x' });
    nav.close('x');
    nav.close('x');
    b.flush();
    expect(b.leftSite).toBe(false);
    expect(b.index).toBe(0);
    nav.dispose();
  });
});

// ---------------------------------------------------------------- the per-screen table, through the controller

const lobby = (over: Partial<LobbyView> = {}): LobbyView => ({ players: [], isHost: true, ready: false, bots: 0, botLevel: 'normal', minPlayers: 2, mapName: 'Street Market', ...over }) as unknown as LobbyView;
const match = (phase: MatchPhase): MatchView => ({ phase, mapName: 'Street Market', results: null }) as unknown as MatchView;
const connected = { state: 'connected', detail: '', code: 0, since: 0, until: 0, attempt: 0, lastPingMs: 30, lossPct: 0 } as const;

describe('what Back does, per screen (the nav audit’s table)', () => {
  let b: FakeBrowser;
  let ctl: ShellController;
  let leave: ReturnType<typeof vi.fn>;
  let stop: () => void;

  function setup(url = '/', state: Partial<ShellState> = {}) {
    b = new FakeBrowser(url);
    vi.stubGlobal('history', b.history);
    // the address as the fake browser shows it, read live
    const fb = b;
    vi.stubGlobal('location', {
      origin: 'https://play.example',
      host: 'play.example',
      protocol: 'https:',
      get pathname() {
        return fb.location.pathname;
      },
      get search() {
        return fb.location.search;
      },
      get hash() {
        return fb.location.hash;
      },
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { addEventListener: b.addEventListener.bind(b), removeEventListener: b.removeEventListener.bind(b), setTimeout: () => 0, clearTimeout: () => {} }));
    leave = vi.fn();
    const online = { leave, startMatch: vi.fn(), setMatchSettings: vi.fn() };
    const host = { local: null, online, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn(), tour: { restart: vi.fn(), skip: vi.fn() } } as unknown as GameHost;
    const store = createShellStore({ title: 'off', profile: { nickname: 'Ade', changeableAt: null, offline: false }, ...state });
    const api = { createRoom: () => new Promise(() => {}), joinRoom: () => new Promise(() => {}) } as unknown as Api;
    ctl = new ShellController(store, host, api);
    // the shell's route follows the stack (index.tsx syncRoute)
    stop = ctl.nav.onChange(() => store.setState({ route: findRoute(ctl.nav.routeId() ?? '') }));
    return store;
  }
  /** a room's lobby, its match, or its results, as the room screen shows them */
  function inRoom(phase: MatchPhase | null) {
    ctl.store.setState({ screen: { name: 'room', code: 'KMTXRA' }, connection: { ...connected }, lobby: lobby(), match: phase === null ? null : match(phase) });
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === AGE_KEY ? JSON.stringify({ adult: true, birthYear: 1995, at: 0 }) : null), setItem: () => {}, removeItem: () => {} });
    for (const id of ['locker', 'armory', 'store', 'creator', 'briefing']) registerRoute({ id, title: id[0]!.toUpperCase() + id.slice(1), mount: () => {} });
  });
  afterEach(() => {
    stop?.();
    ctl?.nav.dispose();
    setActiveRouteBack(null);
    vi.unstubAllGlobals();
  });

  it('Home: nothing of ours to close (Escape and B do nothing; the browser leaves the site)', () => {
    const store = setup();
    store.setState({ screen: { name: 'home' } });
    expect(closeTop()).toBe(false);
    expect(b.entries.length).toBe(1);
    b.back();
    expect(b.leftSite).toBe(true);
  });

  it('Locker, Armory, Store → Home; Back, Escape and the route’s own Back agree', () => {
    const store = setup();
    store.setState({ screen: { name: 'home' } });
    for (const id of ['locker', 'armory', 'store']) {
      b.setHash(`#/${id}`); // Home's tab
      expect(store.getState().route?.id).toBe(id);
      b.back();
      expect(store.getState().route).toBeNull();
      ctl.openRoute(id);
      expect(closeTop()).toBe(true); // Escape / B
      b.flush();
      expect(store.getState().route).toBeNull();
      expect(b.url).toBe('/');
    }
    expect(b.index).toBe(0);
  });

  it('the creator from the Locker → back to the Locker', () => {
    const store = setup();
    store.setState({ screen: { name: 'home' } });
    ctl.openRoute('locker');
    ctl.openRoute('creator');
    b.back();
    expect(store.getState().route?.id).toBe('locker');
    ctl.openRoute('creator');
    ctl.closeRoute(); // its Back button
    b.flush();
    expect(store.getState().route?.id).toBe('locker');
  });

  it('the first-run creator → Back is its Skip for now (the Briefing); the Briefing → Back skips training, Home', () => {
    const store = setup();
    store.setState({ screen: { name: 'home' } });
    const skip = vi.fn(() => ctl.swapRoute('briefing'));
    ctl.openRoute('creator');
    setActiveRouteBack(skip); // what main.ts's creator mount gives RouteView
    b.back();
    expect(skip).toHaveBeenCalledTimes(1);
    expect(store.getState().route?.id).toBe('briefing');
    setActiveRouteBack(null);
    b.back();
    expect(store.getState().route).toBeNull();
    // Escape in the first creator is the same Skip, and the Briefing takes the creator's place
    ctl.openRoute('creator');
    setActiveRouteBack(skip);
    expect(closeTop()).toBe(true);
    expect(store.getState().route?.id).toBe('briefing');
    expect(activeRouteBack()).toBe(skip);
  });

  it('Back from Settings never lands in the creator or the Briefing (C-43, N-07)', () => {
    const store = setup();
    store.setState({ screen: { name: 'home' } });
    ctl.openRoute('creator');
    ctl.swapRoute('briefing');
    ctl.closeRoute(); // the Briefing answered
    b.flush();
    ctl.openSettings('audio');
    expect(b.url).toBe('/#/settings/audio');
    b.back();
    expect(store.getState().overlay).toBeNull();
    expect(store.getState().route).toBeNull();
    expect(b.url).toBe('/');
  });

  it('Settings, Join, Edit name → Back closes them; a Settings tab rewrites its entry (no new one)', () => {
    const store = setup();
    store.setState({ screen: { name: 'home' } });
    for (const o of ['settings', 'join', 'name'] as const) {
      ctl.openOverlay(o);
      expect(store.getState().overlay).toBe(o);
      b.back();
      expect(store.getState().overlay).toBeNull();
    }
    ctl.openSettings('graphics');
    ctl.setSettingsTab('controls');
    expect(b.url).toBe('/#/settings/controls');
    expect(b.entries.length).toBe(2);
    expect(closeTop()).toBe(true);
    b.flush();
    expect(store.getState().overlay).toBeNull();
    expect(b.index).toBe(0);
  });

  it('the Friends panel → Back closes it (one entry, its own close)', () => {
    const store = setup();
    store.setState({ screen: { name: 'home' } });
    const close = vi.fn(() => ctl.closedLayer('friends'));
    ctl.openLayer('friends', '#/friends', close);
    expect(b.url).toBe('/#/friends');
    b.back();
    expect(close).toHaveBeenCalledTimes(1);
    ctl.openLayer('friends', '#/friends', close);
    expect(closeTop()).toBe(true); // B
    expect(close).toHaveBeenCalledTimes(2);
    b.flush();
    expect(b.url).toBe('/');
  });

  it('a match (and its countdown) → Back opens the pause menu; it never leaves at once (N-07)', () => {
    setup();
    ctl.go({ to: 'join', code: 'KMTXRA' });
    for (const phase of [MatchPhase.Countdown, MatchPhase.InProgress]) {
      inRoom(phase);
      b.back();
      expect(leave).not.toHaveBeenCalled();
      expect(ctl.store.getState()).toMatchObject({ screen: { name: 'room' }, overlay: 'menu', menuAsk: false });
      expect(b.url).toBe('/r/KMTXRA');
      // the pause menu → Back closes it (resume)
      b.back();
      expect(ctl.store.getState().overlay).toBeNull();
      expect(b.url).toBe('/r/KMTXRA');
    }
  });

  it('a lobby and the results → Back asks "Leave the room?" (the pause menu on its question)', () => {
    setup();
    ctl.go({ to: 'join', code: 'KMTXRA' });
    for (const phase of [MatchPhase.Waiting, MatchPhase.Postgame]) {
      inRoom(phase);
      b.back();
      expect(ctl.store.getState()).toMatchObject({ overlay: 'menu', menuAsk: true });
      expect(leave).not.toHaveBeenCalled();
      b.back();
      expect(ctl.store.getState()).toMatchObject({ overlay: null, menuAsk: false });
    }
  });

  it('Settings opened from the pause menu → back to the pause menu', () => {
    setup();
    ctl.go({ to: 'join', code: 'KMTXRA' });
    inRoom(MatchPhase.InProgress);
    ctl.openOverlay('menu');
    ctl.openSettings('audio');
    b.back();
    expect(ctl.store.getState().overlay).toBe('menu');
    ctl.openSettings('audio');
    expect(closeTop()).toBe(true); // Escape / B: the same
    b.flush();
    expect(ctl.store.getState().overlay).toBe('menu');
  });

  it('training, Live fire and First flight → Back opens the pause menu', () => {
    setup();
    ctl.store.setState({ screen: { name: 'home' } });
    ctl.go({ to: 'training' });
    b.back();
    expect(ctl.store.getState()).toMatchObject({ screen: { name: 'training' }, overlay: 'menu' });
    b.back();
    ctl.startFlight();
    b.flush();
    b.back();
    expect(ctl.store.getState()).toMatchObject({ screen: { name: 'training', tour: 'first-flight' }, overlay: 'menu' });
  });

  it('still joining (Connecting) → Back cancels it, Home', () => {
    setup();
    ctl.store.setState({ screen: { name: 'home' } });
    ctl.go({ to: 'join', code: 'KMTXRA' });
    expect(ctl.store.getState().screen.name).toBe('finding');
    b.back();
    expect(ctl.store.getState().screen.name).toBe('home');
    expect(b.url).toBe('/');
  });

  it('leaving a room → Home; Back and Forward never rejoin it (N-07, A-35)', () => {
    setup();
    ctl.store.setState({ screen: { name: 'home' } });
    ctl.go({ to: 'join', code: 'KMTXRA' });
    inRoom(MatchPhase.Waiting);
    ctl.leave();
    b.flush();
    expect(ctl.store.getState().screen.name).toBe('home');
    expect(b.url).toBe('/');
    expect(b.index).toBe(0);
    b.forward();
    expect(b.url).toBe('/');
    expect(ctl.store.getState().screen.name).toBe('home');
    b.back();
    expect(b.leftSite).toBe(true); // Home → leaves the site, not into the room
  });

  it('a room the page opened on (a link, a refresh): leaving rewrites the address to Home, never past the page', () => {
    setup('/r/KMTXRA');
    ctl.go({ to: 'join', code: 'KMTXRA' });
    inRoom(MatchPhase.InProgress);
    expect(b.entries.map((e) => e.url)).toEqual(['/r/KMTXRA', '/r/KMTXRA']);
    b.back(); // the link's own entry: Back still asks first
    expect(ctl.store.getState().overlay).toBe('menu');
    ctl.leave();
    b.flush();
    expect(b.url).toBe('/');
    expect(b.index).toBe(0);
    expect(b.leftSite).toBe(false);
  });

  it('the age question asked from Home → Back closes it, Home', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    setup();
    ctl.store.setState({ screen: { name: 'home' } });
    ctl.go({ to: 'create' });
    expect(ctl.store.getState().screen.name).toBe('age');
    b.back();
    expect(ctl.store.getState().screen.name).toBe('home');
    ctl.go({ to: 'create' });
    expect(closeTop()).toBe(true); // B / Escape: Not now
    expect(ctl.store.getState().screen.name).toBe('home');
  });

  it('the first visit’s name step has nothing under it: Escape stays', () => {
    const store = setup();
    store.setState({ screen: { name: 'name', then: { to: 'home' } } });
    expect(closeTop()).toBe(false);
  });

  it('deep links: #/settings/<tab> opens Settings on it over Home; Back is Home, still on the site (N-19)', async () => {
    const store = setup('/#/settings/audio');
    ctl.api.restore = async () => ({ nickname: 'Ade', nicknameChangeableAt: null }) as never;
    await ctl.boot();
    expect(store.getState()).toMatchObject({ screen: { name: 'home' }, overlay: 'settings', settingsTab: 'audio' });
    b.back();
    expect(store.getState().overlay).toBeNull();
    expect(b.url).toBe('/');
    expect(b.leftSite).toBe(false);
  });

  it('deep links: a route the page opens on (#/locker) sits over Home', () => {
    const store = setup('/#/locker');
    expect(store.getState().route?.id ?? findRoute(ctl.nav.routeId() ?? '')?.id).toBe('locker');
    b.back();
    expect(ctl.nav.routeId()).toBeNull();
    expect(b.url).toBe('/');
    expect(b.leftSite).toBe(false);
  });
});

describe('the tab title (C-41, D-29)', () => {
  const base = { overlay: null, route: null, match: null, lobby: null, connection: null, settingsTab: 'graphics' } as const;
  it('names the screen; Home keeps the page’s own', () => {
    expect(tabTitle({ ...base, screen: { name: 'home' } })).toBeNull();
    expect(tabTitle({ ...base, screen: { name: 'room', code: 'KTVGBD' }, connection: { ...connected }, lobby: lobby(), match: match(MatchPhase.Waiting) })).toBe('Lobby · KTVGBD · Forged Force');
    expect(tabTitle({ ...base, screen: { name: 'room', code: 'KTVGBD' }, connection: { ...connected }, lobby: lobby(), match: match(MatchPhase.InProgress) })).toBe('In match · Street Market · Forged Force');
    expect(tabTitle({ ...base, screen: { name: 'room', code: 'KTVGBD' }, connection: { ...connected }, lobby: lobby(), match: match(MatchPhase.Postgame) })).toBe('Results · Forged Force');
    expect(tabTitle({ ...base, screen: { name: 'home' }, overlay: 'settings', settingsTab: 'controls' })).toBe('Settings · Controls · Forged Force');
    expect(tabTitle({ ...base, screen: { name: 'home' }, route: { id: 'locker', title: 'Locker' } })).toBe('Locker · Forged Force');
    expect(tabTitle({ ...base, screen: { name: 'training', tour: 'first-flight' } })).toBe('First flight · Forged Force');
  });
});
