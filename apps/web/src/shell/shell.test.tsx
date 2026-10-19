import { Game, MatchEndReason, MatchPhase, Match, ticks, type MatchResults } from '@military-forge/sim';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { alertFromApiError, alertFromConnection } from './alerts';
import { App, ControllerContext, MapEventBanner, TipsCard, WarmupBar, tipsRows } from './App';
import type { Api } from './api';
import { defaultBindings, rebind } from './controls';
import { ShellController, type GameHost } from './controller';
import { bannerOf, sameBanner } from './mapEventBanner';
import { createShellStore, runCleanup } from './store';
import { localMatchRules } from './localMatch';
import { formatClock, matchView, ordinal, placeholderXp, sameView, type MatchView } from './matchView';
import type { LobbyView } from './onlineView';
import { connectStep, reconnectSecondsLeft } from './screens/Connection';
import { Countdown, countdownState, rulesLine } from './screens/Countdown';
import { codeLetters, joinState } from './screens/Join';
import { Lobby, killsLabel, lobbyMaps, minutesLabel } from './screens/Lobby';
import { nameState } from './screens/NameEntry';
import { Pause, leaveCost } from './screens/Pause';
import { Results, reasonChip, winnerOf } from './screens/Results';
import { autoText, resetPatch } from './screens/Settings';
import { dashTip } from './screens/Tips';

const actions = { playAgain: vi.fn(), backToLobby: vi.fn(), ready: vi.fn() };

function localMatch() {
  const game = new Game({ seed: 3, dummies: true });
  const me = game.addPlayer('You');
  const match = new Match(game, { timeLimit: 90, killLimit: 5, countdown: 3 });
  return { game, me, match };
}

describe('matchView', () => {
  it('follows the match through countdown, play and results', () => {
    const { me, match } = localMatch();
    let view = matchView(match, me.id);
    expect(view).toMatchObject({ phase: MatchPhase.Waiting, ready: false, humans: 1, secondsLeft: 0, killLimit: 5 });

    match.setReady(me.id);
    expect(matchView(match, me.id).ready).toBe(true);
    match.step([]);
    view = matchView(match, me.id);
    expect(match.number).toBe(0);
    expect(view).toMatchObject({ phase: MatchPhase.Countdown, number: 1, secondsLeft: 3 });
    for (let i = 0; i < ticks(3); i++) match.step([]);
    expect(matchView(match, me.id)).toMatchObject({ phase: MatchPhase.InProgress, number: 1, secondsLeft: 90, untimed: false, myScore: 0, leaderScore: 0 });
    for (let i = 0; i < ticks(90); i++) match.step([]);
    view = matchView(match, me.id);
    expect(view.phase).toBe(MatchPhase.Ending);
    expect(view.results?.reason).toBe(MatchEndReason.TimeLimit);

    match.voteRematch(me.id);
    expect(matchView(match, me.id)).toMatchObject({ votes: 1, voted: true });
  });

  it('an untimed match counts the time played', () => {
    const game = new Game({ seed: 3, dummies: true });
    const me = game.addPlayer('You');
    const match = new Match(game, { timeLimit: 0, countdown: 1 });
    match.setReady(me.id);
    for (let i = 0; i < 1 + ticks(1) + ticks(75); i++) match.step([]);
    expect(matchView(match, me.id)).toMatchObject({ phase: MatchPhase.InProgress, untimed: true, secondsLeft: 0, secondsElapsed: 75 });
  });

  it('only reports a change when something visible changed', () => {
    const { me, match } = localMatch();
    match.setReady(me.id);
    match.step([]);
    const a = matchView(match, me.id);
    match.step([]);
    expect(sameView(a, matchView(match, me.id))).toBe(true); // same whole second
    for (let i = 0; i < 60; i++) match.step([]);
    expect(sameView(a, matchView(match, me.id))).toBe(false);
    expect(sameView(null, null)).toBe(true);
    expect(sameView(a, null)).toBe(false);
  });

  it('formats clocks, ordinals and the XP placeholder', () => {
    expect([formatClock(5), formatClock(272), formatClock(720), formatClock(-3)]).toEqual(['0:05', '4:32', '12:00', '0:00']);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    expect(placeholderXp({ placement: 1, kills: 3, assists: 2 } as never)).toBe(100 + 30 + 10 + 50);
  });
});

