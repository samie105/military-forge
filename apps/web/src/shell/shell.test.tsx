import { Game, MatchEndReason, MatchPhase, Match, ticks, type MatchResults } from '@military-forge/sim';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGE_KEY } from './age';
import { ApiError } from './api';
import { alertFromApiError, alertFromConnection } from './alerts';
import { App, ControllerContext, MapEventBanner, RouteFrame, TipsCard, WarmupBar, tipsRows } from './App';
import { ROUTE_RETRY_MS, loadRoute } from './routeLoad';
import type { Api } from './api';
import { defaultBindings, rebind } from './controls';
import { ShellController, type GameHost } from './controller';
import { bannerOf, sameBanner } from './mapEventBanner';
import { createShellStore, runCleanup } from './store';
import { localMatchRules } from './localMatch';
import { formatClock, matchView, ordinal, sameView, type MatchView } from './matchView';
import { matchGain } from './progress';
import type { LobbyView } from './onlineView';
import { Alert, connectStep, reconnectSecondsLeft } from './screens/Connection';
import { Countdown, countdownState, rulesLine } from './screens/Countdown';
import { codeLetters, cycleLetter, joinState } from './screens/Join';
import { LeaveRoomConfirm, Lobby, killsLabel, lobbyMaps, minutesLabel } from './screens/Lobby';
import { enterAction, nameState, suggestName } from './screens/NameEntry';
import { Pause, leaveCost, pauseHeading } from './screens/Pause';
import { Results, humanMvp, reasonChip, winnerOf, winnerStanding } from './screens/Results';
import { NameTagPreview, autoText, resetPatch } from './screens/Settings';
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

  it("formats clocks and ordinals; a match's XP is the server's one rule (packages/shared, audit 2 P-04)", () => {
    expect([formatClock(5), formatClock(272), formatClock(720), formatClock(-3)]).toEqual(['0:05', '4:32', '12:00', '0:00']);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    expect(matchGain(0, { placement: 1, kills: 3, assists: 2 }).gain).toBe(100 + 30 + 10 + 50);
    expect(matchGain(0, { placement: 3, kills: 0, assists: 0 }).gain).toBe(125); // 2nd and 3rd: +25
    // 250 + 135 = 385: level 2 (100) to level 3 (300), 85 of the 300 to level 4
    expect(matchGain(250, { placement: 2, kills: 1, assists: 0 })).toMatchObject({ gain: 135, levelUp: true, after: { level: 3, xpIntoLevel: 85, xpForNextLevel: 300 } });
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
    standing(9, 'Tunde', 3, { score: -50, deaths: 3 }),
  ],
};

