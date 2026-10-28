import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HitZone, WIDOW, defaultTuning as T, type MapDef } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import {
  ASSIST_WINDOW_TICKS,
  Btn,
  DamageSource,
  Game,
  Match,
  MatchEndReason,
  MatchPhase,
  ReplayRecorder,
  createInput,
  hashGame,
  hashMatch,
  runReplay,
  ticks,
  type Input,
  type MatchResults,
  type MatchRules,
  type PlayerState,
  type ReplayFile,
} from '../src';
import { flatMap } from './helpers';

const RULES: Partial<MatchRules> = { timeLimit: 30, killLimit: 3, countdown: 1, ending: 2, postgame: 3, minPlayers: 2 };

/** Flat arena with three spawns far apart. */
function arena(): MapDef {
  return { ...flatMap(), spawns: [{ x: 5, y: 0 }, { x: 30, y: 0 }, { x: 55, y: 0 }] };
}

/** Damage queued by tests, dealt inside the next Game step (like weapon damage) so its events are scored. */
const pending = new Map<Game, (() => void)[]>();

function newGame(): Game {
  const game = new Game({ map: arena(), seed: 7 });
  const step = game.step.bind(game);
  const queue: (() => void)[] = [];
  pending.set(game, queue);
  game.step = (inputs) => {
    step(inputs);
    for (const fn of queue.splice(0)) fn();
  };
  return game;
}

function setup(humans = 2, rules: Partial<MatchRules> = RULES) {
  const game = newGame();
  const players = Array.from({ length: humans }, (_, i) => game.addPlayer(`H${i + 1}`));
  const match = new Match(game, rules);
  return { game, match, players };
}

/** Steps the match n ticks; `buttons` held by every human. */
function run(match: Match, n: number, buttons = 0): void {
  const inputs: (Input | undefined)[] = [];
  for (const p of match.game.players) {
    if (!p || p.isBot) continue;
    const input = createInput();
    input.buttons = buttons;
    inputs[p.id] = input;
  }
  for (let i = 0; i < n; i++) match.step(inputs);
}

/** Ready everyone and run through the countdown into IN_PROGRESS. */
function startMatch(match: Match): void {
  for (const m of match.players) if (m && !m.isBot) match.setReady(m.id);
  run(match, 1);
  expect(match.phase).toBe(MatchPhase.Countdown);
  run(match, match.phaseLength());
  expect(match.phase).toBe(MatchPhase.InProgress);
}

function kill(match: Match, victim: PlayerState, killer: PlayerState, source = 0): void {
  pending.get(match.game)!.push(() => match.game.damage(victim, 200, killer.id, source, HitZone.Torso));
}

function hit(match: Match, victim: PlayerState, attacker: PlayerState, damage: number, zone: number = HitZone.Torso): void {
  pending.get(match.game)!.push(() => match.game.damage(victim, damage, attacker.id, 0, zone));
}

