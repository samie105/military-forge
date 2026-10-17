/**
 * The WebTransport gateway bridge: a fake gateway speaks the frame protocol over a real Unix
 * socket, as apps/wt-gateway does, and the room treats each session like any other client.
 */
import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgType, decodeMessage, encodeHello, encodeInput, type Message, type WelcomeMsg } from '@military-forge/protocol';
import { createInput } from '@military-forge/sim';
import { afterEach, describe, expect, it } from 'vitest';
import { Room } from '../src/room';
import {
  GatewayFrame,
  GatewayFrameReader,
  MAX_DATAGRAM_BYTES,
  MAX_PAYLOAD,
  encodeGatewayFrame,
  startGatewayBridge,
  type GatewayBridge,
  type GatewayBridgeOptions,
} from '../src/transports';

interface Received {
  kind: number;
  session: number;
  payload: Uint8Array;
}

class FakeGateway {
  readonly frames: Received[] = [];
  private readonly reader = new GatewayFrameReader();
  /** answer the bridge's pings, as the real gateway does */
  answerPings = true;
  constructor(readonly socket: Socket) {
    socket.on('error', () => {}); // writes after the bridge hung up (the intruder test)
    socket.on('data', (chunk: Buffer) =>
      this.reader.push(new Uint8Array(chunk), (kind, session, payload) => {
        if (kind === GatewayFrame.Ping && this.answerPings) this.send(GatewayFrame.Pong, 0, payload);
        this.frames.push({ kind, session, payload });
      }),
    );
  }
  get closed(): boolean {
    return this.socket.destroyed || this.socket.readableEnded;
  }
  closeCode(session: number): number | undefined {
    const f = this.frames.find((f) => f.session === session && f.kind === GatewayFrame.Close);
    return f && new DataView(f.payload.buffer, f.payload.byteOffset).getUint16(0, true);
  }
  send(kind: number, session: number, payload?: Uint8Array): void {
    this.socket.write(encodeGatewayFrame(kind, session, payload));
  }
  messages(session: number, kind?: number): Message[] {
    return this.frames
      .filter((f) => f.session === session && (kind === undefined || f.kind === kind) && (f.kind === GatewayFrame.Reliable || f.kind === GatewayFrame.Datagram))
      .map((f) => decodeMessage(f.payload));
  }
  async until(pred: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

const path = join(tmpdir(), `mm-gw-test-${process.pid}.sock`);
let bridge: GatewayBridge | null = null;

afterEach(() => {
  bridge?.close();
  bridge = null;
});

async function connectGateway(): Promise<FakeGateway> {
  const socket = connect(path);
  await new Promise<void>((r) => socket.once('connect', () => r()));
  return new FakeGateway(socket);
}

async function setup(room: Room, options: GatewayBridgeOptions = {}) {
  bridge = await startGatewayBridge(path, room, () => {}, options);
  return connectGateway();
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const HASH = 'ab'.repeat(32);

async function joined(gw: FakeGateway, room: Room, session: number, name: string) {
  gw.send(GatewayFrame.Open, session);
  gw.send(GatewayFrame.Reliable, session, encodeHello(name));
  await gw.until(() => gw.messages(session).some((m) => m.type === MsgType.Welcome));
  return room.clients.size;
}

describe('WebTransport gateway bridge', () => {
  it('sessions join over the reliable stream, snapshots come back as datagrams, inputs go in as datagrams', async () => {
    const room = new Room({ dummies: false, aoi: false });
    const gw = await setup(room);
    gw.send(GatewayFrame.Info, 0, json({ url: 'https://localhost:4433/wt', certHashes: [HASH] }));
    gw.send(GatewayFrame.Open, 7, new TextEncoder().encode('127.0.0.1:50000'));
    gw.send(GatewayFrame.Reliable, 7, encodeHello('Viaduct'));
    await gw.until(() => gw.messages(7).some((m) => m.type === MsgType.Welcome));
    const welcome = gw.messages(7).find((m) => m.type === MsgType.Welcome) as WelcomeMsg;
    expect(gw.frames.find((f) => f.session === 7)!.kind).toBe(GatewayFrame.Reliable); // WELCOME: reliable
    expect(bridge!.sessions()).toBe(1);

    for (let t = 0; t < 10; t++) {
      gw.send(GatewayFrame.Datagram, 7, encodeInput({ newestTick: room.game.tick, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [createInput()] }));
      await new Promise((r) => setTimeout(r, 2));
      room.tick();
    }
    const snapshotFrames = () => gw.frames.filter((f) => f.session === 7 && f.payload[0] === MsgType.Snapshot);
    await gw.until(() => snapshotFrames().length === 5);
    const snaps = snapshotFrames();
    expect(snaps.length).toBe(5);
    expect(snaps.every((f) => f.kind === GatewayFrame.Datagram && f.payload.length <= MAX_DATAGRAM_BYTES)).toBe(true);
    expect(room.game.players[welcome.playerId]).not.toBeNull();
    expect(room.clients.size).toBe(1);
  });

  it('a session the gateway closes waits for a reconnect; a kick closes the session at the gateway', async () => {
    const room = new Room({ dummies: false });
    const gw = await setup(room);
    gw.send(GatewayFrame.Open, 1);
    gw.send(GatewayFrame.Reliable, 1, encodeHello('A'));
    gw.send(GatewayFrame.Open, 2);
    gw.send(GatewayFrame.Reliable, 2, encodeHello('B'));
    await gw.until(() => room.humanCount === 2);
    gw.send(GatewayFrame.Close, 1);
    await gw.until(() => room.clients.size === 1);
    expect(room.humanCount).toBe(2); // A keeps its slot for the reconnect grace

    for (let i = 0; i < 3; i++) gw.send(GatewayFrame.Reliable, 2, Uint8Array.of(0x77, 1, 2)); // garbage → kicked
    await gw.until(() => gw.frames.some((f) => f.session === 2 && f.kind === GatewayFrame.Close));
    const close = gw.frames.find((f) => f.session === 2 && f.kind === GatewayFrame.Close)!;
    expect(new DataView(close.payload.buffer, close.payload.byteOffset).getUint16(0, true)).toBe(4003);
  });

  it('when the gateway itself goes away its players wait for a reconnect, and the bridge survives', async () => {
    const room = new Room({ dummies: false });
    const gw = await setup(room);
    gw.send(GatewayFrame.Open, 1);
    gw.send(GatewayFrame.Reliable, 1, encodeHello('A'));
    await gw.until(() => room.humanCount === 1);
    gw.socket.destroy();
    await gw.until(() => room.clients.size === 0);
    expect(room.humanCount).toBe(1);
    const again = new FakeGateway(connect(path));
    await new Promise<void>((r) => again.socket.once('connect', () => r()));
    again.send(GatewayFrame.Open, 1);
    again.send(GatewayFrame.Reliable, 1, encodeHello('C'));
    await again.until(() => room.humanCount === 2);
    again.socket.destroy();
  });

  it('an oversized message costs only its own session; unknown frames are ignored', async () => {
    const room = new Room({ dummies: false });
    const gw = await setup(room);
    await joined(gw, room, 1, 'A');
    await joined(gw, room, 2, 'B');
    gw.send(9, 1, Uint8Array.of(1, 2, 3)); // a newer gateway's frame kind
    gw.send(GatewayFrame.Reliable, 1, new Uint8Array(MAX_PAYLOAD + 1));
    await gw.until(() => gw.closeCode(1) !== undefined);
    expect(gw.closeCode(1)).toBe(4003);
    expect(room.humanCount).toBe(1); // ended like a kick: no reconnect slot
    // the bridge and B carry on
    gw.send(GatewayFrame.Reliable, 2, new Uint8Array(MAX_PAYLOAD)); // at the limit: fine (just garbage to the room)
    gw.send(GatewayFrame.Datagram, 2, encodeInput({ newestTick: room.game.tick, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [createInput()] }));
    for (let i = 0; i < 4; i++) room.tick();
    await gw.until(() => gw.frames.some((f) => f.session === 2 && f.payload[0] === MsgType.Snapshot));
    expect(gw.closed).toBe(false);
    expect(bridge!.sessions()).toBe(1);
  });

  it('the gateway\'s own 4003 ends the player; its other closes may resume', async () => {
    const room = new Room({ dummies: false, reconnectGraceMs: 20_000 });
    const gw = await setup(room);
    await joined(gw, room, 1, 'A');
    await joined(gw, room, 2, 'B');
    const close = (code: number) => {
      const p = new Uint8Array(2);
      new DataView(p.buffer).setUint16(0, code, true);
      return p;
    };
    gw.send(GatewayFrame.Close, 1, close(4003)); // message too large, at the gateway
    gw.send(GatewayFrame.Close, 2, close(1013)); // too slow: may come back
    await gw.until(() => room.clients.size === 0);
    expect(room.humanCount).toBe(1);
  });

  it('INFO is checked before /health advertises it, and forgotten with the gateway', async () => {
    const room = new Room({ dummies: false });
    const gw = await setup(room);
    for (const bad of [{ url: 'http://h/wt', certHashes: [] }, { url: 'https://h/wt?x', certHashes: [] }, { url: 'https://h/wt', certHashes: ['zz'] }, { url: 7 }]) {
      gw.send(GatewayFrame.Info, 0, json(bad));
    }
    gw.send(GatewayFrame.Info, 0, new TextEncoder().encode('{"url":"https://h/w"t"}')); // unescaped quote
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge!.info()).toBeNull();
    gw.send(GatewayFrame.Info, 0, json({ url: 'https://fra-gs-01.gs.example.com/wt/3', certHashes: [HASH] }));
    await gw.until(() => bridge!.info() !== null);
    expect(bridge!.info()).toEqual({ url: 'https://fra-gs-01.gs.example.com/wt/3', certHashes: [HASH], sessions: 0 });
    gw.socket.destroy();
    await gw.until(() => bridge!.info() === null);
  });

  it('one gateway at a time: a second connection is refused and the first keeps working', async () => {
    const room = new Room({ dummies: false });
    const gw = await setup(room);
    gw.send(GatewayFrame.Info, 0, json({ url: 'https://localhost:4433/wt', certHashes: [] }));
    await gw.until(() => bridge!.info() !== null);
    const intruder = await connectGateway();
    intruder.send(GatewayFrame.Info, 0, json({ url: 'https://evil.example/wt', certHashes: [] }));
    await intruder.until(() => intruder.closed);
    expect(bridge!.info()?.url).toBe('https://localhost:4433/wt');
    await joined(gw, room, 1, 'A');
  });

  it('a gateway that stops answering pings is dropped: its players wait to resume and /health stops advertising it', async () => {
    const room = new Room({ dummies: false, reconnectGraceMs: 20_000 });
    const gw = await setup(room, { pingMs: 20, timeoutMs: 120 });
    gw.send(GatewayFrame.Info, 0, json({ url: 'https://localhost:4433/wt', certHashes: [] }));
    await joined(gw, room, 1, 'A');
    await new Promise((r) => setTimeout(r, 200));
    expect(gw.closed).toBe(false); // it answers
    expect(gw.frames.some((f) => f.kind === GatewayFrame.Ping)).toBe(true);
    gw.answerPings = false; // hung (SIGSTOP)
    await gw.until(() => gw.closed);
    expect(bridge!.info()).toBeNull();
    expect(room.clients.size).toBe(0);
    expect(room.humanCount).toBe(1);
  });

  it('the socket is private, and only a stale socket is ever replaced', async () => {
    const room = new Room({ dummies: false });
    bridge = await startGatewayBridge(path, room);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    bridge.close();
    bridge = null;
    writeFileSync(path, 'not a socket');
    await expect(startGatewayBridge(path, room)).rejects.toThrow(/isn't a socket/);
    unlinkSync(path);
    await expect(startGatewayBridge(join(tmpdir(), 'x'.repeat(120)), room)).rejects.toThrow(/path is/);
  });

  it('frames split or batched across reads decode the same', () => {
    const reader = new GatewayFrameReader();
    const a = encodeGatewayFrame(GatewayFrame.Reliable, 3, Uint8Array.of(1, 2, 3));
    const b = encodeGatewayFrame(GatewayFrame.Datagram, 4, new Uint8Array(600).fill(9));
    const both = new Uint8Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    const out: [number, number, number][] = [];
    for (let i = 0; i < both.length; i += 7) reader.push(both.subarray(i, i + 7), (k, s, p) => out.push([k, s, p.length]));
    expect(out).toEqual([
      [GatewayFrame.Reliable, 3, 3],
      [GatewayFrame.Datagram, 4, 600],
    ]);
    expect(() => reader.push(Uint8Array.of(1, 0, 0, 0, 0), () => {})).toThrow();
  });
});