describe("results (the kit's screen 10)", () => {
  it('the winner, why it ended, your place and numbers, the standings with badges, Play again', () => {
    const html = renderToStaticMarkup(<Results view={view({ results })} results={results} actions={actions} room={{ isHost: true, hostId: 4, leave: vi.fn() }} />);
    expect(html).toContain('data-screen="results"');
    expect(html).toMatch(/data-active-state="kill-limit host not-voted"/);
    expect(html).toContain('Debrief · Match 2 · Lunar Outpost');
    expect(html).toMatch(/res__name[^>]*><span class="mf-res__fit"[^>]*>Ade</);
    expect(html).toContain('Kill limit reached · 10 kills');
    expect(html).toMatch(/results\.me\.placement">1st</);
    expect(html).toContain('1,234');
    expect(html).toMatch(/is-winner is-you.*Ade.*Host.*You.*MVP/);
    expect(html).toMatch(/is-bot.*Strafer.*Bot/);
    expect(html).toMatch(/Kemi.*Left/);
    expect(html).toContain('Play again');
    expect(html).toContain('Back to lobby');
    expect(html).toContain('Leave room');
    expect(html).toMatch(/results\.votes" aria-hidden="true">0\/2</);
    // the count said in words, in the button (the screen reader's name for it)
    expect(html).toContain('<span class="vh">0 of 2 voted</span>');
  });

  it('a guest has no Back to lobby; a vote shows as cast; a closed room says so', () => {
    const guest = renderToStaticMarkup(<Results view={view({ phase: MatchPhase.Postgame, voted: true, votes: 1 })} results={results} actions={actions} room={{ isHost: false, hostId: 0, leave: vi.fn() }} />);
    expect(guest).not.toContain('Back to lobby');
    expect(guest).toContain('You voted');
    expect(guest).toMatch(/results\.votes" aria-hidden="true">1\/2 · 7 s</);
    // the vote stays in the primary slot, as cast (disabled), and a landed vote is said
    expect(guest).toMatch(/<button class="btn btn--volt btn--xl btn--block[^"]*" type="button" data-pad-first="true" disabled="">.*?You voted/);
    expect(guest).toContain('role="status">1 of 2 voted, 7 seconds left</span>');
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
    // one who left keeps their row, not the win (audit 28 Oct)
    expect(winnerOf([{ ...p('Gone', 9), left: true }, p('A', 3), p('B', 2)])).toEqual({ name: 'A', draw: false });
  });

  it('a player who left has no place number (audit 28 Oct)', () => {
    const html = renderToStaticMarkup(<Results view={view({ results })} results={results} actions={actions} room={{ isHost: true, hostId: 4, leave: vi.fn() }} />);
    expect(html).toMatch(/<td class="num">–<\/td><th scope="row">.*?Kemi/);
  });

  it('training (solo): the player is the headline, plurals are right, no vote and no lobby: Play again or Leave (audit 28 Oct)', () => {
    const solo: MatchResults = {
      ...results,
      standings: [standing(0, 'Mantis', 1, { isBot: true, score: 5, kills: 5, deaths: 1, rating: 500, mvp: true }), standing(4, 'Ade', 2, { score: 1, kills: 1, deaths: 1 })],
    };
    const html = renderToStaticMarkup(<Results view={view({ humans: 1 })} results={solo} actions={actions} training={{ leave: vi.fn() }} />);
    expect(html).toMatch(/res__name[^>]*>2nd place</);
    expect(html).toContain('Mantis won · ');
    expect(html).toMatch(/results\.me\.kills">1<\/span> kill · <span class="num" data-bind="results\.me\.deaths">1<\/span> death ·/);
    expect(html).not.toContain('Play again?');
    expect(html).not.toContain('results.votes');
    expect(html).not.toContain('Back to lobby');
    expect(html).toContain('Play again');
    expect(html).toMatch(/door-out.*Leave</);
    const won = renderToStaticMarkup(
      <Results view={view({ humans: 1 })} results={{ ...solo, standings: [standing(4, 'Ade', 1, { score: 5, kills: 5 }), standing(0, 'Mantis', 2, { isBot: true })] }} actions={actions} training={{ leave: vi.fn() }} />,
    );
    expect(won).toMatch(/res__name[^>]*>Victory</);
  });
});

describe('results alone against bots (audit 2 P-02, P-03, P-06)', () => {
  const alone: MatchResults = {
    ...results,
    standings: [standing(0, '[BOT] Badger', 1, { isBot: true, score: 9, kills: 9, mvp: true }), standing(4, 'Ade', 4, { kills: 0, deaths: 4, damageDealt: 30 }), standing(2, '[BOT] Mantis', 2, { isBot: true }), standing(3, '[BOT] Kestrel', 3, { isBot: true })],
  };
  const room = { isHost: true, hostId: 4, code: 'KMTXRA', leave: vi.fn() };
  // the share buttons need the shell (its share sheet)
  const withShell = (node: import("react").ReactNode) => renderToStaticMarkup(<ControllerContext.Provider value={{ store: createShellStore(), shareLink: vi.fn() } as unknown as ShellController}>{node}</ControllerContext.Provider>);

  it('the player is the headline; no bot gets the MVP card, the tag or "Beat me"', () => {
    const html = renderToStaticMarkup(<Results view={view({ humans: 1 })} results={alone} actions={actions} room={room} />);
    expect(html).toMatch(/res__name[^>]*>4th place</);
    expect(html).toContain('Badger won · ');
    expect(html).not.toContain('results.mvp');
    expect(html).not.toContain('Beat me');
    expect(html).not.toMatch(/tag--brass/);
    expect(html).toContain('mf-res__me'); // your soldier, not the winner's trophy
  });

  it('Play again is the primary button; Share the room drops to a quiet one under it', () => {
    const html = withShell(<Results view={view({ humans: 1 })} results={alone} actions={actions} room={room} />);
    expect(html).toMatch(/btn--volt btn--xl btn--block[^"]*"[^>]*>.*?Play again/);
    expect(html).not.toMatch(/btn--volt btn--xl btn--block[^"]*"[^>]*>(?:(?!<\/button>).)*Share the room/);
    expect(html).toMatch(/btn--ghost[^"]*"[^>]*>(?:(?!<\/button>).)*Share the room/);
    expect(html).not.toContain('results.votes');
    expect(html).toContain('Back to lobby');
  });

  it('with people, a person still gets the MVP card; Play again still leads, its vote inside it, and Share is second (UX-40)', () => {
    const html = withShell(<Results view={view({ results })} results={results} actions={actions} room={{ ...room, code: 'KMTXRA' }} />);
    expect(html).toContain('results.mvp');
    // the one volt button is Play again, the first control of the column, where a controller lands
    expect(html.match(/btn--volt/g)).toHaveLength(1);
    expect(html).toMatch(/<section class="res__share"[^>]*><button class="btn btn--volt btn--xl btn--block[^"]*" type="button" data-pad-first="true">(?:(?!<\/button>).)*Play again(?:(?!<\/button>).)*results\.votes/);
    expect(html).not.toMatch(/btn--volt[^"]*"[^>]*>(?:(?!<\/button>).)*Share the room/);
    expect(html).toMatch(/btn--paper btn--block[^"]*"[^>]*>(?:(?!<\/button>).)*Share the room/);
    // the order: Play again, Share, the ways out, then the MVP card
    const at = (t: string) => html.indexOf(t);
    expect(at('Play again')).toBeLessThan(at('Share the room'));
    expect(at('Share the room')).toBeLessThan(at('Back to lobby'));
    expect(at('Leave room')).toBeLessThan(at('results.mvp'));
    expect(html).not.toContain('Play again?');
  });

  it('a bad loss to a bot: the line names it as a bot', () => {
    const html = renderToStaticMarkup(<Results view={view({ humans: 1 })} results={alone} actions={actions} room={room} />);
    expect(html).toMatch(/res__line"><span class="tag tag--bot mf-res__tag">.*?Bot<\/span>Badger won · /);
  });
});

describe('results: a bot winner, the standings rows, the MVP rule (UX-40, UX-41)', () => {
  // a room with two people where a bot took it
  const botWin: MatchResults = {
    ...results,
    reason: MatchEndReason.TimeLimit,
    standings: [standing(2, '[BOT] Kestrel', 1, { isBot: true, score: 3, kills: 3, deaths: 2, mvp: true }), standing(5, '[BOT] Badger', 2, { isBot: true, score: 2, kills: 2 }), standing(4, 'Atlas1442723', 3, { deaths: 1 }), standing(6, 'Atlas4980', 4, { deaths: 1 })],
  };
  const room = { isHost: true, hostId: 4, code: 'KMTXRA', leave: vi.fn() };

  it("the poster shows the bot's own soldier with the Bot tag, never a bare trophy; the headline says it is a bot", () => {
    const html = renderToStaticMarkup(<Results view={view({ results: botWin })} results={botWin} actions={actions} room={room} />);
    expect(html).toContain('class="mf-res__who"');
    expect(html).not.toContain('mf-res__trophy');
    expect(html).toMatch(/class="mf-res__bot" aria-hidden="true"><span class="tag tag--bot">.*?Bot<\/span>/);
    expect(html).toMatch(/res__name[^>]*><span class="mf-res__fit" style="--len:7"><span class="vh">Bot <\/span>Kestrel</);
    expect(html).toMatch(/res__stamp[^>]*>Winner</);
    // a bot is never the MVP
    expect(html).not.toContain('results.mvp');
  });

  it("a person's win shows their soldier too; a draw keeps the trophy", () => {
    const won = renderToStaticMarkup(<Results view={view({ results })} results={results} actions={actions} room={room} />);
    expect(won).toContain('mf-res__who');
    expect(won).not.toContain('mf-res__bot');
    const tie: MatchResults = { ...results, standings: [standing(4, 'Ade', 1, { score: 3 }), standing(9, 'Tunde', 1, { score: 3 })] };
    expect(renderToStaticMarkup(<Results view={view({ results: tie })} results={tie} actions={actions} room={room} />)).toContain('mf-res__trophy');
  });

  // a shell where friends work (signed in, online): the rows' Add friend and report / block; minor: an under-18 profile
  const withFriends = (node: import('react').ReactNode, minor = false) => {
    const store = createShellStore();
    store.setState({ profile: { nickname: 'Atlas1442723', offline: false, minor } as never });
    const shell = { store, api: { authed: () => true, onSignIn: () => () => {}, ping: () => new Promise(() => {}) }, go: vi.fn(), notify: vi.fn(), shareLink: vi.fn() } as unknown as ShellController;
    return renderToStaticMarkup(<ControllerContext.Provider value={shell}>{node}</ControllerContext.Provider>);
  };

  it('a row is one line: the name in its own cut box, tags after it, the actions in a trailing cell', () => {
    const html = withFriends(<Results view={view({ results: botWin })} results={botWin} actions={actions} room={room} />);
    expect(html).toMatch(/<span class="mf-standings__name" title="Atlas1442723">Atlas1442723<\/span><span class="tag tag--host mf-tag--mark" title="Host">.*?<span class="vh">Host<\/span><\/span><span class="tag tag--you">You<\/span>/);
    expect(html).toMatch(/<th scope="col" class="mf-standings__act"><span class="vh">Actions<\/span><\/th>/);
    // the other person's report / block sits in the row's last cell, not under their name
    expect(html).toMatch(/Atlas4980<\/span><\/span><\/th>(?:<td[^>]*>[^<]*<\/td>){4}<td class="mf-standings__act"><span class="mf-row-actions">/);
    expect(html).toContain('aria-label="Report, block or mute Atlas4980"');
    // training has no row actions, so no column for them; nor has an under-18 player (no friends, no reports: audit 2 L-03)
    expect(withFriends(<Results view={view({ humans: 1 })} results={botWin} actions={actions} training={{ leave: vi.fn() }} />)).not.toContain('mf-standings__act');
    expect(withFriends(<Results view={view({ results: botWin })} results={botWin} actions={actions} room={room} />, true)).not.toContain('mf-standings__act');
  });

  it('the winner row and the MVP: a draw has no winner; nobody is decorated for a match without a kill; "1 kill"', () => {
    const p = (name: string, score: number, isBot = false) => ({ name, score, isBot });
    expect(winnerStanding([p('A', 3), p('B', 2, true)])).toMatchObject({ name: 'A' });
    expect(winnerStanding([p('A', 3), p('B', 3)])).toBeNull();
    expect(winnerStanding([])).toBeNull();
    expect(humanMvp([{ mvp: true, isBot: false, kills: 0 }])).toBeUndefined();
    expect(humanMvp([{ mvp: true, isBot: true, kills: 4 }])).toBeUndefined();
    expect(humanMvp([{ mvp: true, isBot: false, kills: 1 }])).toBeDefined();
    expect(reasonChip({ reason: MatchEndReason.KillLimit, durationTicks: ticks(60) }, 1).text).toBe('Kill limit reached · 1 kill');
  });

  it('training: Play again leads, Leave is a quiet button after it; once pressed it says so', () => {
    const solo: MatchResults = { ...results, standings: [standing(0, '[BOT] Mantis', 1, { isBot: true, score: 5, kills: 5 }), standing(4, 'Ade', 2, { score: 1, kills: 1 })] };
    const html = renderToStaticMarkup(<Results view={view({ humans: 1 })} results={solo} actions={actions} training={{ leave: vi.fn() }} />);
    expect(html).toMatch(/<section class="res__share"[^>]*><button class="btn btn--volt btn--xl btn--block[^"]*" type="button" data-pad-first="true">.*?Play again<\/button>/);
    expect(html).toMatch(/mf-res__more"><button class="btn btn--ghost[^"]*" type="button" data-pad-leave="true">.*?Leave</);
    const pressed = renderToStaticMarkup(<Results view={view({ humans: 1, voted: true })} results={solo} actions={actions} training={{ leave: vi.fn() }} />);
    expect(pressed).toMatch(/btn--volt btn--xl btn--block[^"]*" type="button" data-pad-first="true" disabled="">.*?Starting again/);
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
    // the map's poster pinned above the band (owner 31 Oct: real posters, not drawings)
    expect(intro).toMatch(/<figure class="intro__print" aria-hidden="true"><img class="mapart" src="\/assets\/posters\/lunar-outpost-wide\.webp"/);
  });

  it('the stepper: Match N → 3 → 2 → 1 → GO, the stops passed dimmed and the one now lit; Hold Tab', () => {
    const html = renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.Countdown, secondsLeft: 2, number: 2 })} state="2" bindings={defaultBindings()} />);
    expect(html).toContain('<ol class="mf-cd__steps" aria-hidden="true"><li class="is-done">Match 2</li><li class="is-done">3</li><li class="is-now">2</li><li>1</li><li>GO</li></ol>');
    expect(html).toMatch(/hold <kbd[^>]*>Tab<\/kbd> to see who&#x27;s in/);
    const go = renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.InProgress, number: 2 })} state="go" />);
    expect(go).toContain('<li class="is-now">GO</li>');
  });

  it('GO says Go without an exclamation mark, and leaves instead of cutting out (audit 28 Oct)', () => {
    const go = renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.InProgress, number: 1 })} state="go" />);
    expect(go).toContain('class="display cd__go m-p7">Go</b>');
    expect(go).not.toContain('Go!');
    const leaving = renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.InProgress, number: 1 })} state="go-leaving" />);
    expect(leaving).toContain('class="display cd__go m-p7 is-leaving">Go</b>');
    expect(leaving).toContain('<li class="is-now">GO</li>');
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
    mapName: 'Proving Ground',
    bots: 4,
    botLevel: 'normal',
  });
  const online = { play: vi.fn(), setReady: vi.fn(), startMatch: vi.fn() };
  // (a server render reads the store's first state: a fresh store for each)
  const render = (isHost: boolean, view = lobby(isHost), store = createShellStore()) =>
    renderToStaticMarkup(
      <ControllerContext.Provider value={{ store, host: { online }, copyLink: vi.fn(), shareOnWhatsApp: vi.fn(), shareLink: vi.fn(), openSettings: vi.fn(), leave: vi.fn() } as unknown as ShellController}>
        <Lobby lobby={view} />
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
    // the room's bots (v17): Off / Fill to 4 / Fill to 8, and the level
    expect(html).toContain('Bots fill to 4 · Normal');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Fill to 4</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Off</);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Normal</);
    // every map card shows the map's poster (owner 31 Oct: "it's using something dummy"), the drawn thumbnails are gone
    for (const id of lobbyMaps('movement-test')) expect(html).toContain(`<div class="thumb"><img class="mapart" src="/assets/posters/${id}-card.webp"`);
    expect(html).not.toMatch(/thumb--|thumb__/);
    // the first rows load at once, the ones further down the list as it scrolls
    expect(html.match(/loading="eager"/g)).toHaveLength(4);
  });

  it('a controller lands on the match, never on Leave; Leave asks first (audit 2, N-04)', () => {
    const host = render(true);
    expect(host).toMatch(/data-pad-leave="true"[^>]*>(?:(?!<\/button>).)*Leave<\/button>/);
    expect(host).toMatch(/data-pad-first="true"[^>]*>(?:(?!<\/button>).)*Start now/);
    expect(render(false)).toMatch(/role="switch"[^>]*data-pad-first="true"/);
    // the question itself: Stay first, B and Escape are Stay
    const confirm = renderToStaticMarkup(
      <ControllerContext.Provider value={{ leave: vi.fn() } as unknown as ShellController}>
        <LeaveRoomConfirm onStay={vi.fn()} />
      </ControllerContext.Provider>,
    );
    expect(confirm).toContain('Leave the room?');
    expect(confirm).toContain('You can come back with the room link while the room is open.');
    expect(confirm).toMatch(/data-pad-first="true" data-pad-back="true">Stay/);
  });

  it('a guest reads the settings, and the highlight follows the guest', () => {
    const html = render(false);
    expect(html).toMatch(/data-active-state="guest not-ready link-idle"/);
    expect(html).toContain('The host picks the settings');
    expect(html).toContain('5 min');
    expect(html).toContain('10 kills');
    expect(html).toContain('Bots fill to 4 · Normal'); // a guest sees the room's bots, can't change them
    expect(html).not.toContain('Fill to 8');
    expect(html).toMatch(/prow is-you-guest.*Kemi/);
    expect(html).not.toContain('Start now');
    expect([minutesLabel(0), killsLabel(0), minutesLabel(120)]).toEqual(['No time limit', 'No kill limit', '2 min']);
    expect(lobbyMaps('movement-test')).not.toContain('mechanics-test');
    expect(lobbyMaps('mechanics-test')).toContain('mechanics-test');
  });

  it('a spectator (v20): no Ready, Start or warm-up; Join next round, then Stay watching once in line', () => {
    const watched = { ...lobby(false), players: lobby(false).players.map((p) => ({ ...p, you: false })), ready: false };
    const html = render(false, watched, createShellStore({ spectating: true, spectateQueue: 0 }));
    expect(html).toMatch(/data-active-state="guest not-ready link-idle watching"/);
    expect(html).toContain('You&#x27;re watching · you&#x27;ll play when a slot opens');
    expect(html).toContain('Join next round');
    expect(html).not.toContain('Stay watching');
    expect(html).not.toContain('role="switch"'); // Ready / You're ready
    expect(html).not.toContain('Start now');
    expect(html).not.toContain('Warm up');
    const queued = render(false, watched, createShellStore({ spectating: true, spectateQueue: 2 }));
    expect(queued).toContain('In line for a slot');
    expect(queued).toContain('Stay watching');
    expect(queued).not.toContain('Join next round');
    expect(render(false)).not.toContain('Join next round');
  });
});