describe('match lifecycle', () => {
  it('waits for every human to ready up, then counts down with spawn assignment and fresh stats', () => {
    const { game, match, players } = setup(2);
    const [a, b] = players as [PlayerState, PlayerState];
    expect(match.phase).toBe(MatchPhase.Waiting);

    // warm-up: kills happen in the sim but do not count
    kill(match, b, a);
    match.setReady(a.id);
    run(match, 30);
    expect(match.phase).toBe(MatchPhase.Waiting);
    expect(a.kills).toBe(1);
    expect(match.players[a.id]!.score).toBe(0);

    a.x = b.x = 40;
    game.grenades[0]!.alive = true;
    match.setReady(b.id);
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.Countdown);
    expect(match.number).toBe(0); // counted at GO, so a cancelled countdown is not a match
    expect(match.events).toContainEqual({ type: 'phase', phase: MatchPhase.Countdown, prev: MatchPhase.Waiting });
    // respawned in id order: the first at the first spawn, the next as far from it as possible
    expect([a.x, b.x]).toEqual([5, 55]);
    expect(a.alive && b.alive).toBe(true);
    expect([a.kills, b.deaths]).toEqual([0, 0]);
    expect(game.grenades.some((g) => g.alive)).toBe(false);
    expect(match.ticksLeft).toBe(ticks(1));

    run(match, ticks(1));
    expect(match.phase).toBe(MatchPhase.InProgress);
    expect(match.number).toBe(1);
    expect(match.ticksLeft).toBe(ticks(30));
  });

  it('a new match starts everyone on their loadout, not on guns kept from a warm-up death', () => {
    const { game, match, players } = setup(2);
    const [a] = players as [PlayerState, PlayerState];
    const held = a.weapons.map((w) => w.def);
    a.weapons[0]!.def = WIDOW.index; // a warm-up crate pick
    a.weapons[0]!.mag = 0;
    kill(match, a, a);
    run(match, ticks(T.respawnDelay) + 2);
    expect([a.alive, a.weapons[0]!.def, a.weapons[0]!.mag]).toEqual([true, WIDOW.index, WIDOW.mag]); // kept in the warm-up, full
    startMatch(match);
    expect(game.players[a.id]!.weapons.map((w) => w.def)).toEqual(held);
  });

  it('freezes human inputs outside the warm-up and the match, keeping the aim', () => {
    const { match, players } = setup(2);
    const [a] = players as [PlayerState];
    for (const p of players) match.setReady(p.id);
    run(match, 1);
    const x0 = a.x;
    const input = createInput();
    input.buttons = Btn.Right | Btn.Fire;
    input.aim = 12_000;
    const inputs: Input[] = [];
    inputs[a.id] = input;
    for (let i = 0; i < 30; i++) match.step(inputs);
    expect(match.phase).toBe(MatchPhase.Countdown);
    expect(a.x).toBe(x0);
    expect(a.weapons[0]!.mag).toBe(6);
    expect(a.input.aim).toBe(12_000);

    run(match, ticks(1));
    expect(match.phase).toBe(MatchPhase.InProgress);
    for (let i = 0; i < 30; i++) match.step(inputs);
    expect(a.x).toBeGreaterThan(x0 + 1);
  });

  it('scores +1 per kill and −1 per suicide, and ends on the kill limit', () => {
    const { match, players } = setup(3);
    const [a, b, c] = players as [PlayerState, PlayerState, PlayerState];
    startMatch(match);
    const t0 = match.tick;

    kill(match, b, a);
    run(match, 1);
    expect(match.events).toContainEqual({ type: 'kill', killer: a.id, victim: b.id, source: 0, assists: [], streak: 1 });
    kill(match, c, c, DamageSource.Grenade);
    run(match, 1);
    expect(match.events).toContainEqual({ type: 'kill', killer: c.id, victim: c.id, source: DamageSource.Grenade, assists: [], streak: 0 });
    const mc = match.players[c.id]!;
    expect([mc.score, mc.suicides, mc.deaths]).toEqual([-1, 1, 1]);

    run(match, ticks(T.respawnDelay));
    kill(match, c, a);
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.InProgress);
    kill(match, b, a);
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.Ending);
    const r = match.results!;
    expect(r.reason).toBe(MatchEndReason.KillLimit);
    expect(r.winnerKey).toBe(match.players[a.id]!.key);
    expect(r.standings.map((s) => [s.id, s.placement, s.score, s.kills, s.deaths])).toEqual([
      [a.id, 1, 3, 3, 0],
      [b.id, 2, 0, 0, 2],
      [c.id, 3, -1, 0, 2],
    ]);
    expect(match.players[a.id]!.bestStreak).toBe(3);
    expect(r.durationTicks).toBe(match.tick - t0);
  });

  it('ends on the time limit; ties go to kills, deaths, damage, then whoever reached the score first', () => {
    const { match, players } = setup(3, { ...RULES, timeLimit: 5, killLimit: 0 });
    const [a, b, c] = players as [PlayerState, PlayerState, PlayerState];
    startMatch(match);
    kill(match, c, b);
    run(match, 10);
    kill(match, b, a);
    run(match, 10);
    // a and b: score 1, kills 1, but b died once → a first
    run(match, match.ticksLeft);
    expect(match.phase).toBe(MatchPhase.Ending);
    const r = match.results!;
    expect(r.reason).toBe(MatchEndReason.TimeLimit);
    expect(r.durationTicks).toBe(ticks(5));
    expect(r.standings.map((s) => s.id)).toEqual([a.id, b.id, c.id]);

    // equal on everything but time: whoever reached the score first wins, even with the higher id
    const race = setup(3, { ...RULES, timeLimit: 10, killLimit: 0 });
    const [x, y, z] = race.players as [PlayerState, PlayerState, PlayerState];
    startMatch(race.match);
    kill(race.match, z, y);
    run(race.match, ticks(T.respawnDelay) + 1);
    kill(race.match, z, x);
    run(race.match, race.match.ticksLeft);
    expect(race.match.results!.standings.map((s) => s.id)).toEqual([y.id, x.id, z.id]);

    const tie = setup(2, { ...RULES, timeLimit: 2, killLimit: 0 });
    const [u, v] = tie.players as [PlayerState, PlayerState];
    startMatch(tie.match);
    hit(tie.match, u, v, 10);
    tie.match.step([]);
    hit(tie.match, v, u, 10);
    run(tie.match, tie.match.ticksLeft);
    // all equal → lower id first
    expect(tie.match.results!.standings.map((s) => s.id)).toEqual([u.id, v.id]);
  });

  it('counts damage dealt and taken, headshots, and not self-damage as dealt', () => {
    const { match, players } = setup(2);
    const [a, b] = players as [PlayerState, PlayerState];
    startMatch(match);
    hit(match, b, a, 45, HitZone.Head);
    hit(match, a, a, 30);
    run(match, 1);
    const ma = match.players[a.id]!;
    expect([ma.damageDealt, ma.damageTaken, ma.headshots]).toEqual([45, 30, 1]);
    expect(match.players[b.id]!.damageTaken).toBe(45);
  });

  it('credits assists for ≥ 25 damage in the 10 s before a death', () => {
    const { match, players } = setup(4, { ...RULES, killLimit: 0 });
    const [a, b, c, d] = players as [PlayerState, PlayerState, PlayerState, PlayerState];
    startMatch(match);

    hit(match, d, b, 15);
    run(match, 1);
    hit(match, d, b, 10); // b: 25 in total → assist
    hit(match, d, c, 24); // c: 24 → no assist
    run(match, 30);
    hit(match, d, a, 40);
    kill(match, d, a); // the killer never assists himself
    run(match, 1);
    expect(match.events.find((e) => e.type === 'kill')).toMatchObject({ killer: a.id, victim: d.id, assists: [b.id] });
    expect([a, b, c].map((p) => match.players[p.id]!.assists)).toEqual([0, 1, 0]);

    // damage older than the window does not count
    run(match, ticks(T.respawnDelay));
    hit(match, d, b, 30);
    run(match, ASSIST_WINDOW_TICKS + 1);
    kill(match, d, a);
    run(match, 1);
    expect(match.events.find((e) => e.type === 'kill')).toMatchObject({ assists: [] });
  });

  it('picks the MVP by rating, and nobody when no one earned one', () => {
    const { match, players } = setup(3, { ...RULES, timeLimit: 3, killLimit: 0 });
    const [a, b, c] = players as [PlayerState, PlayerState, PlayerState];
    startMatch(match);
    // ratings: c 100 (kill) + 200 (damage) = 300 · b 90 (damage) · a −50 (death)
    kill(match, a, c);
    run(match, ticks(T.respawnDelay) + 1);
    hit(match, a, b, 90);
    run(match, ticks(3));
    const r = match.results!;
    expect(r.standings[0]!.id).toBe(c.id);
    expect(r.mvpKey).toBe(match.players[c.id]!.key);
    expect(r.standings.filter((s) => s.mvp).map((s) => s.id)).toEqual([c.id]);

    const quiet = setup(2, { ...RULES, timeLimit: 1, killLimit: 0 });
    startMatch(quiet.match);
    run(quiet.match, ticks(1));
    expect(quiet.match.results!.mvpKey).toBe(-1);
    expect(quiet.match.results!.winnerKey).toBe(quiet.match.players[quiet.players[0]!.id]!.key);
  });
});