describe('local match rules', () => {
  it('reads limits from the URL, clamped, and ?sandbox turns the match off', () => {
    expect(localMatchRules(new URLSearchParams(''))).toMatchObject({ timeLimit: 300, killLimit: 10, onNoRematch: 'lobby' });
    expect(localMatchRules(new URLSearchParams('time=60&kills=0&countdown=99'))).toMatchObject({ timeLimit: 60, killLimit: 0, countdown: 10 });
    expect(localMatchRules(new URLSearchParams('time=-5&kills=abc'))).toMatchObject({ timeLimit: 0, killLimit: 10 });
    expect(localMatchRules(new URLSearchParams('sandbox'))).toBeNull();
  });
});

const view = (over: Partial<MatchView> = {}): MatchView => ({
  phase: MatchPhase.Ending,
  number: 2,
  secondsLeft: 7,
  untimed: false,
  secondsElapsed: 0,
  killLimit: 10,
  timeLimit: 300,
  countdownTotal: 3,
  mapName: 'Lunar Outpost',
  localId: 4,
  myScore: 3,
  leaderScore: 5,
  leaderName: 'Ade',
  ready: false,
  votes: 0,
  humans: 2,
  voted: false,
  results: null,
  ...over,
});

const standing = (id: number, name: string, placement: number, over: object = {}) => ({
  placement,
  id,
  key: id + 100,
  name,
  isBot: false,
  left: false,
  score: 0,
  kills: 0,
  deaths: 0,
  suicides: 0,
  assists: 0,
  damageDealt: 0,
  damageTaken: 0,
  headshots: 0,
  bestStreak: 0,
  rating: 0,
  mvp: false,
  ...over,
});

const results: MatchResults = {
  number: 2,
  reason: MatchEndReason.KillLimit,
  durationTicks: ticks(154),
  winnerKey: 104,
  mvpKey: 104,
  standings: [
    standing(4, 'Ade', 1, { score: 10, kills: 10, deaths: 2, assists: 1, damageDealt: 1234, bestStreak: 6, rating: 1234, mvp: true }),
    standing(0, 'Strafer', 2, { isBot: true, deaths: 5 }),
    standing(7, 'Kemi', 3, { left: true, score: -1, suicides: 1, deaths: 1 }),
  ],
};

describe("results (the kit's screen 10)", () => {
  it('the winner, why it ended, your place and numbers, the standings with badges, Play again', () => {
    const html = renderToStaticMarkup(<Results view={view({ results })} results={results} actions={actions} room={{ isHost: true, hostId: 4, leave: vi.fn() }} />);
    expect(html).toContain('data-screen="results"');
    expect(html).toMatch(/data-active-state="kill-limit host not-voted"/);
    expect(html).toContain('Debrief · Match 2 · Lunar Outpost');
    expect(html).toMatch(/res__name[^>]*>Ade</);
    expect(html).toContain('Kill limit reached · 10 kills');
    expect(html).toMatch(/results\.me\.placement">1st</);
    expect(html).toContain('1,234');
    expect(html).toMatch(/is-winner is-you.*Ade.*Host.*You.*MVP/);
    expect(html).toMatch(/is-bot.*Strafer.*Bot/);
    expect(html).toMatch(/Kemi.*Left/);
    expect(html).toContain('Play again');
    expect(html).toContain('Back to lobby');
    expect(html).toContain('Leave room');
    expect(html).toMatch(/results\.votes">0\/2</);
  });

  it('a guest has no Back to lobby; a vote shows as cast; a closed room says so', () => {
    const guest = renderToStaticMarkup(<Results view={view({ phase: MatchPhase.Postgame, voted: true, votes: 1 })} results={results} actions={actions} room={{ isHost: false, hostId: 0, leave: vi.fn() }} />);
    expect(guest).not.toContain('Back to lobby');
    expect(guest).toContain('You voted');
    expect(guest).toMatch(/results\.votes">1\/2 · 7 s</);
    expect(guest).toMatch(/<i class="on m-p7"><\/i><i><\/i>/);
    const closed = renderToStaticMarkup(<Results view={view({ phase: MatchPhase.Closed })} results={results} actions={actions} />);
    expect(closed).toContain('Room closed');
  });

  it('a leaver who held your slot id is not you; a shared top score is a draw', () => {
    const reused: MatchResults = { ...results, standings: [standing(4, 'Kemi', 1, { key: 1, left: true, score: 5, kills: 5 }), standing(0, 'Strafer', 2, { isBot: true }), standing(4, 'You', 3, { key: 9, kills: 1, deaths: 4 })] };
    const html = renderToStaticMarkup(<Results view={view()} results={reused} actions={actions} />);
    expect(html).toMatch(/results\.me\.placement">3rd</);
    const p = (name: string, score: number, isBot = false) => ({ name, score, isBot });
    expect(winnerOf([p('A', 3), p('B', 3)])).toEqual({ name: 'Draw', draw: true });
    expect(winnerOf([p('A', 0), p('B', 0)]).draw).toBe(true);
    expect(winnerOf([p('A', 3), p('B', 2)])).toEqual({ name: 'A', draw: false });
    // a bot's own "[BOT]" tag never shows: its name, as next to the Bot badge (review M3)
    expect(winnerOf([p('[BOT] Kestrel', 5, true), p('Kemi', 2)])).toEqual({ name: 'Kestrel', draw: false });
    expect(reasonChip({ reason: MatchEndReason.TimeLimit, durationTicks: ticks(300) }, 10)).toMatchObject({ text: "Time's up · 5:00", state: 'time-up' });
  });
});

describe('countdown (screen 6)', () => {
  it('"Get ready" past three seconds, then 3, 2, 1; the rules line', () => {
    expect(countdownState(view({ phase: MatchPhase.Countdown, secondsLeft: 5 }))).toBe('match');
    expect(countdownState(view({ phase: MatchPhase.Countdown, secondsLeft: 3 }))).toBe('3');
    expect(countdownState(view({ phase: MatchPhase.Countdown, secondsLeft: 1 }))).toBe('1');
    expect(countdownState(view({ phase: MatchPhase.InProgress }))).toBeNull();
    expect(rulesLine(view({ killLimit: 0, timeLimit: 300 }))).toEqual({ kills: 'no kill limit', time: '5:00' });
    const stand = renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.Countdown, secondsLeft: 5, number: 1 })} state="match" />);
    expect(stand).toContain('Match 1');
    expect(stand).toContain('Lunar Outpost');
    expect(stand).toContain('first to 10');
    const html = renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.Countdown, secondsLeft: 2, number: 1 })} state="2" />);
    expect(html).toMatch(/data-active-state="2"/);
    expect(html).toMatch(/countdown\.value">2</);
    // as the countdown begins: the map intro, its name and rules
    const intro = renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.Countdown, secondsLeft: 5, number: 1 })} state="intro" />);
    expect(intro).toMatch(/intro__name[^>]*>Lunar Outpost</);
    expect(intro).toContain('The Moon');
  });
});

