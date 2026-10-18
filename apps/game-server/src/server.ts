/**
 * Game server = rooms (the default dev room + rooms by code, rooms.ts) + one tick loop + a WebSocket
 * transport (uWebSockets.js, or `ws` as fallback). The WebTransport gateway feeds the default room.
 */
import type { Scheduler } from '@military-forge/netcode';
import { TICK_RATE } from '@military-forge/sim';
import { startTickLoop } from './loop';
import type { Room, RoomOptions } from './room';
import { RoomRegistry, type DoorLimits } from './rooms';
import type { TicketVerifier } from './tickets';
import { loadUws, startGatewayBridge, startUws, startWs, type GatewayBridge, type RoomTarget, type TransportKind } from './transports';

/** Real timers for the server-side network conditioner. */
export const nodeScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface RunningServer {
  port: number;
  transport: TransportKind;
  /** the default (uncoded) room; null when turned off */
  room: Room | null;
  rooms: RoomRegistry;
  close(): void;
}

export interface ServerOptions {
  /** interface to listen on; default all ('127.0.0.1' behind a local proxy) */
  host?: string;
  /** keep the default room at `/` (the dev room); default true */
  defaultRoom?: boolean;
  /** most rooms by code open at once */
  maxRooms?: number;
  /** options for every room by code (they run a match; dev commands and dummies off unless set) */
  roomOptions?: RoomOptions;
  /** join tickets (the API's public key): a new player in a room by code needs one; null = dev, rooms are open */
  tickets?: TicketVerifier | null;
  /** take the client address from X-Forwarded-For (only behind our own proxy: pnpm playtest) */
  trustProxy?: boolean;
  /** caps on connections that haven't said HELLO yet (rooms.ts DEFAULT_DOOR_LIMITS) */
  door?: Partial<DoorLimits>;
  /** how long a connection may wait before its HELLO (rooms.ts HELLO_TIMEOUT_MS) */
  helloTimeoutMs?: number;
}

export async function createServer(
  port: number,
  /** the default room's options */
  roomOptions: RoomOptions = {},
  log: (msg: string) => void = console.log,
  prefer: TransportKind = 'uws',
  /** Unix socket the WebTransport gateway (apps/wt-gateway) connects to; none = WebSocket only */
  gatewaySocket?: string,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const rooms = new RoomRegistry({
    defaultRoom: options.defaultRoom === false ? null : roomOptions,
    ...(options.roomOptions ? { roomOptions: options.roomOptions } : {}),
    ...(options.maxRooms !== undefined ? { maxRooms: options.maxRooms } : {}),
    ...(options.door ? { door: options.door } : {}),
    ...(options.helloTimeoutMs !== undefined ? { helloTimeoutMs: options.helloTimeoutMs } : {}),
    tickets: options.tickets ?? null,
    log,
  });
  const room = rooms.defaultRoom;
  const target: RoomTarget = {
    open: (url, conn, ip) => rooms.open(url, conn, ip),
    get humanCount() {
      return rooms.humanCount;
    },
    get roomCount() {
      return rooms.rooms.size + (room ? 1 : 0);
    },
    get tick() {
      return room?.game.tick ?? 0;
    },
  };
  const uws = prefer === 'uws' ? loadUws() : null;
  if (prefer === 'uws' && !uws) log('[game-server] uWebSockets.js not found, using the `ws` fallback (run `pnpm uws:fetch` to enable uWS)');
  // the WebTransport bridge is optional: if its socket can't be made, WebSocket still works
  let gateway: GatewayBridge | null = null;
  if (gatewaySocket) {
    try {
      // through the registry's door, like WebSocket connections: rooms by code, tickets, limits
      gateway = await startGatewayBridge(gatewaySocket, target, log);
    } catch (e) {
      log(`[game-server] no WebTransport (WebSocket only): ${(e as Error).message}`);
    }
  }
  const webTransport = () => gateway?.info() ?? null;
  const transportOptions = { webTransport, trustProxy: options.trustProxy ?? false, log, ...(options.host ? { host: options.host } : {}) };
  const transport = uws ? await startUws(uws.mod, port, target, transportOptions) : await startWs(port, target, transportOptions);

  const loop = startTickLoop(TICK_RATE, () => rooms.tick());
  const rateTimer = setInterval(() => rooms.resetRateLimits(), 1000);
  const reportTimer = setInterval(() => {
    const s = loop.stats;
    if (s.ticks === 0) return;
    log(
      `[room${rooms.rooms.size ? `s ${target.roomCount}` : ''}] ${rooms.humanCount} players · ${s.ticks} ticks · avg ${(s.busyMs / s.ticks).toFixed(3)} ms · max ${s.maxTickMs.toFixed(3)} ms` +
        (s.dropped ? ` · dropped ${s.dropped}` : ''),
    );
    s.ticks = 0;
    s.busyMs = 0;
    s.maxTickMs = 0;
    s.dropped = 0;
  }, 10_000);

  return {
    port: transport.port,
    transport: transport.kind,
    room,
    rooms,
    close() {
      loop.stop();
      clearInterval(rateTimer);
      clearInterval(reportTimer);
      transport.close();
      gateway?.close();
    },
  };
}
