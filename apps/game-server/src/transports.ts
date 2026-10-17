/**
 * Transports for a Room (docs/05 §2):
 * - WebSocket (§2.2: binary frames, no permessage-deflate, TCP_NODELAY). uWebSockets.js is
 *   preferred; the `ws` package is a drop-in fallback so the server always starts (e.g. before
 *   `pnpm uws:fetch` has run on a slow connection).
 * - WebTransport (§2.1, §2.3) via the Rust gateway (apps/wt-gateway), which terminates QUIC and
 *   forwards each session's messages here over a Unix socket (startGatewayBridge).
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { CloseCode, isUnreliableMessage } from '@military-forge/protocol';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import type { Client, Room } from './room';

export type TransportKind = 'uws' | 'ws';

export interface StartedTransport {
  kind: TransportKind;
  port: number;
  close(): void;
}

/** Largest message a client may send, on any transport (the WebTransport gateway enforces it too). */
export const MAX_PAYLOAD = 4 * 1024;
/**
 * Largest request header block accepted on the WebSocket upgrade. Browsers send every cookie for
 * the host whatever the port, so a dev machine with many localhost projects easily sends > 4 KB
 * (uWS's default limit: the upgrade gets a 400 and the client sees close code 1006).
 */
export const MAX_HEADER_BYTES = 32 * 1024;

/** What the WebTransport gateway told us about itself (null until one connects). */
export interface WebTransportInfo {
  /** public URL clients connect to, e.g. https://localhost:4433/wt */
  url: string;
  /** SHA-256 of the gateway's self-signed certificate (hex), for serverCertificateHashes; empty with a real cert */
  certHashes: string[];
}

export interface WebTransportStatus extends WebTransportInfo {
  sessions: number;
}

/** Where /health finds the attached gateway, if any (GatewayBridge.info). */
export type WebTransportSource = () => WebTransportStatus | null;
const noWebTransport: WebTransportSource = () => null;

/** The /health body. Clients read `webtransport` to try the UDP path (docs/05 §2.1). */
function health(room: Room, kind: TransportKind, webTransport: WebTransportSource): string {
  return JSON.stringify({ ok: true, transport: kind, players: room.humanCount, tick: room.game.tick, webtransport: webTransport() });
}

// ---------- uWebSockets.js (minimal structural types: no compile-time dependency) ----------

