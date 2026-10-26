/** matchStats.ts: each match's play stats (people and bots), and the reporter's signed post (docs/16 §3.2). */
import { generateKeyPairSync } from 'node:crypto';
import { warmNavGraphs } from '@military-forge/bots';
import { DEFAULT_GUN_IDS, maps, weapons } from '@military-forge/content';
import { CmdKind, encodeCmd, encodeHello } from '@military-forge/protocol';
import type { MatchStatsReport } from '@military-forge/shared';
import { DamageSource, MatchPhase, ticks, type Match, type PlayerState } from '@military-forge/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import { MatchStats, ResultsReporter } from '../src/results';
import { Room, type ClientConn } from '../src/room';

beforeAll(() => warmNavGraphs([maps['movement-test']!]), 30_000);

const conn = (): ClientConn => ({ send() {}, close() {}, bufferedAmount: () => 0 });
const quick = { countdown: 1, timeLimit: 2, killLimit: 0, ending: 1, postgame: 2, onNoRematch: 'lobby' as const };

function sinkOf() {
  const reports: MatchStatsReport[] = [];
  return { reports, reportStats: (r: MatchStatsReport) => void reports.push(r) };
}

describe('MatchStats in a room', () => {
  it('reports every player, bots included, with their guns and ids, once per match', () => {
    const sink = sinkOf();
    const room = new Room({ dummies: false, dev: false, match: quick, stats: sink, code: 'AAAAAA', fillBots: { target: 3, level: 'easy' } });
    const ade = room.connect(conn());
    ade.accountId = 'u_ade';
    ade.guns = [2, 1];
    room.receive(ade, encodeHello('Ade'));
    const kemi = room.connect(conn());
    room.receive(kemi, encodeHello('Kemi'));
    for (const c of [ade, kemi]) room.receive(c, encodeCmd(CmdKind.Ready, '1'));
    for (let i = 0; i < ticks(1) + ticks(2) + 30; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.Ending);
    expect(sink.reports).toHaveLength(1);
    const r = sink.reports[0]!;
    expect(r).toMatchObject({ v: 1, mode: 'ffa', map: 'movement-test', room: 'code', durationS: 2, humans: 2, bots: 1, reason: 'time_limit' });
    const people = r.players.filter((p) => !p.bot);
    expect(people.map((p) => p.uid).sort()).toEqual([null, 'u_ade'].sort());
    expect(people.find((p) => p.uid === 'u_ade')!.guns).toEqual([weapons[2]!.id, weapons[1]!.id]);
    expect(people.find((p) => p.uid === null)!.guns).toEqual([...DEFAULT_GUN_IDS]);
    const bot = r.players.find((p) => p.bot)!;
    expect(bot).toMatchObject({ uid: null, guns: null, transport: 'bot', ping: 'unknown' });
    for (const p of r.players) {
      expect(p.playedS).toBe(2);
      expect(p.left).toBe(false);
    }
    for (let i = 0; i < 60; i++) room.tick();
    expect(sink.reports).toHaveLength(1);
  });
});

