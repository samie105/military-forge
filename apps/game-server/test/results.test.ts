/** results.ts: a finished match's report (people with accounts only), signed, sent with retries. */
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { warmNavGraphs } from '@military-forge/bots';
import { maps } from '@military-forge/content';
import { encodeCmd, encodeHello, CmdKind } from '@military-forge/protocol';
import { DamageSource, MatchPhase, ticks, type Match } from '@military-forge/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import { MatchRecorder, RESULTS_AUDIENCE, RESULTS_ISSUER, ResultsReporter, killSourceName, signReport, type MatchReport } from '../src/results';
import { Room, type ClientConn } from '../src/room';
import { RoomRegistry } from '../src/rooms';
import { TICKET_AUDIENCE, TICKET_ISSUER, TicketVerifier } from '../src/tickets';

// rooms build their bots' nav graphs between ticks (the server's tick loop), so a bot can wait for
// one: these are built up front, as the server does at startup
beforeAll(() => warmNavGraphs([maps['movement-test']!, maps['street-market']!]), 30_000);

const conn = (): ClientConn => ({ send() {}, close() {}, bufferedAmount: () => 0 });
const quick = { countdown: 1, timeLimit: 2, killLimit: 0, ending: 1, postgame: 2, onNoRematch: 'lobby' as const };

function sinkOf() {
  const reports: MatchReport[] = [];
  return { reports, report: (r: MatchReport) => void reports.push(r) };
}

describe('MatchRecorder in a room', () => {
  it('reports each finished match once, with only the players who have accounts; bots never', () => {
    const sink = sinkOf();
    const room = new Room({ dummies: false, dev: false, match: quick, results: sink, code: 'AAAAAA', fillBots: { target: 3, level: 'easy' } });
    const players = [
      ['Ade', 'u_ade'],
      ['Kemi', null],
    ] as const;
    const clients = players.map(([name, account]) => {
      const c = room.connect(conn());
      c.accountId = account;
      room.receive(c, encodeHello(name));
      return c;
    });
    for (const c of clients) room.receive(c, encodeCmd(CmdKind.Ready, '1'));
    for (let i = 0; i < ticks(1) + ticks(2) + 30; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.Ending);
    expect(room.bots.length).toBeGreaterThan(0);
    expect(sink.reports).toHaveLength(1);
    const r = sink.reports[0]!;
    expect(r).toMatchObject({ room: 'AAAAAA', mode: 'deathmatch', map: 'movement-test', reason: 'time_limit', durationS: 2, playerCount: 3, botCount: 1 });
    expect(r.players.map((p) => [p.userId, p.nickname, p.left])).toEqual([['u_ade', 'Ade', false]]);
    expect(r.matchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(r.endedAt) - Date.parse(r.startedAt)).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 60; i++) room.tick();
    expect(sink.reports).toHaveLength(1); // the scoreboard ticking on doesn't report again
  });

  it('a player who leaves and rejoins mid-match is one row; places count the players here at the end (audit 28 Oct)', () => {
    const sink = sinkOf();
    const room = new Room({ dummies: false, dev: false, match: { ...quick, timeLimit: 4 }, results: sink, code: 'CCCCCC', fillBots: { target: 4, level: 'easy' } });
    const enter = (name: string, account: string | null) => {
      const c = room.connect(conn());
      c.accountId = account;
      room.receive(c, encodeHello(name));
      return c;
    };
    const ade = enter('Ade', 'u_ade');
    const kemi = enter('Kemi', null);
    for (const c of [ade, kemi]) room.receive(c, encodeCmd(CmdKind.Ready, '1'));
    for (let i = 0; i < ticks(1) + 30; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    const before = room.match!.players.find((m) => m?.name === 'Ade')!;
    before.score = 3; // Ade has scored before the drop
    before.kills = 3;
    // Ade leaves for good (no resume), and comes back on the room link with a new connection
    room.receive(ade, encodeCmd(CmdKind.Leave, ''));
    for (let i = 0; i < 30; i++) room.tick();
    const back = enter('Ade', 'u_ade');
    for (let i = 0; i < ticks(4); i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.Ending);
    const standings = room.match!.results!.standings;
    const ades = standings.filter((s) => s.name === 'Ade');
    expect(ades).toHaveLength(1);
    expect(ades[0]).toMatchObject({ left: false, kills: 3, score: 3, id: back.playerId });
    // no bot that stood aside for a human has a row; the places are those still here, 1 to n
    expect(standings.filter((s) => s.isBot && s.left)).toEqual([]);
    const here = standings.filter((s) => !s.left);
    expect(here.map((s) => s.placement)).toEqual(here.map((_, i) => i + 1));
    expect(here.length).toBeLessThanOrEqual(4);
    expect(ades[0]!.placement).toBe(1);
    expect(kemi.playerId).toBeGreaterThanOrEqual(0);
  });

  it('counts kills by what made them, and keeps a leaver', () => {
    const sink = sinkOf();
    const recorder = new MatchRecorder(sink, 'BBBBBB', () => 1_000_000);
    const state = { id: 0 } as never;
    const gone = { id: 1 } as never;
    recorder.setAccount(state, 'u_1');
    recorder.setAccount(gone, 'u_2');
    const mp = { key: 7, state };
    const left = { key: 8, state: gone };
    const standing = (key: number, placement: number, extra = {}) => ({ key, placement, id: 0, name: `P${key}`, isBot: false, left: false, score: 2, kills: 2, deaths: 0, suicides: 0, assists: 0, damageDealt: 100, damageTaken: 0, headshots: 1, bestStreak: 2, rating: 1, mvp: false, ...extra });
    const match = { players: [mp, null], departed: [left], events: [] as unknown[], results: null as unknown, phase: MatchPhase.InProgress } as unknown as Match & { events: unknown[] };
    match.events.push({ type: 'phase', phase: MatchPhase.InProgress, prev: MatchPhase.Countdown });
    match.events.push({ type: 'kill', killer: 0, victim: 1, source: 2, assists: [], streak: 1 });
    match.events.push({ type: 'kill', killer: 0, victim: 1, source: DamageSource.Grenade, assists: [], streak: 2 });
    match.events.push({ type: 'kill', killer: 0, victim: 0, source: 2, assists: [], streak: 0 }); // a suicide counts for nobody
    recorder.onMatchEvents(match, 'street-market');
    match.events.length = 0;
    (match as { results: unknown }).results = { number: 1, reason: 1, durationTicks: 600, winnerKey: 7, mvpKey: 7, standings: [standing(7, 1), standing(8, 2, { left: true }), standing(9, 3, { isBot: true })] };
    match.events.push({ type: 'phase', phase: MatchPhase.Ending, prev: MatchPhase.InProgress });
    recorder.onMatchEvents(match, 'street-market');
    expect(sink.reports[0]).toMatchObject({ reason: 'kill_limit', durationS: 10, playerCount: 3, botCount: 1, map: 'street-market' });
    expect(sink.reports[0]!.players.map((p) => [p.userId, p.killsBy, p.left])).toEqual([
      ['u_1', { k47: 1, grenade: 1 }, false],
      ['u_2', {}, true],
    ]);
  });

  it('names kill sources', () => {
    expect(killSourceName(0)).toBe('hammer44');
    expect(killSourceName(DamageSource.Melee)).toBe('melee');
    expect(killSourceName(999)).toBe('other');
  });
});