describe('lobby (screen 4)', () => {
  beforeAll(() => vi.stubGlobal('location', { origin: 'https://abc.trycloudflare.com', host: 'abc.trycloudflare.com', protocol: 'https:' }));
  afterAll(() => vi.unstubAllGlobals());
  const lobby = (isHost: boolean): LobbyView => ({
    code: 'KMTXRA',
    players: [
      { id: 0, name: 'Ade', ready: true, host: true, you: isHost, isBot: false, pingMs: 24 },
      { id: 1, name: 'Kemi', ready: false, host: false, you: !isHost, isBot: false, pingMs: 186 },
    ],
    isHost,
    ready: isHost,
    minPlayers: 2,
    timeLimit: 300,
    killLimit: 10,
    mapId: 'movement-test',
    mapName: 'Movement Test',
  });
  const ctl = { host: { online: null }, copyLink: vi.fn(), shareOnWhatsApp: vi.fn(), shareLink: vi.fn(), openSettings: vi.fn(), leave: vi.fn() } as unknown as ShellController;
  const render = (isHost: boolean) =>
    renderToStaticMarkup(
      <ControllerContext.Provider value={ctl}>
        <Lobby lobby={lobby(isHost)} />
      </ControllerContext.Provider>,
    );

  it('the host: the invite (code, Copy link, WhatsApp, a real QR), players with open slots, settings to pick, Start now', () => {
    const html = render(true);
    expect(html).toMatch(/data-active-state="host ready link-idle"/);
    expect(html.match(/data-bind="room\.code\.\d"/g)).toHaveLength(6);
    expect(html).toContain('Copy link');
    expect(html).toContain('abc.trycloudflare.com/r/KMTXRA');
    expect(html).toContain('WhatsApp');
    expect(html).toContain('Share room link');
    expect(html).toMatch(/<svg viewBox="0 0 \d+ \d+"[^>]*><path fill="var\(--c-qr-dark\)"/);
    expect(html).toMatch(/Roster <span class="num">2<\/span><span class="lobby__of">\/8</);
    expect(html).toMatch(/<span class="num">1<\/span> of 2 ready/);
    expect(html.match(/prow prow--open/g)).toHaveLength(6);
    expect(html).toMatch(/prow is-you.*Ade.*Host.*You/);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>5</);
    expect(html).toContain('Start now');
    expect(html).toContain("You&#x27;re ready");
  });

  it('a guest reads the settings, and the highlight follows the guest', () => {
    const html = render(false);
    expect(html).toMatch(/data-active-state="guest not-ready link-idle"/);
    expect(html).toContain('The host picks the settings');
    expect(html).toContain('5 min');
    expect(html).toContain('10 kills');
    expect(html).toMatch(/prow is-you-guest.*Kemi/);
    expect(html).not.toContain('Start now');
    expect([minutesLabel(0), killsLabel(0), minutesLabel(120)]).toEqual(['No time limit', 'No kill limit', '2 min']);
    expect(lobbyMaps('movement-test')).not.toContain('mechanics-test');
    expect(lobbyMaps('mechanics-test')).toContain('mechanics-test');
  });
});

