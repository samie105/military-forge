import { Game, MatchEndReason, MatchPhase, Match, ticks, type MatchResults } from '@military-forge/sim';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Countdown, Lobby, MatchStatus, Results } from './App';
import { runCleanup } from './store';
import { localMatchRules } from './localMatch';
import { formatClock, matchView, ordinal, placeholderXp, sameView, type MatchView } from './matchView';

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
  localId: 4,
  myScore: 3,
  leaderScore: 5,
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

describe('screens', () => {
  it('results: your placement, the standings with badges, and Play again', () => {
    const html = renderToStaticMarkup(<Results view={view({ results })} results={results} actions={actions} />);
    expect(html).toContain('Match 2 · Kill limit reached · 2:34');
    expect(html).toContain('Victory');
    expect(html).toContain('5.00'); // K/D 10/2
    expect(html).toContain('+255'); // placeholder XP: 100 + 10·10 + 5·1 + 50
    expect(html.match(/<tr/g)).toHaveLength(4);
    expect(html).toMatch(/class="mm-me".*Ade.*MVP/);
    expect(html).toMatch(/Strafer.*BOT/);
    expect(html).toMatch(/class="mm-left".*Kemi.*LEFT/);
    expect(html).toMatch(/<button class="mm-btn mm-primary">Play again<\/button>/);
    expect(html).toContain('Rematch 0/2');
  });

  it('results: a leaver who held your slot id is not you', () => {
    // Kemi (slot 4) won and left; you joined into slot 4 and finished 3rd
    const reused: MatchResults = {
      ...results,
      standings: [
        standing(4, 'Kemi', 1, { key: 1, left: true, score: 5, kills: 5 }),
        standing(0, 'Strafer', 2, { isBot: true }),
        standing(4, 'You', 3, { key: 9, kills: 1, deaths: 4 }),
      ],
    };
    const html = renderToStaticMarkup(<Results view={view()} results={reused} actions={actions} />);
    expect(html).toContain('3rd place');
    expect(html).not.toContain('Victory');
    expect(html).toMatch(/class="mm-left".*Kemi.*class="mm-me".*You/);
  });

  it('results: other placements, a cast vote, the vote timer and a closed room', () => {
    const third = { ...results, standings: results.standings.map((s) => (s.id === 4 ? { ...s, placement: 3 } : s)) };
    let html = renderToStaticMarkup(<Results view={view({ phase: MatchPhase.Postgame, voted: true, votes: 1 })} results={third} actions={actions} />);
    expect(html).toContain('3rd place');
    expect(html).toMatch(/<button class="mm-btn mm-primary" disabled="">Waiting for others…<\/button>/);
    expect(html).toContain('Rematch 1/2 · 7 s');
    html = renderToStaticMarkup(<Results view={view({ phase: MatchPhase.Closed })} results={results} actions={actions} />);
    expect(html).toContain('Room closed');
    expect(html).toMatch(/disabled="">Back to lobby/);
  });

  it('countdown, match clock and lobby', () => {
    expect(renderToStaticMarkup(<Countdown view={view({ phase: MatchPhase.Countdown, secondsLeft: 3, number: 1 })} />)).toMatch(
      /Match 1 · Deathmatch · first to 10.*>3</,
    );
    const status = renderToStaticMarkup(<MatchStatus view={view({ phase: MatchPhase.InProgress, secondsLeft: 272 })} />);
    expect(status).toContain('4:32');
    const untimed = renderToStaticMarkup(<MatchStatus view={view({ phase: MatchPhase.InProgress, untimed: true, secondsLeft: 0, secondsElapsed: 75 })} />);
    expect(untimed).toContain('1:15');
    expect(untimed).toContain('no time limit');
    expect(status).toMatch(/You <b>3<\/b> · Leader <b>5<\/b>/);
    expect(renderToStaticMarkup(<Lobby view={view({ phase: MatchPhase.Waiting })} actions={actions} />)).toMatch(/<button[^>]*>Ready<\/button>/);
    expect(renderToStaticMarkup(<Lobby view={view({ phase: MatchPhase.Waiting, ready: true })} actions={actions} />)).toContain('disabled');
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