describe('rematch and lobby', () => {
  function finished(rules: Partial<MatchRules> = RULES) {
    const s = setup(2, { ...rules, timeLimit: 1, killLimit: 0 });
    startMatch(s.match);
    kill(s.match, s.players[1]!, s.players[0]!);
    run(s.match, ticks(1));
    expect(s.match.phase).toBe(MatchPhase.Ending);
    return s;
  }

  it('plays again with the same room and players once every human votes', () => {
    const { match, players } = finished();
    const [a, b] = players as [PlayerState, PlayerState];
    match.voteRematch(a.id);
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.Ending);
    match.voteRematch(b.id);
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.Waiting);
    expect(match.results?.number).toBe(1); // last results stay readable in the lobby
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.Countdown);
    expect(match.results?.number).toBe(1); // ...and through the countdown, until GO
    run(match, match.phaseLength());
    expect(match.phase).toBe(MatchPhase.InProgress);
    expect(match.number).toBe(2);
    expect(match.results).toBeNull();
    expect(match.players[a.id]!.state).toBe(a);
    expect(match.players[a.id]!.kills).toBe(0);
  });

  it('after the vote times out: voters go back to the lobby ready; no votes close the room or return to the lobby', () => {
    const one = finished();
    one.match.voteRematch(one.players[0]!.id);
    run(one.match, ticks(2));
    expect(one.match.phase).toBe(MatchPhase.Postgame);
    run(one.match, ticks(3));
    expect(one.match.phase).toBe(MatchPhase.Waiting);
    expect(one.match.players.filter((m) => m?.ready).map((m) => m!.id)).toEqual([one.players[0]!.id]);
    run(one.match, 10);
    expect(one.match.phase).toBe(MatchPhase.Waiting);

    const none = finished();
    run(none.match, ticks(5));
    expect(none.match.phase).toBe(MatchPhase.Closed);
    none.match.returnToLobby();
    expect(none.match.phase).toBe(MatchPhase.Closed);

    const custom = finished({ ...RULES, onNoRematch: 'lobby' });
    run(custom.match, ticks(5));
    expect(custom.match.phase).toBe(MatchPhase.Waiting);
    expect(custom.match.players.some((m) => m?.ready)).toBe(false);
  });

  it('returnToLobby abandons a running match without results; its phase event is in the next step', () => {
    const { match } = setup(2);
    startMatch(match);
    run(match, 20);
    match.returnToLobby();
    expect(match.phase).toBe(MatchPhase.InProgress);
    run(match, 1);
    // read the way a server or client loop does: step, then events
    expect(match.phase).toBe(MatchPhase.Waiting);
    expect(match.results).toBeNull();
    expect(match.events).toContainEqual({ type: 'phase', phase: MatchPhase.Waiting, prev: MatchPhase.InProgress });
    expect(match.players.some((m) => m?.ready)).toBe(false);
    run(match, 30);
    expect(match.phase).toBe(MatchPhase.Waiting);
  });

  it('a start() refused for too few players is not remembered', () => {
    const { game, match } = setup(1);
    match.start();
    run(match, 600);
    expect(match.phase).toBe(MatchPhase.Waiting);
    game.addPlayer('late');
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.Waiting);
  });

  it('bot-only rooms need start(); minPlayers counts bots', () => {
    const game = newGame();
    for (const x of [10, 20]) game.addDummy({ name: `bot${x}`, x, y: 0, script: { kind: 'idle' } });
    const match = new Match(game, RULES);
    run(match, 10);
    expect(match.phase).toBe(MatchPhase.Waiting);
    match.start();
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.Countdown);

    const solo = setup(1);
    solo.match.setReady(solo.players[0]!.id);
    run(solo.match, 5);
    expect(solo.match.phase).toBe(MatchPhase.Waiting);
    solo.game.addDummy({ name: 'fill', x: 40, y: 0, script: { kind: 'idle' } });
    run(solo.match, 1);
    expect(solo.match.phase).toBe(MatchPhase.Countdown);
  });
});