describe('join, names, connection, pause and settings', () => {
  it('join: letters only, the code from a pasted link, and its states', () => {
    expect(codeLetters('kmt-x1ra')).toBe('KMTXRA');
    expect(codeLetters('ILO')).toBe('');
    expect([joinState('', false, null), joinState('KMT', false, null), joinState('KMTXRA', true, null), joinState('KMTXRA', false, null), joinState('KMTXRB', false, 'No room')]).toEqual(['empty', 'typing', 'pasted', 'ready', 'error']);
  });

  it("name entry: the kit's states from what the API said", () => {
    expect(nameState('', null, null, false)).toBe('empty');
    expect(nameState('Ad', null, null, false)).toBe('too-short');
    expect(nameState('Ade_07', null, null, true)).toBe('checking');
    expect(nameState('Ade_07', { nickname: 'Ade_07', valid: true, available: true, suggestions: [] }, null, false)).toBe('available');
    expect(nameState('Ade', { nickname: 'Ade', valid: true, available: false, suggestions: ['Ade_2'] }, null, false)).toBe('taken');
    expect(nameState('Ade', null, 'Ade', false)).toBe('same');
    // the live check failed (API down, 5xx, 429): unchecked, and Continue lets the API decide (review M2)
    expect(nameState('Ade_07', null, null, false, true)).toBe('unchecked');
    expect(nameState('Ade_07', null, null, true, true)).toBe('checking');
  });

  it('connection: the steps, and the reconnect countdown', () => {
    expect(connectStep(null, false)).toBe(1);
    const c = { state: 'connected' as const, detail: '', code: 0, since: 0, until: 0, attempt: 0, lastPingMs: -1, lossPct: 0 };
    expect(connectStep(c, false)).toBe(2);
    expect(reconnectSecondsLeft(60_000, 1_500)).toBe(59);
    expect(reconnectSecondsLeft(60_000, 70_000)).toBe(0);
  });

  it("alerts: API errors and close codes in the kit's words", () => {
    expect(alertFromApiError(new ApiError(404, 'room_not_found', 'x'), 'KMTXRA')).toMatchObject({ kind: 'room-not-found', code: 'ROOM_NOT_FOUND · room KMTXRA', action: 'rejoin' });
    expect(alertFromApiError(new ApiError(0, 'network', 'down'))).toMatchObject({ kind: 'offline', action: 'rejoin' });
    expect(alertFromApiError(new ApiError(429, 'rate_limited', 'x', { retryAfter: 30 })).message).toBe('Wait 30 s, then try again.');
    const closed = (code: number, detail = '') => alertFromConnection({ code, detail, attempt: 7, lastPingMs: 412, lossPct: 18.2 }, 'KMTXRA');
    expect(closed(4001)).toMatchObject({ kind: 'new-version', action: 'reload' });
    expect(closed(4002)).toMatchObject({ kind: 'room-full', code: 'ROOM_FULL · room KMTXRA' });
    expect(closed(4006).kind).toBe('server-full');
    expect(closed(4007, 'the room has closed')).toMatchObject({ kind: 'room-not-found', action: null });
    expect(closed(4007, 'join ticket expired')).toMatchObject({ kind: 'refused', action: 'rejoin' });
    expect(closed(1006)).toMatchObject({ kind: 'connection-lost', code: 'CONNECTION_LOST · last ping 412 ms, 18% loss' });
    expect(closed(1006).message).toContain('after 7 tries');
    // no HELLO within 5 s (the room's door): its own alert, not "Connection lost" (review L7)
    expect(closed(1008)).toMatchObject({ kind: 'connection-lost', title: 'Too slow to join', code: 'HELLO_TIMEOUT · room KMTXRA', action: 'rejoin' });
  });

  it('pause: what leaving costs', () => {
    expect(leaveCost(view({ phase: MatchPhase.InProgress, myScore: 6 }), true)).toBe("Your score (6) won't count. You can come back with the room link while the room is open.");
    expect(leaveCost(null, false)).toBe('Nothing from training is kept.');
  });

  it('settings: Reset this tab resets that section only', () => {
    expect(resetPatch('controls')).toMatchObject({ doubleTapDash: true });
    expect(resetPatch('graphics')).toEqual({ graphics: 'auto', showFps: false, blood: false });
    expect(Object.keys(resetPatch('accessibility')!)).toEqual(['reduceFlashes', 'reduceMotion', 'colorBlind', 'textScale']);
    expect(resetPatch('touch')).toBeNull();
  });
});