interface UwsSocket {
  getUserData(): { client?: Client };
  send(message: Uint8Array, isBinary: boolean): number;
  end(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

interface UwsResponse {
  writeHeader(key: string, value: string): UwsResponse;
  end(body?: string): UwsResponse;
}

interface UwsApp {
  ws(
    pattern: string,
    behavior: {
      compression: number;
      maxPayloadLength: number;
      idleTimeout: number;
      maxBackpressure: number;
      sendPingsAutomatically: boolean;
      open: (ws: UwsSocket) => void;
      message: (ws: UwsSocket, message: ArrayBuffer, isBinary: boolean) => void;
      close: (ws: UwsSocket) => void;
    },
  ): UwsApp;
  get(pattern: string, handler: (res: UwsResponse) => void): UwsApp;
  listen(port: number, cb: (token: unknown) => void): UwsApp;
  close(): void;
}

interface UwsModule {
  App(): UwsApp;
  DISABLED: number;
  us_socket_local_port(token: unknown): number;
  us_listen_socket_close(token: unknown): void;
}

/** Loads uWebSockets.js from vendor/ (pnpm uws:fetch) or node_modules; null if unavailable. */
export function loadUws(): { mod: UwsModule; from: string } | null {
  // uWS reads this from the process environment (not from options); set it before the first load.
  // Done here rather than in package.json/turbo: turbo's strict env mode would drop it.
  process.env.UWS_HTTP_MAX_HEADERS_SIZE ??= String(MAX_HEADER_BYTES);
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'vendor', 'uWebSockets.js'), 'uWebSockets.js']) {
    try {
      return { mod: require(candidate) as UwsModule, from: candidate };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function startUws(mod: UwsModule, port: number, room: Room, webTransport = noWebTransport): Promise<StartedTransport> {
  const app = mod
    .App()
    .ws('/*', {
      compression: mod.DISABLED,
      maxPayloadLength: MAX_PAYLOAD,
      idleTimeout: 30,
      maxBackpressure: 256 * 1024,
      sendPingsAutomatically: true,
      open: (ws) => {
        const data = ws.getUserData();
        data.client = room.connect({
          send: (bytes) => {
            if (!data.client?.closed) ws.send(bytes, true);
          },
          close: (code, reason) => {
            if (!data.client?.closed) ws.end(code, reason);
          },
          bufferedAmount: () => (data.client?.closed ? 0 : ws.getBufferedAmount()),
        });
      },
      message: (ws, message, isBinary) => {
        const client = ws.getUserData().client;
        // uWS reuses `message` after this callback returns: copy it
        if (client && isBinary) room.receive(client, new Uint8Array(message.slice(0)));
      },
      close: (ws) => {
        const client = ws.getUserData().client;
        if (client) room.disconnect(client);
      },
    })
    .get('/health', (res) => {
      res.writeHeader('Content-Type', 'application/json').writeHeader('Access-Control-Allow-Origin', '*').end(health(room, 'uws', webTransport));
    });

  return new Promise((resolve, reject) => {
    app.listen(port, (token) => {
      if (!token) return reject(new Error(`could not listen on port ${port}`));
      resolve({
        kind: 'uws',
        port: mod.us_socket_local_port(token),
        close() {
          mod.us_listen_socket_close(token);
          app.close();
        },
      });
    });
  });
}

// ---------- ws (fallback) ----------

export function startWs(port: number, room: Room, webTransport = noWebTransport): Promise<StartedTransport> {
  const http = createHttpServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(health(room, 'ws', webTransport));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
  wss.on('connection', (socket) => {
    let client: Client | null = null;
    client = room.connect({
      send: (bytes) => {
        if (socket.readyState === WsSocket.OPEN) socket.send(bytes, { binary: true });
      },
      close: (code, reason) => socket.close(code, reason),
      bufferedAmount: () => socket.bufferedAmount,
    });
    socket.on('message', (data, isBinary) => {
      if (!client || !isBinary || !Buffer.isBuffer(data)) return;
      room.receive(client, new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
    });
    socket.on('close', () => {
      if (client) room.disconnect(client);
      client = null;
    });
    socket.on('error', () => socket.terminate());
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, () => {
      resolve({
        kind: 'ws',
        port: (http.address() as AddressInfo).port,
        close() {
          for (const c of wss.clients) c.terminate();
          wss.close();
          http.close();
        },
      });
    });
  });
}

// ---------- WebTransport gateway bridge ----------

/**
 * Frames between the gateway and this process, over a Unix socket:
 *   u32 length (LE, of everything after it) · u8 kind · u32 session (LE) · payload
 */
export const GatewayFrame = {
  /** gateway → server: a WebTransport session opened (payload: remote address) */
  Open: 1,
  /** both ways: the session is over (payload: u16 code LE + UTF-8 reason) */
  Close: 2,
  /** both ways: a message on the session's reliable stream */
  Reliable: 3,
  /** both ways: a datagram */
  Datagram: 4,
  /** gateway → server, session 0: JSON WebTransportInfo (again whenever its certificate changes) */
  Info: 5,
  /** server → gateway, session 0: answer with Pong (same payload) */
  Ping: 6,
  /** gateway → server, session 0 */
  Pong: 7,
} as const;

/** Datagram budget (docs/05 §2.3: Chrome caps maxDatagramSize at ~1024; never fragment). */
export const MAX_DATAGRAM_BYTES = 1000;
/** No legitimate frame is near this; a bigger one means a broken gateway (the byte stream is lost). */
const MAX_FRAME_BYTES = 64 * 1024;
const GATEWAY_PING_MS = 1000;
/** A gateway silent this long is dropped and no longer advertised; its players resume over WebSocket. */
const GATEWAY_TIMEOUT_MS = 3000;
/** macOS allows 104 bytes for a Unix socket path (Linux 108), NUL included. */
const MAX_SOCKET_PATH = 103;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function encodeGatewayFrame(kind: number, session: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 5 + payload.length, true);
  out[4] = kind;
  v.setUint32(5, session, true);
  out.set(payload, 9);
  return out;
}

/** Splits a byte stream into frames (the gateway may batch or split writes). */
export class GatewayFrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array, onFrame: (kind: number, session: number, payload: Uint8Array) => void): void {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    let off = 0;
    while (joined.length - off >= 4) {
      const len = new DataView(joined.buffer, joined.byteOffset + off, 4).getUint32(0, true);
      if (len < 5 || len > MAX_FRAME_BYTES) throw new Error(`gateway frame length ${len}`);
      if (joined.length - off - 4 < len) break;
      const kind = joined[off + 4]!;
      const session = new DataView(joined.buffer, joined.byteOffset + off + 5, 4).getUint32(0, true);
      onFrame(kind, session, joined.slice(off + 9, off + 4 + len));
      off += 4 + len;
    }
    this.buf = joined.slice(off);
  }
}