describe('roster changes', () => {
  it('keeps leavers in the standings (after those still here: a leaver no longer takes 1st, audit 28 Oct), gives joiners a fresh entry, and cancels a countdown below minPlayers', () => {
    const { game, match, players } = setup(3, { ...RULES, timeLimit: 2, killLimit: 0 });
    const [a, b] = players as [PlayerState, PlayerState];
    startMatch(match);
    kill(match, a, b);
    run(match, 1);
    game.removePlayer(b.id);
    const d = game.addPlayer('late'); // reuses b's slot
    expect(d.id).toBe(b.id);
    run(match, 1);
    expect(match.players[d.id]!.state).toBe(d);
    expect(match.players[d.id]!.kills).toBe(0);
    run(match, ticks(2));
    const standings = match.results!.standings;
    const leaver = standings[standings.length - 1]!;
    expect(leaver).toMatchObject({ id: b.id, name: 'H2', left: true, kills: 1, placement: 4 });
    expect(standings.map((s) => s.name).sort()).toEqual(['H1', 'H2', 'H3', 'late']);
    expect(standings.find((s) => s.name === 'late')!.left).toBe(false);
    // the leaver and the joiner share a slot id but not a key; 1st place is someone still here
    const late = standings.find((s) => s.name === 'late')!;
    expect(late.id).toBe(leaver.id);
    expect(late.key).not.toBe(leaver.key);
    expect(standings[0]!.left).toBe(false);
    expect(match.results!.winnerKey).toBe(standings[0]!.key);
    expect(new Set(standings.map((s) => s.key)).size).toBe(standings.length);

    const s = setup(2);
    for (const p of s.players) s.match.setReady(p.id);
    run(s.match, 1);
    expect(s.match.phase).toBe(MatchPhase.Countdown);
    s.game.removePlayer(s.players[1]!.id);
    run(s.match, 1);
    expect(s.match.phase).toBe(MatchPhase.Waiting);
    // the cancelled countdown is not a match: the first match played is still number 1
    s.game.addPlayer('again');
    for (const m of s.match.players) if (m) s.match.setReady(m.id);
    startMatch(s.match);
    expect(s.match.number).toBe(1);
  });
});

