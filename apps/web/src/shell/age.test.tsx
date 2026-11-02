/**
 * The 18+ step (shell/age.ts): what the device keeps, the controller's gate before online rooms
 * (training isn't asked), the step's screen and its refusal, and the save form: the gate's answer
 * carried to the API, or the gate's own question when the device skipped the gate (audit 28 Oct:
 * one age question, never a second "18 or older" box).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPanel } from './account/AccountPanel';
import { accountErrorText } from './account/model';
import { AGE_KEY, adultOnDevice, ageOnDevice, answerAge, birthYears, stepBirthYear, yearDigits } from './age';
import { alertFromApiError } from './alerts';
import { Api, ApiError, type AccountInfo } from './api';
import { ControllerContext } from './context';
import { RECRUIT_MATCHES, ShellController, type GameHost } from './controller';
import { AgeGate, ageEyebrow } from './screens/AgeGate';
import { AgeQuestion, ageAnswered } from './screens/AgeQuestion';
import type { LobbyView } from './onlineView';
import type { MatchView } from './matchView';
import { createShellStore, type ShellState } from './store';
import { MatchPhase } from '@military-forge/sim';
import { FACTS_KEY } from '../tour/facts';

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

  it('the year they turn 18 also needs their word on the birthday: yes is adult, not yet is under 18', () => {
    expect(answerAge(2008, NOW)).toBe('invalid');
    expect(saved.has(AGE_KEY)).toBe(false);
    expect(answerAge(2008, NOW, false)).toEqual({ adult: false, at: NOW });
    expect(adultOnDevice()).toBe(false);
    expect(answerAge(2008, NOW, true)).toEqual({ adult: true, birthYear: 2008, at: NOW, turned18: true });
    expect(adultOnDevice()).toBe(true);
    // any other year: the birthday answer is not needed, and not kept
    expect(answerAge(1995, NOW, false)).toEqual({ adult: true, birthYear: 1995, at: NOW });
    expect(answerAge(2010, NOW, true)).toEqual({ adult: false, at: NOW });
  });

  it('a kept answer for the year they turn 18 without the birthday (from before it was asked) asks again', () => {
    const turns18 = new Date().getUTCFullYear() - 18;
    saved.set(AGE_KEY, JSON.stringify({ adult: true, birthYear: turns18, at: 0 }));
    expect(ageOnDevice()).toBeNull();
    saved.set(AGE_KEY, JSON.stringify({ adult: true, birthYear: turns18, at: 0, turned18: true }));
    expect(ageOnDevice()).toEqual({ adult: true, birthYear: turns18, at: 0, turned18: true });
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
  function setup(api: Partial<Api> = {}, online: Partial<GameHost['online']> | null = null) {
    const host = { local: null, online, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost;
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
    const quickRoom = vi.fn(async () => room);
    const { store, ctl } = setup({ createRoom, quickRoom });
    ctl.playNow();
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'create', quick: true } });
    expect(ctl.answerAge(1995)).toBe('ok');
    await vi.waitFor(() => expect(quickRoom).toHaveBeenCalledOnce());
    ctl.go({ to: 'home' });
    ctl.go({ to: 'create' });
    await vi.waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
  });

  // Play now's room once it's up: ours, in the lobby, with bots in it at `botLevel`
  const lobbyUp = (store: ReturnType<typeof createShellStore>, botLevel: 'easy' | 'normal') =>
    store.setState({
      match: { phase: MatchPhase.Waiting, results: null } as unknown as MatchView,
      lobby: { isHost: true, minPlayers: 2, players: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }], bots: 3, botLevel } as unknown as LobbyView,
    });

  it("Play now on a first visit: the answer carries on into the fight, with no extra step (audit A-02)", async () => {
    const createRoom = vi.fn(async () => room);
    const online = { startMatch: vi.fn(), setMatchSettings: vi.fn() };
    const { store, ctl } = setup({ createRoom, quickRoom: createRoom }, online);
    saved.set(FACTS_KEY, JSON.stringify({ v: 1, matches: { local: 3, online: 0, finished: 3, wonInARow: 0 } })); // no recruit: the room's own bots
    ctl.playNow();
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'create', quick: true } });
    expect(ctl.answerAge(1995)).toBe('ok');
    await vi.waitFor(() => expect(store.getState().screen).toMatchObject({ name: 'room', code: 'KMTXRA' }));
    lobbyUp(store, 'normal');
    expect(online.startMatch).toHaveBeenCalledOnce();
    expect(online.setMatchSettings).not.toHaveBeenCalled();
  });

  it(`Play now for a recruit (fewer than ${RECRUIT_MATCHES} matches finished): Easy bots, then the start (audit B-30)`, async () => {
    const createRoom = vi.fn(async () => room);
    const online = { startMatch: vi.fn(), setMatchSettings: vi.fn() };
    const { store, ctl } = setup({ createRoom, quickRoom: createRoom }, online);
    answerAge(1995, NOW);
    saved.set(FACTS_KEY, JSON.stringify({ v: 1, matches: { local: 2, online: 0, finished: 2, wonInARow: 0 } }));
    ctl.playNow();
    await vi.waitFor(() => expect(store.getState().screen).toMatchObject({ name: 'room' }));
    lobbyUp(store, 'normal');
    expect(online.setMatchSettings).toHaveBeenCalledExactlyOnceWith({ botLevel: 'easy' });
    expect(online.startMatch).not.toHaveBeenCalled();
    lobbyUp(store, 'easy');
    expect(online.startMatch).toHaveBeenCalledOnce();
    expect(online.setMatchSettings).toHaveBeenCalledOnce();
  });

  it('Play now still starts when the page updates while Home is still up (the back stack answers the room entry: audit 2 N-18 with P-01)', async () => {
    const quickRoom = vi.fn(async () => room);
    const online = { startMatch: vi.fn(), setMatchSettings: vi.fn() };
    const { store, ctl } = setup({ quickRoom }, online);
    answerAge(1995, NOW);
    saved.set(FACTS_KEY, JSON.stringify({ v: 1, matches: { local: 0, online: 9, finished: 9, wonInARow: 0 }, bots: { level: 'easy', pinned: false, good: 0, bad: 0, moved: null } }));
    // main.ts answers a new back-stack entry with a store update, before the screen leaves Home
    const push = ctl.nav.push.bind(ctl.nav);
    ctl.nav.push = (layer) => {
      push(layer);
      store.setState({ notice: null, tips: false });
    };
    ctl.playNow();
    await vi.waitFor(() => expect(store.getState().screen).toMatchObject({ name: 'room' }));
    lobbyUp(store, 'normal');
    expect(online.setMatchSettings).toHaveBeenCalledExactlyOnceWith({ botLevel: 'easy' });
    lobbyUp(store, 'easy');
    expect(online.startMatch).toHaveBeenCalledOnce();
  });

  it("Play now asks for the device's own level (audit 2 P-01): Hard when it stepped up there", async () => {
    const quickRoom = vi.fn(async () => room);
    const online = { startMatch: vi.fn(), setMatchSettings: vi.fn() };
    const { store, ctl } = setup({ quickRoom }, online);
    answerAge(1995, NOW);
    saved.set(FACTS_KEY, JSON.stringify({ v: 1, matches: { local: 0, online: 9, finished: 9, wonInARow: 2 }, bots: { level: 'hard', pinned: false, good: 0, bad: 0, moved: null } }));
    ctl.playNow();
    await vi.waitFor(() => expect(store.getState().screen).toMatchObject({ name: 'room' }));
    lobbyUp(store, 'normal');
    expect(online.setMatchSettings).toHaveBeenCalledExactlyOnceWith({ botLevel: 'hard' });
  });

  it('"One more, Easy bots" (audit 2 P-03): a room of our own (never a stranger\'s), Easy once', async () => {
    const createRoom = vi.fn(async () => room);
    const quickRoom = vi.fn(async () => room);
    const online = { startMatch: vi.fn(), setMatchSettings: vi.fn(), leave: vi.fn() };
    const { store, ctl } = setup({ createRoom, quickRoom }, online);
    answerAge(1995, NOW);
    saved.set(FACTS_KEY, JSON.stringify({ v: 1, matches: { local: 0, online: 9, finished: 9, wonInARow: 0 }, bots: { level: 'normal', pinned: false, good: 0, bad: 1, moved: null } }));
    ctl.playNow('easy');
    await vi.waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
    expect(quickRoom).not.toHaveBeenCalled();
    lobbyUp(store, 'normal');
    expect(online.setMatchSettings).toHaveBeenCalledExactlyOnceWith({ botLevel: 'easy' });
  });

  it("Play now that lands in someone else's open room (audit 2 P-07): their host starts it, their bots stay", async () => {
    const quickRoom = vi.fn(async () => ({ ...room, joined: true }));
    const online = { startMatch: vi.fn(), setMatchSettings: vi.fn() };
    const { store, ctl } = setup({ quickRoom }, online);
    answerAge(1995, NOW);
    ctl.playNow();
    await vi.waitFor(() => expect(store.getState().screen).toMatchObject({ name: 'room', code: 'KMTXRA' }));
    store.setState({
      match: { phase: MatchPhase.Waiting, results: null } as unknown as MatchView,
      lobby: { isHost: false, minPlayers: 2, players: [{ id: 0, isBot: false }, { id: 1, isBot: false }, { id: 2, isBot: true }], bots: 3, botLevel: 'normal' } as unknown as LobbyView,
    });
    expect(online.startMatch).not.toHaveBeenCalled();
    expect(online.setMatchSettings).not.toHaveBeenCalled();
    expect(store.getState().notice).toBe('In a Play now room with 1 other player · Bots here: Normal');
  });

  it('a Play now room found empty (the others just left) is ours: it starts as our own would', async () => {
    const quickRoom = vi.fn(async () => ({ ...room, joined: true }));
    const online = { startMatch: vi.fn(), setMatchSettings: vi.fn() };
    const { store, ctl } = setup({ quickRoom }, online);
    answerAge(1995, NOW);
    saved.set(FACTS_KEY, JSON.stringify({ v: 1, matches: { local: 0, online: 9, finished: 9, wonInARow: 0 }, bots: { level: 'normal', pinned: false, good: 0, bad: 0, moved: null } }));
    ctl.playNow();
    await vi.waitFor(() => expect(store.getState().screen).toMatchObject({ name: 'room', code: 'KMTXRA' }));
    lobbyUp(store, 'normal');
    expect(online.startMatch).toHaveBeenCalledOnce();
  });

  it('Play now under 18: the quick start goes with the refusal (nothing starts later)', () => {
    const createRoom = vi.fn(async () => room);
    const online = { startMatch: vi.fn(), setMatchSettings: vi.fn() };
    const { store, ctl } = setup({ createRoom, quickRoom: createRoom }, online);
    ctl.playNow();
    expect(ctl.answerAge(2012)).toBe('refused');
    store.setState({ screen: { name: 'room', code: 'KMTXRA' } });
    lobbyUp(store, 'easy');
    expect(online.startMatch).not.toHaveBeenCalled();
  });

  it('an under-18 sees the refusal, now and next time; no room is asked for', () => {
    const createRoom = vi.fn(async () => room);
    const { store, ctl } = setup({ createRoom });
    ctl.go({ to: 'create' });
    expect(ctl.answerAge(2011)).toBe('refused');
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'create' }, refused: true });
    ctl.go({ to: 'home' });
    ctl.go({ to: 'join', code: 'KMTXRA' });
    // asked from Home: the refusal is drawn over it (UX-02)
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'join', code: 'KMTXRA' }, refused: true, over: 'home' });
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('the year they turn 18 is not an answer until the birthday is', () => {
    const createRoom = vi.fn(async () => room);
    const { store, ctl } = setup({ createRoom });
    const turns18 = new Date().getUTCFullYear() - 18;
    ctl.go({ to: 'create' });
    expect(ctl.answerAge(turns18)).toBe('invalid');
    expect(store.getState().screen).toEqual({ name: 'age', then: { to: 'create' } });
    expect(ctl.answerAge(turns18, false)).toBe('refused');
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

describe('the 18+ card on screen (UX-02: one card for the question and both refusals)', () => {
  const ctl = { go: vi.fn(), answerAge: vi.fn(), peekRoom: vi.fn(async () => null) } as unknown as ShellController;
  const render = (props: Partial<Parameters<typeof AgeGate>[0]> = {}) =>
    renderToStaticMarkup(
      <ControllerContext.Provider value={ctl}>
        <AgeGate refused={false} {...props} />
      </ControllerContext.Provider>,
    );

  it('asks the year once (no second "18 or older" box: audit 28 Oct), nothing picked, and links the Terms', () => {
    const html = render();
    const t = textOf(html);
    expect(t).toContain('Online play is 18+');
    expect(t).toContain('Year you were born');
    expect(t).not.toContain('I am 18 or older');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('href="/terms.html"');
    expect(html).toContain('href="/privacy.html"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('the year is the kit stepper, not the native select: a spin button, empty, with the arrows either side', () => {
    const html = render();
    expect(html).not.toContain('<select');
    const field = /<input[^>]*id="age-year"[^>]*>/.exec(html)?.[0] ?? '';
    expect(field).toContain('role="spinbutton"');
    expect(field).toContain('inputMode="numeric"');
    expect(field).toContain('value=""');
    expect(field).toContain('aria-valuetext="Not picked"');
    expect(field).not.toContain('aria-valuenow');
    expect(field).toContain('maxLength="4"');
    expect(html).toMatch(/aria-label="One year earlier"[^>]*>.*id="age-year".*aria-label="One year later"/s);
  });

  it('the question: only the year they turn 18 adds the birthday, nothing picked', () => {
    const q = (year: string) => renderToStaticMarkup(<AgeQuestion idBase="q" fieldClass="f" value={{ year, turned18: null }} onChange={() => {}} />);
    const turns18 = String(new Date().getUTCFullYear() - 18);
    expect(q('1995')).not.toContain('18th birthday');
    expect(q('')).not.toContain('18th birthday');
    expect(q(turns18.slice(0, 3))).not.toContain('18th birthday'); // half typed: not a year yet
    const html = q(turns18);
    expect(textOf(html)).toContain('Have you had your 18th birthday yet? Yes Not yet');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toContain('checked');
    expect(ageAnswered({ year: turns18, turned18: null })).toBe(false);
    expect(ageAnswered({ year: turns18, turned18: false })).toBe(true);
    expect(ageAnswered({ year: '1995', turned18: null })).toBe(true);
    expect(ageAnswered({ year: '', turned18: null })).toBe(false);
  });

  it('is a paper dialog that holds a form, not a form playing a dialog (audit 28 Oct)', () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*class="age-card[^"]*"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*>.*<form class="age-card__form"/s);
    expect(html).not.toMatch(/<form[^>]*role="dialog"/);
  });

  it('over Home when asked from there (Home stays drawn, dimmed); else over the game\'s key art, never bare black', () => {
    expect(render({ overHome: true })).toContain('age-gate--over-home');
    expect(render({ overHome: true })).not.toContain('age-gate__art');
    expect(render()).toMatch(/<img class="age-gate__art"[^>]*src="\/assets\/posters\/quick-match\.webp"/);
    expect(render()).toContain('age-gate__scrim');
  });

  it("a room link names the room on the card (its host once the API says)", () => {
    expect(textOf(render({ then: { to: 'join', code: 'KMTXRA' } }))).toContain('Room KMTXRA · 18+');
    expect(ageEyebrow({ code: 'KMTXRA', host: 'Kemi' })).toBe("Kemi's room · KMTXRA");
    expect(ageEyebrow(null)).toBe('Forged Force · 18+');
  });

  it('the refusal is the same card, stamped, polite, with Training and no way to answer again; no code line', () => {
    const html = render({ refused: true });
    const t = textOf(html);
    expect(html).toMatch(/class="age-card[^"]*"[^>]*role="alertdialog"/);
    expect(html).toMatch(/class="stamp stamp--bad stamp--lg age-card__stamp[^"]*">18\+ only</);
    expect(t).toContain('Sorry, online play is for adults');
    expect(t).toContain('is for players 18 and over');
    expect(t).toContain('Training against bots is open to everyone.');
    expect(html).toMatch(/<button[^>]*class="btn btn--volt[^"]*"[^>]*>.*Training<\/button>/);
    expect(html).not.toContain('<select');
    expect(html).not.toContain('age-year');
    expect(t).not.toMatch(/Code|ADULTS_ONLY/);
    // no nudge to change the answer
    expect(t).not.toMatch(/change your answer|try again|wrong year/i);
  });

  it("the account's refusal (the API's adults_only) is that same card over Home, not an alert with a code", () => {
    const html = render({ refused: true, account: true, overHome: true });
    const t = textOf(html);
    expect(html).toContain('age-card');
    expect(html).not.toContain('conn ticket');
    expect(t).toContain('Online play is for adults');
    expect(t).toContain('Training against bots is open to everyone.');
    expect(t).not.toMatch(/Code|ADULTS_ONLY|Sorry/);
    expect(alertFromApiError(new ApiError(403, 'adults_only', 'x')).kind).toBe('adults-only');
  });
});

describe('Save your account: one 18+ question (the gate\'s), and the Terms', () => {
  const guestInfo: AccountInfo = { email: null, saved: false, hasProgress: false, resetByEmail: false };
  function render(state: Partial<ShellState> = {}) {
    const store = createShellStore({ screen: { name: 'home' }, profile: { nickname: 'Kemi', changeableAt: null, offline: false }, ...state });
    return renderToStaticMarkup(
      <ControllerContext.Provider value={{ store, api: {} } as unknown as ShellController}>
        <AccountPanel store={store} variant="desktop" preset={{ mode: 'save', info: guestInfo }} />
      </ControllerContext.Provider>,
    );
  }

  it('a device that skipped the gate gets the gate\'s question, not a separate "18 or older" box (audit 28 Oct)', () => {
    const html = render();
    const t = textOf(html);
    expect(t).toContain('Year you were born');
    expect(t).toContain('Accounts are for players 18 and over.');
    expect(t).not.toContain('I am 18 or older');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toMatch(/<input[^>]*id="[^"]*age-year"[^>]*role="spinbutton"[^>]*value=""/);
    expect(t).toContain('Saving means you agree to the Terms');
  });

  it('a device that passed the gate is not asked again', () => {
    answerAge(1995);
    const html = render();
    const t = textOf(html);
    expect(t).toContain('18 or older: confirmed on this device (born 1995).');
    expect(t).not.toContain('Year you were born');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('type="checkbox"');
  });

  it('an under-18 device gets no form', () => {
    answerAge(2013);
    const html = render();
    expect(textOf(html)).toContain('accounts can’t be saved on this device');
    expect(html).not.toContain('type="password"');
  });

  it('the API call carries the gate\'s answer (the year, "adult"), and the bot check token only when there is one', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const me = { id: 'u_1', nickname: 'Kemi', isGuest: true, createdAt: '', nicknameChangeableAt: null, level: 1, xp: 0 };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse((init.body as string) ?? '{}') as Record<string, unknown> });
      if (url.endsWith('/auth/guest')) return new Response(JSON.stringify({ accessToken: 'a1', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshToken: 'r1', user: me }), { status: 201 });
      return new Response(JSON.stringify({ status: 'check_email' }), { status: 202 });
    });
    const api = new Api('/api', fetchImpl as unknown as typeof fetch);
    await api.guest();
    const kept = answerAge(1995);
    if (kept === 'invalid' || !kept.adult) throw new Error('not an adult answer');
    expect(await api.saveAccount('kemi@example.com', 'jetpack-sunrise-42', kept)).toBe('check_email');
    await api.forgotPassword('kemi@example.com', 'tok');
    expect(calls.slice(1)).toEqual([
      { url: '/api/auth/save', body: { email: 'kemi@example.com', password: 'jetpack-sunrise-42', birthYear: 1995, adult: true } },
      { url: '/api/auth/forgot', body: { email: 'kemi@example.com', turnstileToken: 'tok' } },
    ]);
  });

  it("the API's answers in words", () => {
    expect(accountErrorText(new ApiError(403, 'underage', 'x'))).toBe('Forged Force is for players 18 and over, so this account can’t be saved.');
    expect(accountErrorText(new ApiError(400, 'age_required', 'x'))).toBe('Pick the year you were born, then try again.');
    expect(accountErrorText(new ApiError(400, 'bot_check_required', 'x'))).toBe("Finish the check that you're not a bot, then try again.");
    expect(accountErrorText(new ApiError(403, 'bot_check_failed', 'x'))).toBe("The check that you're not a bot didn't pass. Try it again.");
    expect(accountErrorText(new ApiError(503, 'bot_check_unavailable', 'x'))).toBe("Couldn't check you're not a bot just now. Try again in a moment.");
  });
});

describe('the year with a controller or the arrow keys (audit 2, N-01)', () => {
  const years = [2021, 2020, 2019, 2018, 2017];
  it('from nothing picked, any step shows the youngest year listed (neutral: no answer that gets in comes first)', () => {
    expect(stepBirthYear('', 'ArrowLeft', years)).toBe('2021');
    expect(stepBirthYear('', 'ArrowRight', years)).toBe('2021');
    expect(stepBirthYear('', 'PageDown', years)).toBe('2021');
  });
  it('left and right step a year, the page keys (L1 / R1) ten, and stop at either end', () => {
    expect(stepBirthYear('2019', 'ArrowLeft', years)).toBe('2018');
    expect(stepBirthYear('2019', 'ArrowRight', years)).toBe('2020');
    expect(stepBirthYear('2019', 'PageDown', years)).toBe('2017');
    expect(stepBirthYear('2019', 'PageUp', years)).toBe('2021');
    expect(stepBirthYear('2017', 'ArrowLeft', years)).toBe('2017');
  });
  it('a spin button: up and down step a year too; typing and other keys are left to the field', () => {
    expect(stepBirthYear('2019', 'ArrowUp', years)).toBe('2020');
    expect(stepBirthYear('2019', 'ArrowDown', years)).toBe('2018');
    expect(stepBirthYear('2019', 'Enter', years)).toBeNull();
    expect(stepBirthYear('2019', '7', years)).toBeNull();
  });
  it('a typed year keeps four digits only, and is an answer only once it is whole', () => {
    expect(yearDigits('19a9-0x5')).toBe('1990');
    expect(yearDigits('  1 9 9')).toBe('199');
    expect(ageAnswered({ year: '199', turned18: null })).toBe(false);
    expect(ageAnswered({ year: '1990', turned18: null })).toBe(true);
    // a half-typed year steps from where it lands (clamped to the list)
    expect(stepBirthYear('19', 'ArrowRight', years)).toBe('2017');
  });
  it('reaches 1990 from nothing in five presses with the real list', () => {
    const now = Date.UTC(2026, 10, 1);
    const all = birthYears(now);
    let y = '';
    for (const k of ['ArrowLeft', 'PageDown', 'PageDown', 'PageDown', 'ArrowLeft']) y = stepBirthYear(y, k, all)!;
    expect(y).toBe('1990');
  });
});
