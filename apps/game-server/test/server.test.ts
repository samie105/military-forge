/**
 * End-to-end pipe over real sockets: two WebSocket clients ↔ uWebSockets.js ↔ Room.
 * Proves docs/12 §5 week 2 item 9 ("prove the pipe").
 */
import { MsgType, decodeMessage, encodeHello, encodeInput, type Message, type SnapshotMsg, type WelcomeMsg } from '@military-forge/protocol';
import { Btn, createInput } from '@military-forge/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { createServer, type RunningServer } from '../src/server';
import { loadUws, type TransportKind } from '../src/transports';

// Run the pipe test on every transport available on this machine.
const transports: TransportKind[] = loadUws() ? ['uws', 'ws'] : ['ws'];

class TestClient {
  readonly ws: WebSocket;
  readonly messages: Message[] = [];
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => this.messages.push(decodeMessage(new Uint8Array(ev.data as ArrayBuffer)));
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('socket error'));
    });
  }

  send(bytes: Uint8Array) {
    this.ws.send(bytes);
  }

  async waitFor<T extends Message['type']>(type: T, pred: (m: Extract<Message, { type: T }>) => boolean = () => true, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.filter((m): m is Extract<Message, { type: T }> => m.type === type).find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for message 0x${type.toString(16)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe.each(transports)('game server over WebSockets (%s)', (transport) => {
  let server: RunningServer;

  beforeAll(async () => {
    // AOI off: the two clients spawn at opposite ends of the map
    server = await createServer(0, { dummies: true, aoi: false }, () => {}, transport);
    expect(server.transport).toBe(transport);
  });

  afterAll(() => server?.close());

  it('two clients join, one walks right, the other sees it move', async () => {
    const url = `ws://127.0.0.1:${server.port}`;
    const a = new TestClient(url);
    const b = new TestClient(url);
    await Promise.all([a.opened, b.opened]);
    a.send(encodeHello('Ade'));
    b.send(encodeHello('Kemi'));
    const wa = (await a.waitFor(MsgType.Welcome)) as WelcomeMsg;
    const wb = (await b.waitFor(MsgType.Welcome)) as WelcomeMsg;
    expect(wa.playerId).not.toBe(wb.playerId);

    const firstSeen = (await b.waitFor(MsgType.Snapshot, (s) => s.players.some((p) => p.id === wa.playerId))) as SnapshotMsg;
    const x0 = firstSeen.players.find((p) => p.id === wa.playerId)!.x;

    // A holds "right", tagging each input a little ahead of the newest server tick it has seen (as a
    // real client paces itself), until B sees it move. A fixed schedule fell behind the server on a
    // loaded machine (the sleeps stretch, the server keeps ticking) and inputs for ticks already
    // simulated are dropped, so A never moved.
    const input = { ...createInput(), buttons: Btn.Right };
    const newestTick = () => (a.messages.filter((m): m is SnapshotMsg => m.type === MsgType.Snapshot).at(-1)?.serverTick ?? firstSeen.serverTick);
    const isMoved = (s: SnapshotMsg) => (s.players.find((p) => p.id === wa.playerId)?.x ?? 0) > x0 + 1;
    const deadline = Date.now() + 10_000;
    while (!b.messages.some((m) => m.type === MsgType.Snapshot && isMoved(m)) && Date.now() < deadline) {
      a.send(encodeInput({ newestTick: (newestTick() + 8) & 0xffff, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [input] }));
      await new Promise((r) => setTimeout(r, 16));
    }
    const moved = (await b.waitFor(MsgType.Snapshot, isMoved, 0)) as SnapshotMsg;
    expect(moved.players.find((p) => p.id === wa.playerId)!.x).toBeGreaterThan(x0 + 1);

    a.ws.close();
    b.ws.close();
  });

  it('accepts upgrades with big cookie headers (browsers send every localhost cookie, any port)', async () => {
    const cookie = Array.from({ length: 48 }, (_, i) => `project${i}_session=${'x'.repeat(480)}`).join('; '); // ~24 KB
    expect(cookie.length).toBeGreaterThan(16 * 1024); // over both old limits: uWS 4 KB, Node http 16 KB
    const ws = new WsClient(`ws://127.0.0.1:${server.port}`, { headers: { Cookie: cookie } });
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('unexpected-response', (_req, res) => resolve(`HTTP ${res.statusCode}`));
      ws.on('error', (e) => resolve(`error: ${e.message}`));
    });
    ws.close();
    expect(outcome).toBe('open');
  });

  it('a client that drops comes back as the same player with its session token', async () => {
    const url = `ws://127.0.0.1:${server.port}`;
    const a = new TestClient(url);
    await a.opened;
    a.send(encodeHello('Rejoin'));
    const first = (await a.waitFor(MsgType.Welcome)) as WelcomeMsg;
    a.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const again = new TestClient(url);
    await again.opened;
    again.send(encodeHello('Rejoin', first.sessionToken));
    const resumed = (await again.waitFor(MsgType.Welcome)) as WelcomeMsg;
    expect(resumed).toMatchObject({ playerId: first.playerId, resumed: true });
    const snap = (await again.waitFor(MsgType.Snapshot)) as SnapshotMsg;
    expect(snap.local).not.toBeNull();
    again.ws.close();
  });

  it('a kicked player is gone for good: its token does not resume', async () => {
    const url = `ws://127.0.0.1:${server.port}`;
    const a = new TestClient(url);
    await a.opened;
    a.send(encodeHello('Spammer'));
    const welcome = (await a.waitFor(MsgType.Welcome)) as WelcomeMsg;
    const closed = new Promise<number>((resolve) => (a.ws.onclose = (ev) => resolve(ev.code)));
    for (let i = 0; i < 3; i++) a.send(Uint8Array.of(0x77, 1, 2));
    expect(await closed).toBe(4003);
    const again = new TestClient(url);
    await again.opened;
    again.send(encodeHello('Spammer', welcome.sessionToken));
    expect(((await again.waitFor(MsgType.Welcome)) as WelcomeMsg).resumed).toBe(false);
    again.ws.close();
  });

  it('serves a health endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.ok).toBe(true);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true, transport });
  });
});
