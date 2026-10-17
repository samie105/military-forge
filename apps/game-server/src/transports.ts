/**
 * WebSocket transports for a Room (docs/05 §2.2: binary frames, no permessage-deflate,
 * TCP_NODELAY). uWebSockets.js is preferred; the `ws` package is a drop-in fallback so the
 * server always starts (e.g. before `pnpm uws:fetch` has run on a slow connection).
 */
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
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

const MAX_PAYLOAD = 4 * 1024;
/**
 * Largest request header block accepted on the WebSocket upgrade. Browsers send every cookie for
 * the host whatever the port, so a dev machine with many localhost projects easily sends > 4 KB
 * (uWS's default limit: the upgrade gets a 400 and the client sees close code 1006).
 */
export const MAX_HEADER_BYTES = 32 * 1024;

function health(room: Room, kind: TransportKind): string {
  return JSON.stringify({ ok: true, transport: kind, players: room.humanCount, tick: room.game.tick });
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

export function startUws(mod: UwsModule, port: number, room: Room): Promise<StartedTransport> {
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
      res.writeHeader('Content-Type', 'application/json').writeHeader('Access-Control-Allow-Origin', '*').end(health(room, 'uws'));
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

export function startWs(port: number, room: Room): Promise<StartedTransport> {
  const http = createHttpServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(health(room, 'ws'));
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
