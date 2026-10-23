/**
 * The room's connection log (owner, 23 Oct 2026: phones "keep returning", and the box's log had no
 * word on who connected, how, or why they dropped): joins and resumes with their transport and time
 * away, drops with their close code and how long the connection lasted, and places given up.
 */
import { MsgType, decodeMessage, encodeHello, type WelcomeMsg } from '@military-forge/protocol';
import { describe, expect, it } from 'vitest';
import { Room, type ClientConn } from '../src/room';

function conn(kind: 'ws' | 'wt'): ClientConn & { welcome(): WelcomeMsg } {
  const sent: Uint8Array[] = [];
  return {
    kind,
    send: (b) => sent.push(b),
    close: () => {},
    bufferedAmount: () => 0,
    welcome: () => decodeMessage(sent.find((b) => b[0] === MsgType.Welcome)!) as WelcomeMsg,
  };
}

describe('the connection log', () => {
  it('a join, a drop with its code, a resume over the other transport, and a place given up', () => {
    const lines: string[] = [];
    const room = new Room({ dummies: false, dev: false, code: 'ABCDEF', reconnectGraceMs: 1000, log: (l) => lines.push(l) });
    const first = conn('wt');
    const c1 = room.connect(first);
    room.receive(c1, encodeHello('Ade', ''));
    for (let i = 0; i < 120; i++) room.tick();
    room.disconnect(c1, true, '1006');
    for (let i = 0; i < 30; i++) room.tick();
    const second = conn('ws');
    const c2 = room.connect(second);
    room.receive(c2, encodeHello('Ade', first.welcome().sessionToken));
    expect(second.welcome().resumed).toBe(true);
    room.disconnect(c2, true, '1001 going away');
    for (let i = 0; i < 70; i++) room.tick();
    expect(lines.filter((l) => l.startsWith('[room ABCDEF]'))).toEqual([
      '[room ABCDEF] Ade joined over wt',
      "[room ABCDEF] Ade's wt connection closed (1006) after 2 s; its place is kept 1 s",
      '[room ABCDEF] Ade resumed over ws after 0.5 s away',
      "[room ABCDEF] Ade's ws connection closed (1001 going away) after 0 s; its place is kept 1 s",
      "[room ABCDEF] Ade didn't come back in time; its place is given up",
    ]);
  });
});
