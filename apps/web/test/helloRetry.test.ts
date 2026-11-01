/**
 * A late HELLO (UX-20): the game server's door lets a socket go when its HELLO hasn't come within
 * 5 s (rooms.ts HELLO_TIMEOUT_MS, close 1008). The page sends HELLO the moment the socket opens, so
 * a late one means the page was busy loading, not a bad network: the join is retried quietly (a
 * fresh ticket each time), and only after HELLO_RETRIES does the player see a card, one that blames
 * neither their Wi-Fi nor shows a code.
 */
import { createConditionerSettings } from '@military-forge/netcode';
import { MsgType, decodeMessage, type HelloMsg } from '@military-forge/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELLO_RETRIES, OnlineMode } from '../src/onlineMode';
import { alertFromConnection } from '../src/shell/alerts';
import type { GameTransport, TransportHandlers } from '../src/transport';

vi.mock('../src/diag/report', () => ({ autoReport: vi.fn(() => false) }));

/** one socket the page opened: what it sent, and the server's end of it */
interface Socket {
  handlers: TransportHandlers;
  sent: Uint8Array[];
  closed: boolean;
}

function page(refreshTicket = vi.fn(async (): Promise<string | null> => `ticket-${++tickets}`)) {
  const sockets: Socket[] = [];
  const connect = (handlers: TransportHandlers): Promise<GameTransport> => {
    const s: Socket = { handlers, sent: [], closed: false };
    sockets.push(s);
    return Promise.resolve({ kind: 'ws', send: (b: Uint8Array) => void s.sent.push(b.slice()), backlog: () => 0, close: () => void (s.closed = true) });
  };
  const fatal = vi.fn();
  const stub = {} as never;
  const mode = new OnlineMode('ws://game.test/ws/KMTXRA', 'Ade', stub, stub, stub, fatal, createConditionerSettings(false), 'auto', { room: 'KMTXRA', ticket: 'ticket-0', refreshTicket, connect });
  const hello = (s: Socket) => s.sent.map((b) => decodeMessage(b)).find((m): m is HelloMsg => m.type === MsgType.Hello);
  return { mode, sockets, fatal, refreshTicket, hello };
}
let tickets = 0;

beforeEach(() => {
  tickets = 0;
  vi.useFakeTimers();
  // the page's timers (onlineMode uses window.*), run on the fake clock
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a HELLO the server got too late (UX-20)', () => {
  it('goes out the moment the socket opens', async () => {
    const { sockets, hello } = page();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent.length).toBeGreaterThan(0);
    expect(decodeMessage(sockets[0]!.sent[0]!).type).toBe(MsgType.Hello); // the first thing sent
    expect(hello(sockets[0]!)?.ticket).toBe('ticket-0');
  });

  it('is retried quietly with a fresh ticket: still joining, no card, no failure', async () => {
    const { mode, sockets, fatal, refreshTicket, hello } = page();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.handlers.onClose(1008, 'no HELLO within 5 s');
    expect(mode.connection.state).toBe('joining');
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshTicket).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(hello(sockets[1]!)?.ticket).toBe('ticket-1');
    expect(mode.connection.state).toBe('joining');
    expect(fatal).not.toHaveBeenCalled();
    mode.dispose();
  });

  it(`gives up only after ${HELLO_RETRIES} quiet retries, with words that blame the device, not the Wi-Fi, and no code`, async () => {
    const { mode, sockets, fatal } = page();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < HELLO_RETRIES; i++) {
      sockets.at(-1)!.handlers.onClose(1008, 'no HELLO within 5 s');
      expect(mode.connection.state).toBe('joining');
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(sockets).toHaveLength(HELLO_RETRIES + 1);
    expect(fatal).not.toHaveBeenCalled();
    sockets.at(-1)!.handlers.onClose(1008, 'no HELLO within 5 s');
    expect(mode.connection.state).toBe('failed');
    expect(fatal).toHaveBeenCalledTimes(1);
    const alert = alertFromConnection(mode.connection, 'KMTXRA');
    expect(alert).toMatchObject({ title: 'Took too long to load', message: 'Your device took too long to load the room. Try again.', code: '', action: 'rejoin' });
    expect(`${alert.title} ${alert.message}`).not.toMatch(/wi-?fi|your data|connection|HELLO_TIMEOUT/i);
    mode.dispose();
  });

  it('a room that closed meanwhile says so (the fresh ticket is refused), not "too slow"', async () => {
    const { mode, sockets } = page(vi.fn(async () => null));
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.handlers.onClose(1008, 'no HELLO within 5 s');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mode.connection.state).toBe('failed');
    expect(alertFromConnection(mode.connection, 'KMTXRA').title).toBe('Room not found');
    mode.dispose();
  });
});