describe('leaving and coming back (audit 28 Oct)', () => {
  it('a human back in the match they left is one row, carrying on with their score; a bot that left has no row', () => {
    const { game, match, players } = setup(2, { ...RULES, timeLimit: 2, killLimit: 0 });
    const ids = new Map<PlayerState, string>(players.map((p) => [p, `account:${p.name}`]));
    match.identityOf = (id) => {
      const p = game.players[id];
      return p ? (ids.get(p) ?? null) : null;
    };
    const [a, b] = players as [PlayerState, PlayerState];
    const bot = game.addDummy({ name: 'Bot', x: 40, y: 0, script: { kind: 'idle' } });
    run(match, 1);
    startMatch(match);
    kill(match, b, a);
    run(match, 1);
    game.removePlayer(a.id);
    game.removePlayer(bot.id);
    run(match, 1);
    const again = game.addPlayer('H1');
    ids.set(again, 'account:H1');
    run(match, 1);
    expect(match.players[again.id]!.kills).toBe(1);
    run(match, ticks(2));
    const standings = match.results!.standings;
    expect(standings.filter((s) => s.name === 'H1')).toHaveLength(1);
    expect(standings.map((s) => [s.name, s.left, s.placement])).toEqual([
      ['H1', false, 1],
      ['H2', false, 2],
    ]);
  });

  it('local play (no identities) never merges two players', () => {
    const { game, match, players } = setup(2, { ...RULES, timeLimit: 2, killLimit: 0 });
    startMatch(match);
    game.removePlayer(players[0]!.id);
    run(match, 1);
    game.addPlayer('H1');
    run(match, ticks(2));
    expect(match.results!.standings.filter((s) => s.name === 'H1').map((s) => s.left)).toEqual([false, true]);
  });
});

