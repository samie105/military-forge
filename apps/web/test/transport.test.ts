/**
 * Transport selection (docs/05 §2.1) with the browser APIs stubbed: what a failed WebTransport
 * attempt leaves behind decides whether the next connect even tries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CONNECT_TIMEOUT_MS, connectGame, healthUrl, openWebSocket, roomOfUrl, webTransportUrl } from '../src/transport';

class FakeWebTransport {
  static mode: 'ok' | 'refuse' | 'hang' = 'ok';
  static created = 0;
  static lastUrl = '';
  readonly ready: Promise<void>;
  readonly closed = new Promise<never>(() => {});
  readonly reliability = 'supports-unreliable';
  readonly datagrams = { readable: new ReadableStream(), writable: new WritableStream(), maxDatagramSize: 1200 };
  constructor(url: string) {
    FakeWebTransport.created++;
    FakeWebTransport.lastUrl = url;
    const mode = FakeWebTransport.mode;
    this.ready = mode === 'ok' ? Promise.resolve() : mode === 'refuse' ? Promise.reject(new Error('503')) : new Promise(() => {});
    this.ready.catch(() => {});
  }
  createBidirectionalStream() {
    return Promise.resolve({ readable: new ReadableStream(), writable: new WritableStream() });
  }
  close() {}
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 1;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {}
}

const handlers = { onMessage: () => {}, onClose: () => {} };
let serverRoutesRooms = false;

async function connect(reconnect = false, wsUrl = 'ws://gs.example.com:9001') {
  const pending = connectGame(wsUrl, 'auto', handlers, reconnect);
  await vi.advanceTimersByTimeAsync(4100);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  const store = new Map<string, string>();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('WebTransport', FakeWebTransport);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  vi.stubGlobal('fetch', async () => ({ json: async () => ({ webtransport: { url: 'https://gs.example.com:4433/wt', certHashes: [], rooms: serverRoutesRooms } }) }));
  FakeWebTransport.created = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('transport selection', () => {
  it('/health sits at the WebSocket URL\'s host and port, whatever its path or query', () => {
    expect(healthUrl('ws://localhost:9001')).toBe('http://localhost:9001/health');
    expect(healthUrl('wss://fra-gs-01.gs.example.com/ws/3?ticket=abc#x')).toBe('https://fra-gs-01.gs.example.com/health');
  });

  it('a refused WebTransport costs one attempt: the next connect tries again', async () => {
    FakeWebTransport.mode = 'refuse';
    const first = await connect();
    expect(first.transport.kind).toBe('ws');
    expect(first.fallbackReason).toMatch(/refused/);
    await connect();
    expect(FakeWebTransport.created).toBe(2);
  });

  it('no handshake within 4 s on a first connect looks like a UDP-blocking network: remembered for an hour', async () => {
    FakeWebTransport.mode = 'hang';
    expect((await connect()).fallbackReason).toMatch(/not ready in 4 s/);
    const next = await connect();
    expect(next.fallbackReason).toMatch(/blocked WebTransport recently/);
    expect(FakeWebTransport.created).toBe(1);
    vi.setSystemTime(Date.now() + 3601_000);
    FakeWebTransport.mode = 'ok';
    expect((await connect()).transport.kind).toBe('wt');
  });

  it('the same timeout while reconnecting (a gateway that just hung) isn\'t held against the network', async () => {
    FakeWebTransport.mode = 'hang';
    expect((await connect(true)).transport.kind).toBe('ws');
    await connect();
    expect(FakeWebTransport.created).toBe(2);
  });

  it('a room by code: its code rides in the WebTransport URL, only on servers that route by it', async () => {
    expect(roomOfUrl('wss://gs.example.com/ws/KQMZPT')).toBe('KQMZPT');
    expect(roomOfUrl('ws://localhost:9001/?room=KQMZPT')).toBe('KQMZPT');
    expect(roomOfUrl('ws://localhost:9001')).toBe('');
    expect(roomOfUrl('wss://gs.example.com/ws')).toBe('');
    expect(webTransportUrl({ url: 'https://n.example.com/wt/2', certHashes: [] }, 'KQMZPT')).toBe('https://n.example.com/wt/2?room=KQMZPT');

    FakeWebTransport.mode = 'ok';
    serverRoutesRooms = false; // a gateway that puts every session in the default room
    const old = await connect(false, 'wss://gs.example.com/ws/KQMZPT');
    expect(old.transport.kind).toBe('ws');
    expect(old.fallbackReason).toMatch(/default room only/);
    expect(FakeWebTransport.created).toBe(0);

    serverRoutesRooms = true;
    const coded = await connect(false, 'wss://gs.example.com/ws/KQMZPT');
    expect(coded.transport.kind).toBe('wt');
    expect(FakeWebTransport.lastUrl).toBe('https://gs.example.com:4433/wt?room=KQMZPT');
    await connect(); // the default room: the plain URL
    expect(FakeWebTransport.lastUrl).toBe('https://gs.example.com:4433/wt');
  });
});

describe('WebSocket connect timeout (the audit, M1)', () => {
  it("a socket that never opens (a dark path) is given up after WS_CONNECT_TIMEOUT_MS", async () => {
    class HangingWebSocket {
      static readonly OPEN = 1;
      static closed = 0;
      readyState = 0;
      binaryType = '';
      onopen: (() => void) | null = null; // never called: it never opens
      onmessage: unknown = null;
      onclose: unknown = null;
      send() {}
      close() {
        HangingWebSocket.closed++;
      }
    }
    vi.stubGlobal('WebSocket', HangingWebSocket);
    let error = '';
    const p = openWebSocket('ws://gs.example.com:9001', handlers).catch((e: Error) => (error = e.message));
    await vi.advanceTimersByTimeAsync(WS_CONNECT_TIMEOUT_MS - 100);
    expect(error).toBe('');
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(error).toMatch(/not open in 6 s/);
    expect(HangingWebSocket.closed).toBe(1);
  });
});