export interface GatewayBridge {
  path: string;
  /** sessions currently open through the gateway */
  sessions(): number;
  /** what /health advertises: the connected gateway's endpoint, or null */
  info(): WebTransportStatus | null;
  close(): void;
}

export interface GatewayBridgeOptions {
  pingMs?: number;
  timeoutMs?: number;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * The dev socket for `port`, in a private directory (0700) under $XDG_RUNTIME_DIR or the temp
 * dir, so no other user can squat it or listen in. apps/wt-gateway computes the same default.
 */
export function defaultGatewaySocket(port: number): string {
  const dir = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'military-forge');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} must be a directory only you can use (mode 0700)`);
  }
  return join(dir, `wt-${port}.sock`);
}

/** A stale socket from a crashed run goes; anything else at that path is left alone. */
function removeStaleSocket(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Error(`${path} exists and isn't a socket; not replacing it`);
  unlinkSync(path);
}

/** INFO from the gateway, checked: it ends up in every client's /health. */
function parseInfo(payload: Uint8Array): WebTransportInfo | null {
  try {
    const v = JSON.parse(fromUtf8.decode(payload)) as { url?: unknown; certHashes?: unknown };
    if (typeof v.url !== 'string') return null;
    const url = new URL(v.url);
    if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) return null;
    const hashes = v.certHashes ?? [];
    if (!Array.isArray(hashes) || hashes.length > 4 || !hashes.every((h) => typeof h === 'string' && HEX_SHA256.test(h))) return null;
    return { url: url.toString(), certHashes: hashes as string[] };
  } catch {
    return null;
  }
}

function closePayload(code: number, reason: string): Uint8Array {
  const r = utf8.encode(reason);
  const p = new Uint8Array(2 + r.length);
  new DataView(p.buffer).setUint16(0, code, true);
  p.set(r, 2);
  return p;
}

/**
 * Listens on a Unix socket (0600) for the WebTransport gateway, one at a time. Each gateway session
 * becomes a Room client: messages the protocol marks unreliable (snapshots, pongs) go back as
 * datagrams when they fit the 1000-byte budget, everything else on the session's reliable stream.
 *
 * One session's misbehaviour costs only that session; a gateway that stops answering pings is
 * dropped (its players resume, over WebSocket if need be) and /health stops advertising it.
 * Per-session backpressure lives in the gateway (it drops datagrams and closes sessions that fall
 * behind); `bufferedAmount` here is the shared socket's, which only grows if the gateway itself
 * stalls, and then no snapshot should be queued for any of its players.
 */
