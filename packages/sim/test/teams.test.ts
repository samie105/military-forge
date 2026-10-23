/** Team modes (protocol v21): friendly fire, shots through teammates, team spawns, dealing teams, team scores. */
import { HAMMER, createTuning, defaultTuning as T, type MapDef } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { Btn, DamageSource, Game, Match, MatchEndReason, MatchPhase, allies, defaultKillLimit, hashGame, hashMatch, type Input } from '../src';
import { dummyAt, flatMap, hold, makeGame, placeOnGround } from './helpers';

function aimAt(p: { x: number; y: number }, tx: number, ty: number): number {
  return Math.atan2(ty - (p.y + T.shoulderStand), tx - (p.x + T.shoulderForward));
}

describe('friendly fire', () => {
  it('off (the default): teammates take nothing from each other; enemies and your own grenade still hurt', () => {
    const game = new Game({ map: flatMap() });
    const [a, b, c] = ['A', 'B', 'C'].map((n) => game.addPlayer(n)) as [ReturnType<Game['addPlayer']>, ReturnType<Game['addPlayer']>, ReturnType<Game['addPlayer']>];
    a.team = b.team = 0;
    c.team = 1;
    expect(allies(a, b)).toBe(true);
    expect(allies(a, c)).toBe(false);
    expect(allies(a, a)).toBe(false);
    game.damage(b, 40, a.id, DamageSource.Grenade, 2);
    expect(b.hp).toBe(100);
    game.damage(c, 40, a.id, DamageSource.Grenade, 2);
    expect(c.hp).toBe(60);
    game.damage(a, 40, a.id, DamageSource.Grenade, 2); // your own blast
    expect(a.hp).toBe(60);
    // free-for-all players (team -1) are nobody's teammates
    a.team = b.team = -1;
    game.damage(b, 40, a.id, DamageSource.Grenade, 2);
    expect(b.hp).toBe(60);
  });

  it('on (the admin knob): teammates hurt each other', () => {
    const game = new Game({ map: flatMap(), tuning: { friendlyFire: 1 } });
    const a = game.addPlayer('A');
    const b = game.addPlayer('B');
    a.team = b.team = 0;
    game.damage(b, 25, a.id, DamageSource.Grenade, 2);
    expect(b.hp).toBe(75);
  });

  it('a bullet goes through a teammate and hits the enemy behind; with friendly fire on, the teammate stops it', () => {
    for (const ff of [0, 1]) {
      const { game, p } = makeGame(flatMap());
      game.tuning = createTuning({ friendlyFire: ff });
      placeOnGround(game, p, 5);
      const mate = dummyAt(game, 9);
      const enemy = dummyAt(game, 14);
      p.team = mate.team = 0;
      enemy.team = 1;
      hold(game, p, 0, 5);
      hold(game, p, Btn.Fire, 1, aimAt(p, 14, 0.7));
      if (ff === 0) {
        expect(mate.hp).toBe(100);
        expect(enemy.hp).toBeCloseTo(100 - HAMMER.damage, 3);
      } else {
        expect(mate.hp).toBeLessThan(100);
        expect(enemy.hp).toBe(100);
      }
    }
  });
});

/** Flat arena with spawns along the floor. */
function arena(): MapDef {
  return { ...flatMap([], [], 120), spawns: [10, 30, 50, 70, 90, 110].map((x) => ({ x, y: 0 })) };
}

describe('team spawns', () => {
  it('the spawn farthest from enemies, drawn toward teammates', () => {
    const game = new Game({ map: arena() });
    const [mate, enemy, me] = ['mate', 'enemy', 'me'].map((n) => game.addPlayer(n)) as ReturnType<Game['addPlayer']>[];
    mate!.team = me!.team = 0;
    enemy!.team = 1;
    mate!.x = 95;
    enemy!.x = 10;
    me!.alive = false;
    game.respawn(me!);
    // 110 is farthest from the enemy (100 m) but 90 is next to the teammate: 90 − 0.35·5 > 110 − 0.35·15? 80−1.75 < 100−5.25 → 110
    expect(me!.x).toBe(110);
    mate!.x = 50;
    me!.alive = false;
    game.respawn(me!);
    // 110 (100 − 0.35·60 = 79) vs 70 (60 − 0.35·20 = 53): far from the enemy still wins
    expect(me!.x).toBe(110);
    enemy!.x = 110;
    me!.alive = false;
    game.respawn(me!);
    expect(me!.x).toBe(10); // the far side now, away from the enemy
  });
});

const RULES = { timeLimit: 30, killLimit: 3, countdown: 1, ending: 2, postgame: 3, minPlayers: 2 };

function run(match: Match, n: number): void {
  const inputs: (Input | undefined)[] = [];
  for (let i = 0; i < n; i++) match.step(inputs);
}

