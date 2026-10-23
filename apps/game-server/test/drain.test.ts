/**
 * Deploys don't drop live matches (23 Oct 2026: the box restarted mf-game about 12 times in a day).
 * Draining (SIGUSR2, scripts/net-trial/restart.sh) refuses new rooms with 1012 and lets running
 * rooms play on; `matchRunning` says when it's safe to stop; stopping tells everyone the server
 * updated (1012), which the page answers by rejoining with a fresh ticket.
 */
import { CloseCode, CmdKind, encodeCmd, encodeHello } from '@military-forge/protocol';
import { MatchPhase } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import type { ClientConn } from '../src/room';
import { RoomRegistry } from '../src/rooms';

function conn() {
  const c = { closed: null as { code: number; reason: string } | null, send() {}, bufferedAmount: () => 0, close(code: number, reason: string) { c.closed = { code, reason }; } };
  return c as ClientConn & { closed: { code: number; reason: string } | null };
}

function join(rooms: RoomRegistry, code: string, name: string) {
  const c = conn();
  const link = rooms.open(`/ws/${code}`, c)!;
  link?.receive(encodeHello(name, ''));
  return { c, link };
}

describe('draining for an update', () => {
  it('new rooms are refused with 1012; a running room plays on and takes joiners; it stops once no match runs', () => {
    const rooms = new RoomRegistry({ defaultRoom: null, roomOptions: { match: { countdown: 1, timeLimit: 2, killLimit: 99, minPlayers: 1 } } });
    const ade = join(rooms, 'ABCDEF', 'Ade');
    expect(rooms.rooms.has('ABCDEF')).toBe(true);
    expect(rooms.matchRunning).toBe(false); // a lobby
    ade.link.receive(encodeCmd(CmdKind.StartMatch, ''));
    for (let i = 0; i < 10; i++) rooms.tick();
    const room = rooms.rooms.get('ABCDEF')!;
    expect(room.match!.phase).not.toBe(MatchPhase.Waiting);
    expect(rooms.matchRunning).toBe(true);

    rooms.draining = true;
    const late = join(rooms, 'BCDFGH', 'Kemi');
    expect(late.c.closed?.code).toBe(CloseCode.ServerUpdating);
    expect(rooms.rooms.has('BCDFGH')).toBe(false);
    const friend = join(rooms, 'ABCDEF', 'Tunde'); // the running room still takes its friends
    expect(friend.c.closed).toBeNull();
    expect(room.humanCount).toBe(2);

    // the match runs out (countdown, 2 s, the results): then it's safe to stop
    for (let i = 0; i < 60 * 30 && rooms.matchRunning; i++) rooms.tick();
    expect(rooms.matchRunning).toBe(false);
    rooms.closeEveryone(CloseCode.ServerUpdating, 'server updated: rejoin');
    expect(ade.c.closed).toEqual({ code: 1012, reason: 'server updated: rejoin' });
    expect(friend.c.closed?.code).toBe(1012);
    expect(rooms.rooms.size).toBe(0);
  });
});