export function startGatewayBridge(path: string, room: Room, log: (msg: string) => void = () => {}, options: GatewayBridgeOptions = {}): Promise<GatewayBridge> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    return Promise.reject(new Error(`WebTransport gateway socket path is ${Buffer.byteLength(path)} bytes; Unix sockets allow ${MAX_SOCKET_PATH}: ${path}`));
  }
  try {
    removeStaleSocket(path);
  } catch (e) {
    return Promise.reject(e as Error);
  }
  const pingMs = options.pingMs ?? GATEWAY_PING_MS;
  const timeoutMs = options.timeoutMs ?? GATEWAY_TIMEOUT_MS;
  /** the connected gateway's sessions, by its session id */
  const clients = new Map<number, Client>();
  let gateway: Socket | null = null;
  let info: WebTransportInfo | null = null;

  const server = createNetServer((socket: Socket) => {
    if (gateway) {
      log('[game-server] a second WebTransport gateway tried to connect; refused');
      socket.destroy();
      return;
    }
    gateway = socket;
    const reader = new GatewayFrameReader();
    let heardAt = Date.now();
    socket.setNoDelay(true);
    const write = (bytes: Uint8Array) => {
      if (!socket.destroyed) socket.write(bytes);
    };
    const closeSession = (session: number, code: number, reason: string) => write(encodeGatewayFrame(GatewayFrame.Close, session, closePayload(code, reason)));
    const ping = setInterval(() => {
      if (Date.now() - heardAt > timeoutMs) {
        log(`[game-server] the WebTransport gateway hasn't answered for ${timeoutMs} ms; dropping it`);
        socket.destroy();
        return;
      }
      write(encodeGatewayFrame(GatewayFrame.Ping, 0));
    }, pingMs);

    const onFrame = (kind: number, session: number, payload: Uint8Array) => {
      switch (kind) {
        case GatewayFrame.Info: {
          const parsed = parseInfo(payload);
          if (!parsed) {
            log('[game-server] ignoring an invalid INFO from the WebTransport gateway');
            break;
          }
          info = parsed;
          log(`[game-server] WebTransport gateway connected: ${info.url}`);
          break;
        }
        case GatewayFrame.Open: {
          if (clients.has(session)) break;
          const client = room.connect({
            send: (bytes) => {
              const datagram = isUnreliableMessage(bytes) && bytes.length <= MAX_DATAGRAM_BYTES;
              write(encodeGatewayFrame(datagram ? GatewayFrame.Datagram : GatewayFrame.Reliable, session, bytes));
            },
            close: (code, reason) => {
              closeSession(session, code, reason);
              clients.delete(session);
            },
            bufferedAmount: () => socket.writableLength,
          });
          clients.set(session, client);
          break;
        }
        case GatewayFrame.Reliable:
        case GatewayFrame.Datagram: {
          const client = clients.get(session);
          if (!client) break;
          if (payload.length > MAX_PAYLOAD) {
            // the WebSocket limit (the gateway enforces it as well): only this session pays
            clients.delete(session);
            closeSession(session, CloseCode.BadMessage, 'message too large');
            room.disconnect(client, false);
            break;
          }
          room.receive(client, payload);
          break;
        }
        case GatewayFrame.Close: {
          const client = clients.get(session);
          clients.delete(session);
          // the gateway's own 4003 (oversized message) ends the player like a kick; anything else may resume
          const code = payload.length >= 2 ? new DataView(payload.buffer, payload.byteOffset).getUint16(0, true) : 1000;
          if (client) room.disconnect(client, code !== CloseCode.BadMessage);
          break;
        }
        default:
          break; // Pong (heardAt is updated per chunk), or a newer gateway's frame we don't know
      }
    };

    socket.on('data', (chunk: Buffer) => {
      heardAt = Date.now();
      try {
        reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), onFrame);
      } catch (e) {
        // only a broken byte stream gets here (a bad frame length): nothing can be resynchronised
        log(`[game-server] dropping the WebTransport gateway: ${(e as Error).message}`);
        socket.destroy();
      }
    });
    socket.on('close', () => {
      clearInterval(ping);
      if (gateway === socket) {
        gateway = null;
        info = null;
      }
      // its players wait for a reconnect (they'll come back over WS or WT)
      for (const [session, client] of clients) {
        clients.delete(session);
        room.disconnect(client);
      }
    });
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve({
        path,
        sessions: () => clients.size,
        info: () => (info ? { ...info, sessions: clients.size } : null),
        close() {
          server.close();
          gateway?.destroy();
          for (const client of clients.values()) room.disconnect(client);
          clients.clear();
          info = null;
          try {
            removeStaleSocket(path);
          } catch {
            /* not ours any more */
          }
        },
      });
    });
  });
}