describe('dealing teams', () => {
  it('a joiner goes to the smallest team; bots spread evenly; party mates sit together', () => {
    const game = new Game({ map: arena() });
    const match = new Match(game, { ...RULES, teams: 2 });
    const parties = new Map<number, string>();
    match.groupOf = (id) => parties.get(id) ?? null;
    const a = game.addPlayer('A');
    const b = game.addPlayer('B');
    parties.set(a.id, 'p1');
    parties.set(b.id, 'p1');
    run(match, 1);
    expect(a.team).toBe(0);
    expect(b.team).toBe(0); // with A: a party mate's team takes a joiner while it's at most one bigger than the smallest
    const c = game.addPlayer('C');
    const d = game.addPlayer('D');
    d.isBot = true;
    run(match, 1);
    expect(c.team).toBe(1);
    expect(d.team).toBe(1);
  });

  it('mode switch deals everyone, the countdown evens teams out (bots move first), and 3 and 4 teams work', () => {
    const game = new Game({ map: arena() });
    const match = new Match(game, RULES);
    const people = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => game.addPlayer(n));
    people[4]!.isBot = people[5]!.isBot = true;
    run(match, 1);
    expect(people.every((p) => p.team === -1)).toBe(true);
    expect(match.setTeams(3)).toBe(true);
    expect(match.teamSizes()).toEqual([2, 2, 2]);
    expect(match.setTeams(5)).toBe(false);
    expect(match.setTeams(2)).toBe(true);
    expect(match.teamSizes()).toEqual([3, 3]);
    // the host stacks a team
    for (const p of people.slice(0, 5)) match.setTeam(p.id, 0);
    expect(match.teamSizes()).toEqual([5, 1]);
    expect(match.setTeam(people[0]!.id, 2)).toBe(false); // no team 2 in a 2-team match
    match.start();
    run(match, 1);
    expect(match.phase).toBe(MatchPhase.Countdown);
    expect(match.teamSizes()).toEqual([3, 3]);
    expect(people[4]!.team).toBe(1); // the bot moved first
    expect(match.setTeams(0)).toBe(false); // lobby only
  });
});

describe('team scoring', () => {
  it('team kills count; a suicide costs the team; first team to the limit wins; standings carry teams', () => {
    const game = new Game({ map: arena() });
    const match = new Match(game, { ...RULES, killLimit: 3, teams: 2 });
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => game.addPlayer(n)) as ReturnType<Game['addPlayer']>[];
    run(match, 1);
    expect([a!.team, b!.team, c!.team, d!.team].sort()).toEqual([0, 0, 1, 1]);
    match.start();
    run(match, 70);
    expect(match.phase).toBe(MatchPhase.InProgress);
    const enemyOf = (p: typeof a) => [a, b, c, d].find((q) => q!.team !== p!.team)!;
    const mateOf = (p: typeof a) => [a, b, c, d].find((q) => q !== p && q!.team === p!.team)!;
    const killer = a!;
    const killerMate = mateOf(killer);
    // a kill is dealt inside a step: queue it as weapon damage would be
    const kill = (by: typeof a, victim: typeof a) => {
      const step = game.step.bind(game);
      game.step = (inputs) => {
        step(inputs);
        game.damage(victim!, 1000, by!.id, HAMMER.index, 1);
        game.step = step;
      };
      run(match, 1);
      run(match, ticksToRespawn());
    };
    kill(killer, enemyOf(killer));
    kill(killerMate, enemyOf(killer));
    expect(match.teamScores[killer.team]).toBe(2);
    kill(enemyOf(killer), enemyOf(killer)); // a suicide
    expect(match.teamScores[enemyOf(killer)!.team]).toBe(-1);
    expect(match.leadingTeam()).toBe(killer.team);
    kill(killer, enemyOf(killer));
    expect(match.phase).toBeGreaterThanOrEqual(MatchPhase.Ending);
    const r = match.results!;
    expect(r.reason).toBe(MatchEndReason.KillLimit);
    expect(r.winnerTeam).toBe(killer.team);
    expect(r.teamScores?.[killer.team]).toBe(3);
    expect(r.standings.every((s) => s.team === 0 || s.team === 1)).toBe(true);
    expect(defaultKillLimit(2)).toBe(30);
    expect(defaultKillLimit(4)).toBe(20);
  });

  it('a free-for-all hashes as before (no team in the game or match hash)', () => {
    const game = new Game({ map: arena() });
    const match = new Match(game, RULES);
    game.addPlayer('A');
    game.addPlayer('B');
    run(match, 3);
    const before = [hashGame(game), hashMatch(match, hashGame(game))];
    for (const p of game.players) if (p) p.team = 0;
    expect(hashGame(game)).not.toBe(before[0]);
    for (const p of game.players) if (p) p.team = -1;
    expect([hashGame(game), hashMatch(match, hashGame(game))]).toEqual(before);
  });
});

function ticksToRespawn(): number {
  return Math.ceil(T.respawnDelay * 60) + 2;
}
