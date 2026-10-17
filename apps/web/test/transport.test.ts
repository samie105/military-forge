/**
 * Transport selection (docs/05 §2.1) with the browser APIs stubbed: what a failed WebTransport
 * attempt leaves behind decides whether the next connect even tries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectGame, healthUrl } from '../src/transport';

class FakeWebTransport {
  static mode: 'ok' | 'refuse' | 'hang' = 'ok';
  static created = 0;
  readonly ready: Promise<void>;
  readonly closed = new Promise<never>(() => {});
  readonly reliability = 'supports-unreliable';
  readonly datagrams = { readable: new ReadableStream(), writable: new WritableStream(), maxDatagramSize: 1200 };
  constructor() {
    FakeWebTransport.created++;
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

async function connect(reconnect = false) {
  const pending = connectGame('ws://gs.example.com:9001', 'auto', handlers, reconnect);
  await vi.advanceTimersByTimeAsync(2100);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  const store = new Map<string, string>();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('WebTransport', FakeWebTransport);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  vi.stubGlobal('fetch', async () => ({ json: async () => ({ webtransport: { url: 'https://gs.example.com:4433/wt', certHashes: [] } }) }));
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

  it('no handshake within 2 s on a first connect looks like a UDP-blocking network: remembered for an hour', async () => {
    FakeWebTransport.mode = 'hang';
    expect((await connect()).fallbackReason).toMatch(/not ready in 2 s/);
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
});