describe('first-run controls card, warm-up, routes', () => {
  it("the controls card lists the player's own keys", () => {
    const bindings = rebind(defaultBindings(), 'reload', 'KeyK', 0).bindings;
    expect(tipsRows(bindings).find(([what]) => what === 'Reload')?.[1]).toEqual(['KeyK']);
    const html = renderToStaticMarkup(
      <ControllerContext.Provider value={{ closeTips: vi.fn(), openSettings: vi.fn() } as unknown as ShellController}>
        <TipsCard bindings={bindings} />
      </ControllerContext.Provider>,
    );
    expect(html).toContain('How to play');
    expect(html).toMatch(/Reload<\/dt><dd><kbd class="kbd">K<\/kbd>/);
    expect(html).toMatch(/Jet \(hold\)<\/dt><dd><kbd class="kbd">W<\/kbd><kbd class="kbd">Space<\/kbd>/);
    expect(html).toMatch(/Take a gun<\/dt><dd><kbd class="kbd">E<\/kbd>/);
    expect(html).toContain('Got it');
    expect(html).toContain('Double-tap A, D or S to dash that way; Shift alone dashes the way you face (towards your aim).');
  });

  it('the dash tip follows the keys and the double-tap setting', () => {
    const b = rebind(defaultBindings(), 'left', 'KeyJ', 0).bindings;
    expect(dashTip(b, true)).toBe('Double-tap J, D or S to dash that way; Shift alone dashes the way you face (towards your aim).');
    expect(dashTip(b, false)).toBe('Shift alone dashes the way you face (towards your aim).');
    expect(dashTip({ ...b, dash: [] }, false)).toBe('The dash key alone dashes the way you face (towards your aim).');
  });

  it('Settings → Graphics says what Auto picked', () => {
    expect(autoText('high')).toBe('Picks the quality for this device: High here. Choose one below to set it yourself.');
    expect(autoText(undefined)).toBe('Picks the quality for this device. Choose one below to set it yourself.');
  });

  it('the local warm-up has one Ready', () => {
    expect(renderToStaticMarkup(<WarmupBar view={view({ phase: MatchPhase.Waiting })} actions={actions} />)).toMatch(/<button class="btn btn--primary">.*Ready<\/button>/);
    expect(renderToStaticMarkup(<WarmupBar view={view({ phase: MatchPhase.Waiting, ready: true })} actions={actions} />)).toContain('disabled');
  });

  it('a route with its own exit gets no second Back button', () => {
    const route = (ownExit: boolean) => createShellStore({ route: { id: 'locker', title: 'Locker', ownExit, mount: () => {} } });
    expect(renderToStaticMarkup(<App store={route(true)} />)).not.toContain('mf-route__back');
    expect(renderToStaticMarkup(<App store={route(false)} />)).toContain('mf-route__back');
  });
});

describe('routes', () => {
  it('a mount may return a cleanup function or a handle with unmount() (W2 mountLocker)', () => {
    const fn = vi.fn();
    const handle = { loadout: null, unmount: vi.fn() };
    runCleanup(fn);
    runCleanup(handle);
    runCleanup(undefined);
    expect(fn).toHaveBeenCalledOnce();
    expect(handle.unmount).toHaveBeenCalledOnce();
  });
});