describe('join, names, connection, pause and settings', () => {
  it('join: letters only, the code from a pasted link, and its states', () => {
    expect(codeLetters('kmt-x1ra')).toBe('KMTXRA');
    expect(codeLetters('ILO')).toBe('');
    expect([joinState('', false, null), joinState('KMT', false, null), joinState('KMTXRA', true, null), joinState('KMTXRA', false, null), joinState('KMTXRB', false, 'No room')]).toEqual(['empty', 'typing', 'pasted', 'ready', 'error']);
  });

  it('join with a controller: up and down step a box through the code letters, wrapping round (audit 2, N-05)', () => {
    // an empty box: down starts at A, up at Z
    expect(cycleLetter('', 0, 1)).toEqual({ code: 'A', at: 0 });
    expect(cycleLetter('', 0, -1)).toEqual({ code: 'Z', at: 0 });
    // a letter steps over the ones codes skip (I, L, O) and wraps
    expect(cycleLetter('KH', 1, 1)).toEqual({ code: 'KJ', at: 1 });
    expect(cycleLetter('KZ', 1, 1)).toEqual({ code: 'KA', at: 1 });
    // a box past the code's end steps the next free one; never past six letters
    expect(cycleLetter('KM', 4, 1)).toEqual({ code: 'KMA', at: 2 });
    expect(cycleLetter('KMTXRA', 5, -1).code).toBe('KMTXRZ');
    // a friend code's own alphabet and length
    expect(cycleLetter('', 0, 1, '23456789ABCDEFGHJKMNPQRSTVWXYZ', 8)).toEqual({ code: '2', at: 0 });
  });

  it('Edit name: Suggest a name gives a generated name the name rules take (audit 2, N-05)', () => {
    expect(suggestName(() => 0)).toBe('SwiftFalcon100');
    expect(suggestName(() => 0.999)).toBe('BlazingRocket999');
    for (let i = 0; i < 20; i++) expect(suggestName()).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+[1-9][0-9]{2}$/);
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

  it('name entry: Enter submits when Continue would; mid-check it waits for the check, never sending a name it refuses (audit L1; audit 28 Oct)', () => {
    expect(enterAction('available', true, false)).toBe('submit');
    // typed, then Enter at once: it waits for the check, and goes only if the name passes
    expect(enterAction('checking', false, false)).toBe('after-check');
    expect(enterAction('checking', false, true)).toBe('none');
    expect(enterAction('too-short', false, false)).toBe('none');
    expect(enterAction('taken', false, false)).toBe('none');
    expect(enterAction('invalid', false, false)).toBe('none');
    expect(enterAction('empty', false, false)).toBe('none');
  });

  it('connection: the steps, and the reconnect countdown', () => {
    expect(connectStep(null, false)).toBe(1);
    const c = { state: 'connected' as const, detail: '', code: 0, since: 0, until: 0, attempt: 0, lastPingMs: -1, lossPct: 0 };
    expect(connectStep(c, false)).toBe(2);
    expect(reconnectSecondsLeft(60_000, 1_500)).toBe(59);
    expect(reconnectSecondsLeft(60_000, 70_000)).toBe(0);
  });

  it('alerts: a local room speaks of the host and the Wi-Fi, never a server, and offers the QR swap when unreachable', () => {
    const local = (code: number, room = 'KMTXRA') => alertFromConnection({ code, detail: '', attempt: 3, lastPingMs: -1, lossPct: 0 }, room, false, true);
    expect(local(1006)).toMatchObject({ kind: 'connection-lost', title: 'Can’t reach the room', action: 'rejoin', qrSwap: true, code: 'LOCAL_UNREACHABLE · 3 tries · room KMTXRA' });
    expect(local(1006).message).toContain('same Wi-Fi as the host');
    expect(local(4006)).toMatchObject({ kind: 'room-not-found', title: 'The room has closed', action: 'rejoin' });
    expect(local(4006, '')).toMatchObject({ kind: 'room-not-found', action: null });
    expect(local(4002)).toMatchObject({ kind: 'room-full', action: 'rejoin' });
    expect(local(4001)).toMatchObject({ kind: 'new-version', action: 'reload' });
    for (const c of [1006, 4006, 4002, 4001]) expect(local(c).message).not.toMatch(/server/i);
  });

  it("alerts: API errors and close codes in the kit's words", () => {
    // a room that's gone leads Home, Try again beside it (UX-16)
    expect(alertFromApiError(new ApiError(404, 'room_not_found', 'x'), 'KMTXRA')).toMatchObject({ kind: 'room-not-found', code: 'ROOM_NOT_FOUND · room KMTXRA', action: 'rejoin', lead: 'home' });
    // no API: the player's connection only when the browser says it's offline; else it may be ours
    expect(alertFromApiError(new ApiError(0, 'network', 'down'), undefined, { online: false, api: 'checking' })).toMatchObject({ kind: 'offline', action: 'rejoin', lead: 'training' });
    const down = alertFromApiError(new ApiError(0, 'network', 'down'), undefined, { online: true, api: 'checking' });
    expect(down).toMatchObject({ kind: 'server-down', stamp: 'No answer', action: 'rejoin', lead: 'training' });
    expect(down.message).not.toMatch(/wi-?fi|your data/i);
    expect(alertFromApiError(new ApiError(429, 'rate_limited', 'x', { retryAfter: 30 })).message).toBe('Wait 30 s, then try again.');
    const closed = (code: number, detail = '') => alertFromConnection({ code, detail, attempt: 7, lastPingMs: 412, lossPct: 18.2 }, 'KMTXRA');
    expect(closed(4001)).toMatchObject({ kind: 'new-version', action: 'reload' });
    // a full room offers to watch it (v20), with Try again beside it
    expect(closed(4002)).toMatchObject({ kind: 'room-full', code: 'ROOM_FULL · room KMTXRA', action: 'watch', message: 'Every slot is taken. Watch the match and take the next free slot.' });
    expect(closed(4008)).toMatchObject({ kind: 'room-full', title: 'Spectator seats are full', message: 'This room has all the spectators it takes. Try again in a bit.', code: 'SPECTATORS_FULL · room KMTXRA', action: 'rejoin' });
    expect(closed(4006).kind).toBe('server-full');
    // a watcher never opens a room: no room means nobody is playing in it
    expect(alertFromConnection({ code: 4006, detail: '', attempt: 0, lastPingMs: -1, lossPct: 0 }, 'KMTXRA', true)).toMatchObject({ kind: 'room-not-found', title: 'Nothing to watch', message: expect.stringContaining('Nobody is playing in this room right now') as string, action: 'rejoin' });
    expect(closed(4007, 'the room has closed')).toMatchObject({ kind: 'room-not-found', action: null });
    expect(closed(4007, 'your pass for this room expired: open the room link again')).toMatchObject({ kind: 'refused', action: 'rejoin' });
    expect(closed(1006)).toMatchObject({ kind: 'connection-lost', code: 'CONNECTION_LOST · 1006 · last ping 412 ms, 18% loss' });
    expect(closed(1006).message).toContain('after 7 tries');
    // no HELLO within 5 s (the room's door): its own alert, not "Connection lost" (review L7)
    // a late HELLO is a busy device, not the network (UX-20): no Wi-Fi blame, no code
    expect(closed(1008)).toMatchObject({ title: 'Took too long to load', message: 'Your device took too long to load the room. Try again.', code: '', action: 'rejoin' });
    expect(closed(1008).message).not.toMatch(/wi-?fi|data|connection/i);
  });

  it('pause: what leaving costs', () => {
    expect(leaveCost(view({ phase: MatchPhase.InProgress, myScore: 6 }), true)).toBe("Your score (6) won't count. You can come back with the room link while the room is open.");
    expect(leaveCost(null, false)).toBe('Nothing from training is kept.');
  });

  it('settings: the colour-blind name tags preview the chosen pair, each team with its shape', () => {
    const std = renderToStaticMarkup(<NameTagPreview mode="standard" />);
    expect(std).toContain('--a:var(--c-team-a);--b:var(--c-team-b)');
    expect(std).toMatch(/In match:.*◆.*Kemi.*▲.*Tolu/);
    expect(renderToStaticMarkup(<NameTagPreview mode="deutan" />)).toContain('--b:var(--c-warn)');
    expect(renderToStaticMarkup(<NameTagPreview mode="tritan" />)).toContain('--a:var(--c-hp);--b:var(--c-ev-squall)');
  });

  it('settings: Reset this tab resets that section only', () => {
    expect(resetPatch('controls')).toMatchObject({ doubleTapDash: true });
    expect(resetPatch('graphics')).toEqual({ graphics: 'auto', showFps: false, blood: false, showKillEffects: true, damageNumbers: true, hitMarkers: true });
    expect(Object.keys(resetPatch('accessibility')!)).toEqual(['reduceFlashes', 'softBursts', 'reduceMotion', 'reduceTransparency', 'colorBlind', 'textScale']);
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
    expect(renderToStaticMarkup(<WarmupBar view={view({ phase: MatchPhase.Waiting })} actions={actions} />)).toMatch(/<button class="btn btn--volt m-p8">.*Ready<\/button>/);
    expect(renderToStaticMarkup(<WarmupBar view={view({ phase: MatchPhase.Waiting, ready: true })} actions={actions} />)).toContain('disabled');
  });

  it('a route with its own exit gets no second Back button', () => {
    const route = (ownExit: boolean) => createShellStore({ route: { id: 'locker', title: 'Locker', ownExit, mount: () => {} } });
    expect(renderToStaticMarkup(<App store={route(true)} />)).not.toContain('mf-route__back');
    expect(renderToStaticMarkup(<App store={route(false)} />)).toContain('mf-route__back');
  });
});

describe('routes', () => {
  it('a route whose code loads shows its frame at once: its word, Back, the title and a loading line (no blank screen)', () => {
    const store = createShellStore({ route: { id: 'locker', title: 'Locker', ownExit: true, load: () => new Promise<never>(() => {}) } });
    const html = renderToStaticMarkup(<App store={store} />);
    expect(html).toContain('data-screen="route-wait"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<div class="bg__word">LOCKER<\/div>/);
    expect(html).toMatch(/aria-label="Back"/);
    expect(html).toMatch(/<h1 class="menu-top__title">Locker<\/h1>/);
    expect(html).toContain('Loading…');
    // the route draws its own Back once it's in: the shell's isn't added on top
    expect(html).not.toContain('mf-route__back');
  });

  it("a route's frame when its code couldn't be fetched: what happened, Try again and Back", () => {
    const html = renderToStaticMarkup(<RouteFrame route={{ title: 'Create your soldier', word: 'Soldier', ownExit: true }} failed />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Couldn&#x27;t load this screen');
    expect(html).toMatch(/Try again<\/button>/);
    expect(html).toMatch(/Back<\/button>/);
    expect(html).toMatch(/<div class="bg__word">SOLDIER<\/div>/);
    // a route without its own exit has the shell's Back: none in the frame's header
    expect(renderToStaticMarkup(<RouteFrame route={{ title: 'Tour' }} failed={false} />)).not.toMatch(/<header class="menu-top"><button/);
  });

  it("a route's code gets one quiet second try, then fails", async () => {
    const mount = () => {};
    const wait = vi.fn(() => Promise.resolve());
    let calls = 0;
    const flaky = { load: () => (++calls === 1 ? Promise.reject(new Error('dropped')) : Promise.resolve(mount)) };
    await expect(loadRoute(flaky, wait)).resolves.toBe(mount);
    expect(calls).toBe(2);
    expect(wait).toHaveBeenCalledWith(ROUTE_RETRY_MS);
    const gone = { load: vi.fn(() => Promise.reject(new Error('404'))) };
    await expect(loadRoute(gone, wait)).rejects.toThrow('404');
    expect(gone.load).toHaveBeenCalledTimes(2);
    await expect(loadRoute({ load: () => Promise.resolve(mount) }, wait)).resolves.toBe(mount);
  });

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
    mapName: 'Proving Ground',
    bots: 4,
    botLevel: 'normal',
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

  it('the menu never claims to pause an online match; training really pauses (audit 28 Oct)', () => {
    expect(pauseHeading(false, MatchPhase.InProgress)).toEqual({ eyebrow: 'Training on hold', title: 'Paused' });
    expect(pauseHeading(true, MatchPhase.InProgress)).toEqual({ eyebrow: "Online play can't pause", title: 'Match continues' });
    expect(pauseHeading(true, MatchPhase.Countdown).title).toBe('Match continues');
    expect(pauseHeading(true, MatchPhase.Waiting)).toEqual({ eyebrow: 'Room', title: 'Menu' });
    // a static render reads the store's first state: the room is in it from the start
    const store = createShellStore({ screen: { name: 'room', code: 'KMTXRA' }, lobby: roomLobby(true), match: view({ phase: MatchPhase.InProgress }) });
    const { ctl } = setup(true);
    const html = renderToStaticMarkup(
      <ControllerContext.Provider value={ctl}>
        <Pause store={store} />
      </ControllerContext.Provider>,
    );
    expect(html).toMatch(/pause__title pause__title--long">Match continues</);
    // Leave sits under the scrolling list, always in view
    expect(html).toMatch(/pause__list.*<\/div><div class="pause__end"><button[^>]*>.*Leave match/);
  });
});

describe('watching a room (v20 spectators)', () => {
  beforeAll(() => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('history', { pushState: () => {}, replaceState: () => {}, state: null });
    vi.stubGlobal('location', { origin: 'https://abc.example', host: 'abc.example', protocol: 'https:', pathname: '/', search: '' });
    // this device answered the 18+ step (shell/age.ts): online rooms open
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === AGE_KEY ? JSON.stringify({ adult: true, birthYear: 1995, at: 0 }) : null), setItem: () => {}, removeItem: () => {} });
  });
  afterAll(() => vi.unstubAllGlobals());

  function setup(api: Partial<Api>) {
    const host = { local: null, online: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost & { startOnline: ReturnType<typeof vi.fn> };
    const store = createShellStore();
    const ctl = new ShellController(store, host, api as Api);
    store.setState({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
    return { store, ctl, host };
  }
  const room = { code: 'KMTXRA', roomId: 'r1', gsUrl: 'wss://gs.example/ws/KMTXRA', ticket: 't1' };

  it('the watch intent finds the room like Join, then starts it as a spectator; its retry watches again', async () => {
    const joinRoom = vi.fn(async () => room);
    const { store, ctl, host } = setup({ joinRoom });
    ctl.go({ to: 'watch', code: 'KMTXRA' });
    await vi.waitFor(() => expect(store.getState().screen).toEqual({ name: 'room', code: 'KMTXRA', watch: true }));
    expect(joinRoom).toHaveBeenCalledWith('KMTXRA');
    expect(host.startOnline).toHaveBeenCalledWith('wss://gs.example/ws/KMTXRA', 'Ade', 'KMTXRA', 't1', expect.any(Function), { spectate: true });
    // the long-drop ticket refresh asks the API again, as for a player
    const refresh = host.startOnline.mock.calls[0]![4] as () => Promise<string | null>;
    await expect(refresh()).resolves.toBe('t1');
    ctl.rejoin();
    await vi.waitFor(() => expect(host.startOnline).toHaveBeenCalledTimes(2));
    expect(host.startOnline.mock.calls[1]![5]).toEqual({ spectate: true });
    // Join plays (no spectate option)
    ctl.go({ to: 'join', code: 'KMTXRA' });
    await vi.waitFor(() => expect(host.startOnline).toHaveBeenCalledTimes(3));
    expect(host.startOnline.mock.calls[2]).toHaveLength(5);
    expect(store.getState().screen).toEqual({ name: 'room', code: 'KMTXRA' });
  });

  it("Join with code's Watch: no room stays on the screen; a full room's Watch watches the room on screen", async () => {
    const { store, ctl, host } = setup({ joinRoom: vi.fn(async (code: string) => (code === 'KMTXRA' ? room : Promise.reject(new ApiError(404, 'room_not_found', 'no room')))) });
    expect(await ctl.watchByCode('ZZZZZZ')).toBe('not_found');
    expect(host.startOnline).not.toHaveBeenCalled();
    store.setState({ screen: { name: 'room', code: 'KMTXRA' } }); // a player's connection, refused: the room is full
    ctl.watchHere();
    await vi.waitFor(() => expect(store.getState().screen).toEqual({ name: 'room', code: 'KMTXRA', watch: true }));
    expect(host.startOnline.mock.calls[0]![5]).toEqual({ spectate: true });
    // an API failure while watching: its retry is a watch
    const down = setup({ joinRoom: vi.fn(async () => Promise.reject(new ApiError(0, 'network', 'down'))) });
    down.ctl.watch('KMTXRA');
    await vi.waitFor(() => expect(down.store.getState().screen).toMatchObject({ name: 'error', retry: { to: 'watch', code: 'KMTXRA' } }));
  });

  it('the full-room alert: Watch first, Try again beside it', () => {
    const { ctl } = setup({});
    const full = alertFromConnection({ code: 4002, detail: '', attempt: 0, lastPingMs: -1, lossPct: 0 }, 'KMTXRA');
    const html = renderToStaticMarkup(
      <ControllerContext.Provider value={ctl}>
        <Alert alert={full} onRejoin={() => {}} />
      </ControllerContext.Provider>,
    );
    expect(html).toMatch(/btn btn--volt btn--xl m-p8" type="button" data-hook="watch">.*Watch<\/button><button class="btn btn--paper btn--xl m-p8" type="button">.*Try again/);
  });
});