describe('MatchStats', () => {
  it('times lives, credits kills and deaths, and calls a quit soon after dying a rage quit', () => {
    const sink = sinkOf();
    const stats = new MatchStats(sink, 'code', () => 1_000_000);
    const a = { isBot: false } as PlayerState;
    const b = { isBot: false } as PlayerState;
    const bot = { isBot: true } as PlayerState;
    stats.joined(a, 'u_a', [2, 1], 0);
    stats.joined(b, 'u_b', null, 0);
    const players = [
      { key: 1, state: a, isBot: false },
      { key: 2, state: b, isBot: false },
      { key: 3, state: bot, isBot: true },
    ];
    const match = { players, departed: [] as unknown[], events: [] as unknown[], results: null as unknown, teams: 0 } as unknown as Match & { events: unknown[] };
    const run = (tick: number, ...events: unknown[]) => {
      match.events.length = 0;
      match.events.push(...events);
      stats.onMatchEvents(match, 'fog-stair', tick, 3, () => ({ pingMs: 140, transport: 'wt' }));
    };
    run(100, { type: 'phase', phase: MatchPhase.InProgress, prev: MatchPhase.Countdown });
    // a kills b with a K-47 at 10 s; the bot kills b at 30 s (b respawned at 13 s)
    run(100 + 600, { type: 'kill', killer: 0, victim: 1, source: 2, assists: [], streak: 1 });
    run(100 + 1800, { type: 'kill', killer: 2, victim: 1, source: DamageSource.Grenade, assists: [], streak: 1 });
    // b leaves 5 s later: a rage quit
    stats.reconnected(b);
    stats.left(b, MatchPhase.InProgress, 100 + 2100, { pingMs: 230, transport: 'ws' });
    stats.reconnected(a);
    (match as { departed: unknown[] }).departed.push(players[1]);
    (match as { results: unknown }).results = {
      number: 1,
      reason: 2,
      durationTicks: 3600,
      winnerKey: 1,
      mvpKey: 1,
      standings: [
        { key: 1, placement: 1, isBot: false, left: false, kills: 1, deaths: 0, assists: 0, damageDealt: 100.4, damageTaken: 0, headshots: 0, bestStreak: 1 },
        { key: 3, placement: 2, isBot: true, left: false, kills: 1, deaths: 0, assists: 0, damageDealt: 50, damageTaken: 0, headshots: 0, bestStreak: 1 },
        { key: 2, placement: 3, isBot: false, left: true, kills: 0, deaths: 2, assists: 0, damageDealt: 0, damageTaken: 200, headshots: 0, bestStreak: 0 },
      ],
    };
    run(100 + 3600, { type: 'phase', phase: MatchPhase.Ending, prev: MatchPhase.InProgress });
    const r = sink.reports[0]!;
    expect(r).toMatchObject({ map: 'fog-stair', mode: 'ffa', durationS: 60, humans: 2, bots: 1, reason: 'time_limit' });
    const [pa, pbot, pb] = r.players;
    expect(pa).toMatchObject({ uid: 'u_a', won: true, killsBy: { k47: 1 }, playedS: 60, lifeS: 60, ping: '120-200', transport: 'wt', reconnects: 1, damage: 100, rage: false, leftAtS: null });
    expect(pbot).toMatchObject({ bot: true, killsBy: { grenade: 1 }, uid: null });
    // b: lives of 10 s and 17 s, then 2 s alive before leaving at 35 s
    expect(pb).toMatchObject({ uid: 'u_b', won: false, deathsBy: { k47: 1, grenade: 1 }, botDeaths: 1, left: true, leftAtS: 35, leftPhase: 'playing', rage: true, ping: '200+', transport: 'ws', reconnects: 1, playedS: 35 });
    expect(pb!.lifeS).toBeCloseTo((10 + 17 + 2) / 3, 1);
    expect(pa!.botKills).toBe(0);
  });

  it('marks the winning team in a team match', () => {
    const sink = sinkOf();
    const stats = new MatchStats(sink, 'default');
    const s = [0, 1].map(() => ({ isBot: false }) as PlayerState);
    const match = { players: s.map((state, i) => ({ key: i, state, isBot: false })), departed: [], events: [] as unknown[], results: null as unknown, teams: 2 } as unknown as Match & { events: unknown[] };
    match.events.push({ type: 'phase', phase: MatchPhase.InProgress, prev: MatchPhase.Countdown });
    stats.onMatchEvents(match, 'm', 0, 3, () => null);
    match.events.length = 0;
    (match as { results: unknown }).results = { reason: 0, durationTicks: 60, winnerTeam: 1, standings: s.map((_, i) => ({ key: i, placement: i + 1, isBot: false, left: false, team: i, kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0, headshots: 0, bestStreak: 0 })) };
    match.events.push({ type: 'phase', phase: MatchPhase.Ending, prev: MatchPhase.InProgress });
    stats.onMatchEvents(match, 'm', 60, 3, () => null);
    expect(sink.reports[0]!.mode).toBe('team2');
    expect(sink.reports[0]!.players.map((p) => p.won)).toEqual([false, true]);
  });
});

describe('ResultsReporter.reportStats', () => {
  it('posts the stats signed to /internal/analytics/match, and skips a match with no people', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const calls: { url: string; auth: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization! });
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;
    const reporter = new ResultsReporter('http://api', privateKey, () => {}, fake, []);
    const base: Omit<MatchStatsReport, 'humans'> = { v: 1, matchId: '7d6c5d2e-1a4e-4c55-9f0e-2a7f6c1b9e10', mode: 'ffa', map: 'm', room: 'code', startedAt: '', endedAt: '', durationS: 1, reason: 'other', bots: 0, players: [] };
    reporter.reportStats({ ...base, humans: 0 });
    reporter.reportStats({ ...base, humans: 1 });
    await reporter.settle();
    expect(calls.map((c) => c.url)).toEqual(['http://api/internal/analytics/match']);
    expect(calls[0]!.auth).toMatch(/^GameServer [\w-]+\.[\w-]+\.[\w-]+$/);
  });
});