describe('map-event banner (docs/02 §20.7)', () => {
  const event = (over: object = {}) => ({
    id: 'emp',
    kind: 'emp',
    name: 'EMP STORM',
    description: 'Jetpacks offline',
    phase: 'warning' as const,
    secondsLeft: 2.4,
    progress: 0.4,
    color: 0xd2a8ff,
    zones: [],
    occurrence: 3,
    bulletRangeMul: 1,
    ...over,
  });

  it('counts whole seconds and changes only when its text does', () => {
    const a = bannerOf(event())!;
    expect(a).toMatchObject({ key: '3:warning', title: 'EMP STORM', seconds: 3, kind: 'emp' });
    expect(sameBanner(a, bannerOf(event({ secondsLeft: 2.1, progress: 0.7 })))).toBe(true);
    expect(sameBanner(a, bannerOf(event({ secondsLeft: 1.9 })))).toBe(false);
    expect(sameBanner(a, bannerOf(event({ phase: 'active' })))).toBe(false);
    expect(bannerOf(null)).toBeNull();
    expect(sameBanner(null, null)).toBe(true);
  });

  it("the kit's banner: \"in 3 s\" with a warning, then the line and the time left", () => {
    const warning = renderToStaticMarkup(<MapEventBanner banner={bannerOf(event())!} />);
    expect(warning).toMatch(/class="event-banner event-banner--warn"/);
    expect(warning).toContain('--ev:var(--c-ev-emp)');
    expect(warning).toMatch(/EMP STORM.*in 3 s/);
    const active = renderToStaticMarkup(<MapEventBanner banner={bannerOf(event({ phase: 'active', secondsLeft: 6 }))!} />);
    expect(active).toMatch(/class="event-banner"/);
    expect(active).toMatch(/6 s.*Jetpacks offline/);
  });
});

describe("the host's tuning panel (pnpm playtest --tune)", () => {
  beforeAll(() => {
    vi.stubGlobal('window', new EventTarget());
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function setup(offered: boolean) {
    const tuning = {
      isOpen: false,
      open: vi.fn(() => {
        tuning.isOpen = true;
      }),
      close: vi.fn(() => {
        tuning.isOpen = false;
      }),
    };
    const host = { local: null, online: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn(), tuning: offered ? tuning : null } as unknown as GameHost;
    const store = createShellStore();
    const ctl = new ShellController(store, host, {} as Api);
    return { store, ctl, tuning };
  }
  const roomLobby = (isHost: boolean): LobbyView => ({
    code: 'KMTXRA',
    players: [{ id: 0, name: 'Ade', ready: false, host: isHost, you: true, isBot: false, pingMs: 24 }],
    isHost,
    ready: false,
    minPlayers: 2,
    timeLimit: 300,
    killLimit: 10,
    mapId: 'movement-test',
    mapName: 'Movement Test',
  });

  it("only the room's host (or anyone in training) gets it, only where the page offers it", () => {
    const { store, ctl } = setup(true);
    store.setState({ screen: { name: 'room', code: 'KMTXRA' }, lobby: roomLobby(false) });
    expect(ctl.canTune()).toBe(false);
    store.setState({ lobby: roomLobby(true) });
    expect(ctl.canTune()).toBe(true);
    store.setState({ screen: { name: 'training' }, lobby: null });
    expect(ctl.canTune()).toBe(true);
    store.setState({ screen: { name: 'home' } });
    expect(ctl.canTune()).toBe(false);
    const plain = setup(false);
    plain.store.setState({ screen: { name: 'training' } });
    expect(plain.ctl.canTune()).toBe(false); // normal production: no panel
  });

  it('Tune the game closes the menu and opens the panel; losing host rights closes it', () => {
    const { store, ctl, tuning } = setup(true);
    store.setState({ screen: { name: 'room', code: 'KMTXRA' }, lobby: roomLobby(true) });
    ctl.openOverlay('menu');
    ctl.openTuning();
    expect(store.getState().overlay).toBeNull();
    expect(tuning.open).toHaveBeenCalledOnce();
    store.setState({ lobby: roomLobby(false) }); // another player is host now
    expect(tuning.close).toHaveBeenCalled();
    expect(tuning.isOpen).toBe(false);
  });

  it("the menu lists Tune the game for the host, not for a guest", () => {
    const menu = (isHost: boolean) => {
      const { store, ctl } = setup(true);
      store.setState({ screen: { name: 'room', code: 'KMTXRA' }, lobby: roomLobby(isHost) });
      return renderToStaticMarkup(
        <ControllerContext.Provider value={ctl}>
          <Pause store={store} />
        </ControllerContext.Provider>,
      );
    };
    expect(menu(true)).toContain('Tune the game');
    expect(menu(false)).not.toContain('Tune the game');
  });
});
