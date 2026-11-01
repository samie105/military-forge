/** roomState.ts: each room's listing (people and bots apart) and the signed heartbeat to the API. */
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { warmNavGraphs } from '@military-forge/bots';
import { maps } from '@military-forge/content';
import { CmdKind, encodeCmd, encodeHello } from '@military-forge/protocol';
import type { RoomStateReport } from '@military-forge/shared';
import { MatchPhase, ticks } from '@military-forge/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import { RESULTS_AUDIENCE, RESULTS_ISSUER } from '../src/results';
import { Room, type ClientConn } from '../src/room';
import { ROOMS_PER_BEAT, ROOM_STATE_SUBJECT, RoomStateReporter, roomStates } from '../src/roomState';

beforeAll(() => warmNavGraphs([maps['movement-test']!]), 30_000);

const conn = (): ClientConn => ({ send() {}, close() {}, bufferedAmount: () => 0 });
const rules = { countdown: 1, timeLimit: 120, killLimit: 0, ending: 1, postgame: 2, onNoRematch: 'lobby' as const };

function roomWith(people: readonly [string, string | null][], bots = 4): Room {
  const room = new Room({ dummies: false, dev: false, match: rules, code: 'KMTXRA', fillBots: { target: bots, level: 'easy' } });
  for (const [name, account] of people) {
    const c = room.connect(conn());
    c.accountId = account;
    room.receive(c, encodeHello(name));
  }
  for (let i = 0; i < 10; i++) room.tick();
  return room;
}

describe("a room's listing", () => {
  it('counts people and bots apart, with the free slots, the host and the accounts inside', () => {
    const room = roomWith([
      ['Ade', 'u_ade'],
      ['Guest', null],
    ]);
    const l = room.listing()!;
    expect(l).toMatchObject({ phase: 'lobby', teams: 0, map: 'movement-test', people: 2, seats: 6, timeLeftS: null, hostId: 'u_ade', ids: ['u_ade'] });
    expect(l.bots).toBe(room.bots.length);
    expect(l.people + l.bots).toBeLessThanOrEqual(8);
  });

  it('says the phase and, in a match, the time left', () => {
    const room = roomWith([['Ade', 'u_ade']]);
    const c = [...room.clients][0]!;
    room.receive(c, encodeCmd(CmdKind.Ready, '1'));
    for (let i = 0; i < ticks(1) + 5; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    const l = room.listing()!;
    expect(l.phase).toBe('playing');
    expect(l.timeLeftS).toBeGreaterThan(110);
    expect(l.timeLeftS).toBeLessThanOrEqual(120);
  });

  it('leaves out the dev room and rooms nobody plays in', () => {
    const empty = new Room({ dummies: false, dev: false, match: rules, code: 'EMPTYR' });
    const busy = roomWith([['Ade', 'u_ade']]);
    expect(roomStates([['', busy], ['EMPTYR', empty], ['KMTXRA', busy]]).map((r) => r.code)).toEqual(['KMTXRA']);
  });
});

describe('the heartbeat', () => {
  const keys = generateKeyPairSync('ed25519');

  it("is signed as the match results are: the game server's key, its own subject, this body's hash", async () => {
    const room = roomWith([['Ade', 'u_ade']]);
    const sent: { url: string; auth: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, auth: (init.headers as Record<string, string>).authorization!, body: init.body as string });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const reporter = new RoomStateReporter('http://api', keys.privateKey, () => [['KMTXRA', room]], () => {}, fetchImpl, () => 1_793_500_000_000);
    await reporter.beat();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://api/internal/rooms/state');
    const report = JSON.parse(sent[0]!.body) as RoomStateReport;
    expect(report.at).toBe(1_793_500_000_000);
    expect(report.rooms).toMatchObject([{ code: 'KMTXRA', people: 1, hostId: 'u_ade' }]);
    const token = sent[0]!.auth.replace(/^GameServer /, '');
    const [h, p, sig] = token.split('.') as [string, string, string];
    expect(verify(null, Buffer.from(`${h}.${p}`), keys.publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, sub: ROOM_STATE_SUBJECT, bodySha256: createHash('sha256').update(sent[0]!.body).digest('base64url') });
  });

  it('sends rooms in batches under the body limit, an empty list when there are none, and says a failure once', async () => {
    const room = roomWith([['Ade', 'u_ade']]);
    const many: [string, Room][] = Array.from({ length: ROOMS_PER_BEAT + 3 }, (_, i) => [`KMTX${String.fromCharCode(65 + Math.floor(i / 20))}${String.fromCharCode(65 + (i % 20))}`, room]);
    const reporter = new RoomStateReporter('http://api', keys.privateKey, () => many);
    const bodies = reporter.bodies();
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b.length).toBeLessThan(16 * 1024);
    const none = new RoomStateReporter('http://api', keys.privateKey, () => []).bodies();
    expect(none).toHaveLength(1);
    expect((JSON.parse(none[0]!) as RoomStateReport).rooms).toEqual([]);
    const lines: string[] = [];
    const down = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    const failing = new RoomStateReporter('http://api', keys.privateKey, () => [['KMTXRA', room]], (l) => lines.push(l), down);
    await failing.beat();
    await failing.beat();
    expect(lines).toHaveLength(1);
  });
});
