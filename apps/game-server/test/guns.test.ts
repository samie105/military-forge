/** A player's saved gun pair, carried in the join ticket: their first spawn, every match start; bots keep their own. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { warmNavGraphs } from '@military-forge/bots';
import { DEFAULT_LOADOUT, maps, weapons } from '@military-forge/content';
import { CmdKind, encodeCmd, encodeHello } from '@military-forge/protocol';
import { MatchPhase, ticks } from '@military-forge/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClientConn } from '../src/room';
import { RoomRegistry } from '../src/rooms';
import { TICKET_AUDIENCE, TICKET_ISSUER, TicketVerifier } from '../src/tickets';

// rooms build their bots' nav graphs between ticks (the server's tick loop), so a bot can wait for
// one: these are built up front, as the server does at startup
beforeAll(() => warmNavGraphs([maps['movement-test']!]), 30_000);

const keys = generateKeyPairSync('ed25519');
const nowS = 1_760_000_000;
const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
let jti = 0;
const ticket = (over: Record<string, unknown>) => {
  const claims = { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, sub: `u_${jti}`, iat: nowS, exp: nowS + 30, nick: `P${jti}`, room: 'AAAAAA', jti: `t${++jti}`, ...over };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;
};
const conn = (): ClientConn => ({ send() {}, close() {}, bufferedAmount: () => 0 });
const idx = (id: string) => weapons.find((w) => w.id === id)!.index;

describe('saved gun pairs', () => {
  it('a player spawns with the pair from their ticket, keeps it into the match, and a death still keeps what they held (#125); bots and bad pairs get the default', () => {
    const rooms = new RoomRegistry({
      defaultRoom: null,
      tickets: new TicketVerifier(keys.publicKey, () => nowS),
      roomOptions: { match: { countdown: 1, timeLimit: 30, killLimit: 0, ending: 1, postgame: 2, onNoRematch: 'lobby', minPlayers: 1 }, fillBots: { target: 4, level: 'easy' } },
    });
    const enter = (guns?: unknown) => {
      const door = rooms.open('/ws/AAAAAA', conn(), null)!;
      door.receive(encodeHello('x', '', ticket(guns === undefined ? {} : { guns })));
      return door;
    };
    const doors = [enter(['widow', 'k47']), enter() /* nothing saved */, enter(['widow', 'machete']) /* melee isn't a choice */, enter(['nope', 42])];
    const room = rooms.rooms.get('AAAAAA')!;
    const people = room.game.players.filter((p) => p && !p.isBot);
    const held = (p: (typeof people)[number]) => p!.weapons.map((w) => w.def);
    expect(people.map(held)).toEqual([[idx('widow'), idx('k47')], [...DEFAULT_LOADOUT], [...DEFAULT_LOADOUT], [...DEFAULT_LOADOUT]]);
    const me = people[0]!;

    // the match starts: everyone respawns on their own loadout
    for (const d of doors) d.receive(encodeCmd(CmdKind.Ready, '1'));
    for (let i = 0; i < ticks(3) && room.match!.phase !== MatchPhase.InProgress; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    expect(held(me)).toEqual([idx('widow'), idx('k47')]);

    // dies holding something else: the next spawn keeps that (respawns keep your guns)
    me.weapons[1]!.def = idx('buzz');
    room.game.damage(me, 10_000, me.id, 0, 0);
    for (let i = 0; i < ticks(6) && !me.alive; i++) room.tick();
    expect(me.alive).toBe(true);
    expect(held(me)).toEqual([idx('widow'), idx('buzz')]);
  });

  it('bots keep their own loadouts', () => {
    const rooms = new RoomRegistry({ defaultRoom: null, tickets: new TicketVerifier(keys.publicKey, () => nowS), roomOptions: { fillBots: { target: 3, level: 'easy' } } });
    const door = rooms.open('/ws/AAAAAA', conn(), null)!;
    door.receive(encodeHello('x', '', ticket({ guns: ['widow', 'k47'] })));
    const room = rooms.rooms.get('AAAAAA')!;
    room.tick();
    expect(room.bots.length).toBeGreaterThan(0);
    for (const b of room.bots) expect(b.weapons.map((w) => w.def)).not.toEqual([idx('widow'), idx('k47')]);
  });
});