describe('the ticket names the account', () => {
  it("a ticketed player's account goes into the room's report", () => {
    const keys = generateKeyPairSync('ed25519');
    const nowS = 1_760_000_000;
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const claims = { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, sub: 'u_kemi', iat: nowS, exp: nowS + 30, nick: 'Kemi', room: 'AAAAAA', jti: 't1' };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const ticket = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;
    const sink = sinkOf();
    const rooms = new RoomRegistry({ defaultRoom: null, tickets: new TicketVerifier(keys.publicKey, () => nowS), roomOptions: { match: { ...quick, minPlayers: 1 }, results: sink } });
    const door = rooms.open('/ws/AAAAAA', conn(), null)!;
    door.receive(encodeHello('ignored', '', ticket));
    door.receive(encodeCmd(CmdKind.Ready, '1'));
    const room = rooms.rooms.get('AAAAAA')!;
    for (let i = 0; i < ticks(1) + ticks(2) + 30; i++) room.tick();
    expect(sink.reports[0]?.players.map((p) => [p.userId, p.nickname])).toEqual([['u_kemi', 'Kemi']]);
    expect(sink.reports[0]?.room).toBe('AAAAAA');
  });
});

describe('ResultsReporter', () => {
  const keys = generateKeyPairSync('ed25519');
  const report = (players = 1): MatchReport => ({
    matchId: '00000000-0000-4000-8000-000000000001',
    room: 'AAAAAA',
    mode: 'deathmatch',
    map: 'street-market',
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1000).toISOString(),
    durationS: 1,
    reason: 'time_limit',
    playerCount: 2,
    botCount: 1,
    serverBuild: 'p1-0',
    players: Array.from({ length: players }, () => ({ userId: 'u_1', nickname: 'Ade', placement: 1, score: 1, kills: 1, deaths: 0, assists: 0, damageDealt: 10, damageTaken: 0, headshots: 0, bestStreak: 1, left: false, mvp: true, killsBy: { k47: 1 } })),
  });
  const replying = (statuses: (number | 'down')[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const s = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
      if (s === 'down') throw new Error('ECONNREFUSED');
      return new Response('{}', { status: s });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('signs exactly the body it sends, for the API only, for a minute', async () => {
    const { calls, fetchImpl } = replying([201]);
    const r = new ResultsReporter('http://api.test', keys.privateKey, () => {}, fetchImpl, [0]);
    r.report(report());
    await r.settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api.test/internal/matches');
    const token = (calls[0]!.init.headers as Record<string, string>).authorization!.replace(/^GameServer /, '');
    const [h, p, sig] = token.split('.') as [string, string, string];
    expect(verify(null, Buffer.from(`${h}.${p}`), keys.publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, sub: report().matchId, bodySha256: createHash('sha256').update(calls[0]!.init.body as string).digest('base64url') });
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    expect(signReport('x', 'm', keys.privateKey, 5).split('.')[0]).toBe(h);
  });

  it('retries while the API is down or busy, stops on a refusal, sends nothing for a match without people', async () => {
    const flaky = replying(['down', 503, 429, 200]);
    const a = new ResultsReporter('http://api.test', keys.privateKey, () => {}, flaky.fetchImpl, [0, 0, 0, 0]);
    a.report(report());
    await a.settle();
    expect(flaky.calls).toHaveLength(4);

    const refused = replying([400]);
    const logs: string[] = [];
    const b = new ResultsReporter('http://api.test', keys.privateKey, (l) => logs.push(l), refused.fetchImpl, [0, 0]);
    b.report(report());
    await b.settle();
    expect(refused.calls).toHaveLength(1);
    expect(logs.join()).toMatch(/refused/);

    const down = replying(['down']);
    const c = new ResultsReporter('http://api.test', keys.privateKey, (l) => logs.push(l), down.fetchImpl, [0, 0]);
    c.report(report());
    c.report(report(0));
    await c.settle();
    expect(down.calls).toHaveLength(3); // one report: first try + two retries; the empty one never went
    expect(logs.join()).toMatch(/gave up/);
  });
});
