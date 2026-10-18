import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/backoff';
import { encodePing, percentiles, pongTime, socketUrlFor } from '../src/ping';

describe('restart backoff', () => {
  it('doubles up to 30 s for runs that die fast, and starts over after a healthy minute', () => {
    const b = new Backoff();
    const delays: number[] = [];
    let t = 0;
    for (let i = 0; i < 7; i++) {
      b.started(t);
      t += 2000; // each run dies after 2 s
      delays.push(b.next(t));
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    b.started(t);
    expect(b.next(t + 61_000)).toBe(1000);
  });
});

describe('ping tool', () => {
  it('finds the room socket from a playtest link and speaks PING/PONG', () => {
    expect(socketUrlFor('https://abc-def.trycloudflare.com/r/KQXMZP')).toBe('wss://abc-def.trycloudflare.com/ws/KQXMZP');
    expect(socketUrlFor('http://127.0.0.1:5191/r/kqxmzp')).toBe('ws://127.0.0.1:5191/ws/KQXMZP');
    expect(socketUrlFor('wss://x.example/ws/ABCDEF')).toBe('wss://x.example/ws/ABCDEF');
    const ping = encodePing(1234.5);
    expect(ping[0]).toBe(0x03);
    const pong = new Uint8Array(13);
    pong.set(ping);
    pong[0] = 0x04;
    expect(pongTime(pong)).toBe(1234.5);
    expect(pongTime(ping)).toBeNull();
    expect(percentiles([5, 1, 3, 2, 4])).toEqual({ min: 1, median: 3, p90: 5, max: 5, n: 5 });
  });
});
