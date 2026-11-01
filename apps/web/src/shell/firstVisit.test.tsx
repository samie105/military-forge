/**
 * A first visit (gradual engagement, 1 Nov): through the title there is no name step. The press makes a guest
 * with the API's generated callsign and goes on (Home, or Play now from the landing's Play now, the 18+ step
 * first); "Keep this name?" comes after. A room link, the debug client and automation (no title) keep the name
 * step. The 18+ step still comes before any online room.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGE_KEY } from './age';
import { ApiError, type Api, type Me, type RoomJoin } from './api';
import { ControllerContext } from './context';
import { NAME_ASK_KEY, ShellController, type GameHost } from './controller';
import { KeepName } from './screens/KeepName';
import { pressTitle } from './screens/Title';
import { createShellStore, type ShellState } from './store';

const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('location', { pathname: '/', search: '', hash: '', origin: 'https://play.example', host: 'play.example', protocol: 'https:' });
  vi.stubGlobal('history', { pushState: vi.fn(), replaceState: vi.fn(), state: null });
});
afterEach(() => vi.unstubAllGlobals());

const me: Me = { id: 'u1', nickname: 'Kestrel_42', nicknameChangeableAt: null } as unknown as Me;

function setup(api: Partial<Api>, title: ShellState['title'] = 'on', initial: Partial<ShellState> = {}) {
  const host = { local: null, online: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost;
  const store = createShellStore({ title, ...initial });
  const ctl = new ShellController(store, host, { restore: vi.fn(async () => null), ...api } as unknown as Api);
  return { store, ctl, host };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
// the question is kept for the session too (where storage fails): each test answers it before the next starts
let answer: (() => void) | null = null;
afterEach(() => {
  answer?.();
  answer = null;
});

describe('a first visit through the title', () => {
  it('has no name step: nothing is made until the press, then a guest with a generated callsign and Home', async () => {
    const guest = vi.fn(async () => me);
    const { store, ctl } = setup({ guest });
    await ctl.boot();
    // the title waits on 'boot' ("Getting ready…" if pressed now); a visitor who never presses makes no account
    expect(store.getState().screen).toEqual({ name: 'boot' });
    expect(guest).not.toHaveBeenCalled();
    pressTitle(store);
    expect(store.getState().title).toBe('pressed');
    await settle();
    expect(guest).toHaveBeenCalledWith(undefined, false);
    expect(store.getState().profile).toMatchObject({ nickname: 'Kestrel_42', offline: false });
    expect(store.getState().screen).toEqual({ name: 'home' });
    // "Keep this name?" is due, on this device too (a reload still asks)
    expect(store.getState().nameAsk).toBe(true);
    expect(saved.get(NAME_ASK_KEY)).toBe('1');
    answer = () => ctl.keepName();
  });

  it("the landing's Play now goes straight to Play now's room, the 18+ step first", async () => {
    const guest = vi.fn(async () => me);
    const createRoom = vi.fn();
    const quickRoom = vi.fn();
    const { store, ctl } = setup({ guest, createRoom, quickRoom });
    await ctl.boot();
    pressTitle(store, true);
    expect(store.getState().titlePlay).toBe(true);
    await settle();
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'create', quick: true } });
    expect(quickRoom).not.toHaveBeenCalled();
    expect(createRoom).not.toHaveBeenCalled();
    answer = () => ctl.keepName();
  });

  it('an adult on this device already: Play now finds its room at once', async () => {
    saved.set(AGE_KEY, JSON.stringify({ adult: true, birthYear: 1995, at: 0 }));
    const quickRoom = vi.fn(() => new Promise<RoomJoin>(() => {}));
    const { store, ctl } = setup({ guest: vi.fn(async () => me), quickRoom });
    await ctl.boot();
    pressTitle(store, true);
    await settle();
    expect(store.getState().screen).toMatchObject({ name: 'finding', creating: true });
    expect(quickRoom).toHaveBeenCalled();
    answer = () => ctl.keepName();
  });

  it('no API: training under a local name, as at any boot; another failure: the name step, never stuck', async () => {
    const offline = setup({ guest: vi.fn(async () => Promise.reject(new ApiError(0, 'network', 'offline'))) });
    await offline.ctl.boot();
    pressTitle(offline.store);
    await settle();
    expect(offline.store.getState().profile).toMatchObject({ offline: true });
    expect(offline.store.getState().screen).toEqual({ name: 'home' });
    expect(offline.store.getState().nameAsk).toBeFalsy();

    const refused = setup({ guest: vi.fn(async () => Promise.reject(new ApiError(429, 'rate_limited', 'slow down'))) });
    await refused.ctl.boot();
    pressTitle(refused.store);
    await settle();
    expect(refused.store.getState().screen).toEqual({ name: 'name', then: { to: 'home' } });
  });

  it('no title (automation, ?notitle, the debug client): the name step as before', async () => {
    const guest = vi.fn(async () => me);
    const { store, ctl } = setup({ guest }, 'off');
    await ctl.boot();
    expect(store.getState().screen).toEqual({ name: 'name', then: { to: 'home' } });
    expect(guest).not.toHaveBeenCalled();
  });
});

describe('Keep this name?', () => {
  it('Keep it: the question goes for good; Change: Edit name opens, and the question goes too', () => {
    saved.set(NAME_ASK_KEY, '1');
    const { store, ctl } = setup({}, 'off');
    expect(store.getState().nameAsk).toBe(true);
    ctl.keepName();
    expect(store.getState().nameAsk).toBe(false);
    expect(saved.has(NAME_ASK_KEY)).toBe(false);

    saved.set(NAME_ASK_KEY, '1');
    const again = setup({}, 'off');
    again.ctl.changeName();
    expect(again.store.getState().overlay).toBe('name');
    expect(again.store.getState().nameAsk).toBe(false);
  });

  it('shows the callsign with Keep it and Change while it is due; never for an offline name or with no controller', () => {
    // a static draw reads the store's first state (the server snapshot)
    const draw = (initial: Partial<ShellState>) => {
      const { ctl } = setup({}, 'off', initial);
      return renderToStaticMarkup(
        <ControllerContext.Provider value={ctl}>
          <KeepName where="results" />
        </ControllerContext.Provider>,
      );
    };
    const html = draw({ profile: { nickname: 'Kestrel_42', changeableAt: null, offline: false }, nameAsk: true });
    expect(html).toContain('Keep this name?');
    expect(html).toContain('Kestrel_42');
    expect(html).toMatch(/data-act="keep-name"[^>]*>.*Keep it<\/button>/);
    expect(html).toMatch(/data-act="change-name"[^>]*>.*Change<\/button>/);
    expect(draw({ profile: { nickname: 'Kestrel_42', changeableAt: null, offline: false }, nameAsk: false })).toBe('');
    expect(draw({ profile: { nickname: 'Pilot123', changeableAt: null, offline: true }, nameAsk: true })).toBe('');
    expect(renderToStaticMarkup(<KeepName where="home" />)).toBe('');
  });
});