describe('determinism', () => {
  it('the same inputs and commands give the same match hashes', () => {
    const play = () => {
      const { game, match, players } = setup(3);
      startMatch(match);
      const out: number[] = [];
      for (let i = 0; i < 200; i++) {
        if (i === 50) kill(match, players[1]!, players[0]!);
        if (i === 80) hit(match, players[2]!, players[1]!, 33);
        run(match, 1, i % 30 < 15 ? Btn.Right | Btn.Fire : Btn.Left);
        out.push(hashMatch(match, hashGame(game)));
      }
      return out;
    };
    expect(play()).toEqual(play());
  });

  it('a recorded session with lobby commands replays to the same match state', () => {
    const rules: Partial<MatchRules> = { ...RULES, timeLimit: 2, killLimit: 0, ending: 1, postgame: 1 };
    const game = new Game({ mapId: 'movement-test', seed: 5, dummies: true });
    const me = game.addPlayer('me');
    const match = new Match(game, rules);
    const recorder = new ReplayRecorder({ map: 'movement-test', seed: 5, dummies: true, match: rules });
    const input = createInput();
    const inputs: Input[] = [];
    inputs[me.id] = input;
    match.setReady(me.id);
    recorder.command('ready');
    for (let i = 0; i < 400; i++) {
      input.buttons = i % 50 < 20 ? Btn.Right | Btn.Jet : i % 50 < 30 ? Btn.Fire : Btn.Left;
      if (match.phase === MatchPhase.Ending && match.phaseTick === 5) {
        match.voteRematch(me.id);
        recorder.command('rematch');
      }
      recorder.record(input);
      match.step(inputs);
    }
    expect([match.number, match.phase]).toEqual([2, MatchPhase.Countdown]); // two rematches, the 3rd counting down
    const replay = runReplay(recorder.toFile());
    expect([replay.match!.number, replay.match!.phase]).toEqual([2, MatchPhase.Countdown]);
    expect(replay.hashes[399]).toBe(hashMatch(match, hashGame(game)));
  });
});

describe('match-dm golden replay', () => {
  it('plays out: kill-limit win with a suicide, partial rematch vote, late ready, time-limit win, room closed', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const replay = JSON.parse(readFileSync(join(here, 'replays', 'match-dm.replay.json'), 'utf8')) as ReplayFile;
    const phases: MatchPhase[] = [];
    const results: MatchResults[] = [];
    const { match } = runReplay(replay, (_, m) => {
      for (const e of m!.events) if (e.type === 'phase') phases.push(e.phase);
      if (m!.results && results[results.length - 1] !== m!.results) results.push(m!.results);
    });
    const { Waiting: W, Countdown: C, InProgress: I, Ending: E, Postgame: P, Closed: X } = MatchPhase;
    expect(phases).toEqual([C, I, E, P, W, C, I, E, P, X]);
    expect(match!.number).toBe(2);

    const [first, second] = results as [MatchResults, MatchResults];
    const name = (r: MatchResults, key: number) => r.standings.find((s) => s.key === key)!.name;
    expect(first.reason).toBe(MatchEndReason.KillLimit);
    expect(name(first, first.winnerKey)).toBe('P4');
    expect(name(first, first.mvpKey)).toBe('P4');
    expect(first.standings.find((s) => s.name === 'P2')).toMatchObject({ score: -1, suicides: 1, placement: 8 });
    expect(first.standings.find((s) => s.name === 'Strafer')).toMatchObject({ deaths: 2 });
    expect(second.reason).toBe(MatchEndReason.TimeLimit);
    expect(second.durationTicks).toBe(ticks(15));
    expect(second.standings[0]).toMatchObject({ name: 'P4', score: 1 });
  });
});
