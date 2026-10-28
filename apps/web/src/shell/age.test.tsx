/**
 * The 18+ step (shell/age.ts): what the device keeps, the controller's gate before online rooms
 * (training isn't asked), the step's screen and its refusal, and the save form's own question,
 * Terms line and the API call it makes.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPanel } from './account/AccountPanel';
import { accountErrorText } from './account/model';
import { AGE_KEY, adultOnDevice, ageOnDevice, answerAge, birthYears } from './age';
import { Api, ApiError, type AccountInfo } from './api';
import { ControllerContext } from './context';
import { ShellController, type GameHost } from './controller';
import { AgeGate } from './screens/AgeGate';
import { createShellStore, type ShellState } from './store';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('what the device keeps', () => {
  it('nothing until asked; then the birth year and when, never a date of birth', () => {
    expect(ageOnDevice()).toBeNull();
    expect(answerAge(1995, NOW)).toEqual({ adult: true, birthYear: 1995, at: NOW });
    expect(JSON.parse(saved.get(AGE_KEY)!)).toEqual({ adult: true, birthYear: 1995, at: NOW });
    expect(adultOnDevice()).toBe(true);
  });

  it('an under-18 answer is kept (no year with it), so the step does not just ask again', () => {
    expect(answerAge(2012, NOW)).toEqual({ adult: false, at: NOW });
    expect(saved.get(AGE_KEY)).toBe(JSON.stringify({ adult: false, at: NOW }));
    expect(adultOnDevice()).toBe(false);
  });

  it('a year that is no player asks again; a broken or edited record counts as not asked', () => {
    expect(answerAge(2030, NOW)).toBe('invalid');
    expect(saved.has(AGE_KEY)).toBe(false);
    saved.set(AGE_KEY, '{nope');
    expect(ageOnDevice()).toBeNull();
    saved.set(AGE_KEY, JSON.stringify({ adult: true, birthYear: 2015, at: 0 }));
    expect(ageOnDevice()).toBeNull();
  });

  it('works where localStorage is refused (this visit only)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(answerAge(1990, NOW)).toMatchObject({ adult: true });
    expect(adultOnDevice()).toBe(true);
  });

  it('the year list is neutral: young years too, newest first', () => {
    const years = birthYears(NOW);
    expect(years[0]).toBe(2021);
    expect(years).toContain(2012);
    expect(years).toContain(2008);
    expect(years.at(-1)).toBe(1906);
  });
});

describe('the gate before online rooms', () => {
  function setup(api: Partial<Api> = {}) {
    const host = { local: null, online: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost;
    const store = createShellStore();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('location', { pathname: '/', search: '', hash: '', origin: 'https://play.example', host: 'play.example', protocol: 'https:' });
    vi.stubGlobal('history', { pushState: vi.fn(), replaceState: vi.fn(), state: null });
    const ctl = new ShellController(store, host, api as Api);
    store.setState({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
    return { store, ctl, host };
  }
  const room = { code: 'KMTXRA', roomId: 'r1', gsUrl: 'wss://gs.example/ws/KMTXRA', ticket: 't1' };

  it('create, join, watch and a local room wait for it; training does not', () => {
    const { store, ctl, host } = setup();
    for (const intent of [{ to: 'create' }, { to: 'join', code: 'KMTXRA' }, { to: 'watch', code: 'KMTXRA' }, { to: 'local' }] as const) {
      ctl.go(intent);
      expect(store.getState().screen).toEqual({ name: 'age', then: intent });
    }
    ctl.go({ to: 'training' });
    expect(store.getState().screen.name).toBe('training');
    expect(host.startTraining).toHaveBeenCalled();
  });

  it('an adult carries on where they were going, and is not asked again', async () => {
    const createRoom = vi.fn(async () => room);
    const { store, ctl } = setup({ createRoom });
    ctl.playNow();
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'create' } });
    expect(ctl.answerAge(1995)).toBe('ok');
    await vi.waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
    ctl.go({ to: 'home' });
    ctl.go({ to: 'create' });
    await vi.waitFor(() => expect(createRoom).toHaveBeenCalledTimes(2));
  });

  it('an under-18 sees the refusal, now and next time; no room is asked for', () => {
    const createRoom = vi.fn(async () => room);
    const { store, ctl } = setup({ createRoom });
    ctl.go({ to: 'create' });
    expect(ctl.answerAge(2011)).toBe('refused');
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'create' }, refused: true });
    ctl.go({ to: 'home' });
    ctl.go({ to: 'join', code: 'KMTXRA' });
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'join', code: 'KMTXRA' }, refused: true });
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('a room link on a first visit asks the step before the name', async () => {
    const { store, ctl } = setup({ restore: vi.fn(async () => null) });
    store.setState({ profile: null });
    vi.stubGlobal('location', { pathname: '/r/KMTXRA', search: '', hash: '', origin: 'https://play.example', host: 'play.example', protocol: 'https:' });
    await ctl.boot();
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'join', code: 'KMTXRA' } });
    ctl.answerAge(1995);
    expect(store.getState().screen).toEqual({ name: 'name', then: { to: 'join', code: 'KMTXRA' } });
  });

  it('Join with code asks the step before the API hears the code', async () => {
    const joinRoom = vi.fn(async () => room);
    const { store, ctl } = setup({ joinRoom });
    expect(await ctl.joinByCode('KMTXRA')).toBe('error');
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'join', code: 'KMTXRA' } });
    expect(joinRoom).not.toHaveBeenCalled();
  });
});

describe('the step on screen', () => {
  const render = (refused: boolean) =>
    renderToStaticMarkup(
      <ControllerContext.Provider value={{} as ShellController}>
        <AgeGate refused={refused} />
      </ControllerContext.Provider>,
    );

  it('asks the year and "18 or older", with nothing picked or ticked, and links the Terms', () => {
    const html = render(false);
    const t = textOf(html);
    expect(t).toContain('Online play is 18+');
    expect(t).toContain('Year you were born');
    expect(t).toContain('I am 18 or older');
    expect(html).toMatch(/<option value="" selected="">Choose…<\/option>/);
    expect(html).toMatch(/<input id="age-adult" type="checkbox"\/>/);
    expect(html).toContain('<label for="age-adult">I am 18 or older</label>');
    expect(html).toContain('href="/terms.html"');
    expect(html).toContain('href="/privacy.html"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('the refusal is polite and has no way to answer again', () => {
    const html = render(true);
    expect(textOf(html)).toContain('Sorry, online play is for adults');
    expect(textOf(html)).toContain('is for players 18 and over');
    expect(html).not.toContain('<select');
  });
});

describe('Save your account: the 18+ question and the Terms', () => {
  const guestInfo: AccountInfo = { email: null, saved: false, hasProgress: false, resetByEmail: false };
  function render(state: Partial<ShellState> = {}) {
    const store = createShellStore({ screen: { name: 'home' }, profile: { nickname: 'Kemi', changeableAt: null, offline: false }, ...state });
    return renderToStaticMarkup(
      <ControllerContext.Provider value={{ store, api: {} } as unknown as ShellController}>
        <AccountPanel store={store} variant="desktop" preset={{ mode: 'save', info: guestInfo }} />
      </ControllerContext.Provider>,
    );
  }

  it('asks the question when this device has not answered it', () => {
    const t = textOf(render());
    expect(t).toContain('Year you were born');
    expect(t).toContain('I am 18 or older');
    expect(t).toContain('Saving means you agree to the Terms');
  });

  it('says it is confirmed when the device answered it', () => {
    answerAge(1995);
    const t = textOf(render());
    expect(t).toContain('18 or older: confirmed on this device (born 1995).');
    expect(t).not.toContain('Year you were born');
  });

  it('an under-18 device gets no form', () => {
    answerAge(2013);
    const html = render();
    expect(textOf(html)).toContain('accounts can’t be saved on this device');
    expect(html).not.toContain('type="password"');
  });

  it('the API call carries the year, "adult", and the bot check token only when there is one', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const me = { id: 'u_1', nickname: 'Kemi', isGuest: true, createdAt: '', nicknameChangeableAt: null, level: 1, xp: 0 };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse((init.body as string) ?? '{}') as Record<string, unknown> });
      if (url.endsWith('/auth/guest')) return new Response(JSON.stringify({ accessToken: 'a1', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshToken: 'r1', user: me }), { status: 201 });
      return new Response(JSON.stringify({ status: 'check_email' }), { status: 202 });
    });
    const api = new Api('/api', fetchImpl as unknown as typeof fetch);
    await api.guest();
    expect(await api.saveAccount('kemi@example.com', 'jetpack-sunrise-42', 1995)).toBe('check_email');
    await api.forgotPassword('kemi@example.com', 'tok');
    expect(calls.slice(1)).toEqual([
      { url: '/api/auth/save', body: { email: 'kemi@example.com', password: 'jetpack-sunrise-42', birthYear: 1995, adult: true } },
      { url: '/api/auth/forgot', body: { email: 'kemi@example.com', turnstileToken: 'tok' } },
    ]);
  });

  it("the API's answers in words", () => {
    expect(accountErrorText(new ApiError(403, 'underage', 'x'))).toBe('Military Forge is for players 18 and over, so this account can’t be saved.');
    expect(accountErrorText(new ApiError(400, 'age_required', 'x'))).toBe('Confirm you are 18 or older, with the year you were born.');
    expect(accountErrorText(new ApiError(400, 'bot_check_required', 'x'))).toBe("Finish the check that you're not a bot, then try again.");
    expect(accountErrorText(new ApiError(403, 'bot_check_failed', 'x'))).toBe("The check that you're not a bot didn't pass. Try it again.");
    expect(accountErrorText(new ApiError(503, 'bot_check_unavailable', 'x'))).toBe("Couldn't check you're not a bot just now. Try again in a moment.");
  });
});
