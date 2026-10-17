/** Game server = Room + tick loop + a WebSocket transport (uWebSockets.js, or `ws` as fallback). */
import type { Scheduler } from '@military-forge/netcode';
import { TICK_RATE } from '@military-forge/sim';
import { startTickLoop } from './loop';
import { Room, type RoomOptions } from './room';
import { loadUws, startGatewayBridge, startUws, startWs, type GatewayBridge, type TransportKind } from './transports';

/** Real timers for the server-side network conditioner. */
export const nodeScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface RunningServer {
  port: number;
  transport: TransportKind;
  room: Room;
  close(): void;
}

export async function createServer(
  port: number,
  roomOptions: RoomOptions = {},
  log: (msg: string) => void = console.log,
  prefer: TransportKind = 'uws',
  /** Unix socket the WebTransport gateway (apps/wt-gateway) connects to; none = WebSocket only */
  gatewaySocket?: string,
): Promise<RunningServer> {
  const room = new Room(roomOptions);
  const uws = prefer === 'uws' ? loadUws() : null;
  if (prefer === 'uws' && !uws) log('[game-server] uWebSockets.js not found, using the `ws` fallback (run `pnpm uws:fetch` to enable uWS)');
  // the WebTransport bridge is optional: if its socket can't be made, WebSocket still works
  let gateway: GatewayBridge | null = null;
  if (gatewaySocket) {
    try {
      gateway = await startGatewayBridge(gatewaySocket, room, log);
    } catch (e) {
      log(`[game-server] no WebTransport (WebSocket only): ${(e as Error).message}`);
    }
  }
  const webTransport = () => gateway?.info() ?? null;
  const transport = uws ? await startUws(uws.mod, port, room, webTransport) : await startWs(port, room, webTransport);

  const loop = startTickLoop(TICK_RATE, () => room.tick());
  const rateTimer = setInterval(() => room.resetRateLimits(), 1000);
  const reportTimer = setInterval(() => {
    const s = loop.stats;
    if (s.ticks === 0) return;
    log(
      `[room] ${room.humanCount} players · ${s.ticks} ticks · avg ${(s.busyMs / s.ticks).toFixed(3)} ms · max ${s.maxTickMs.toFixed(3)} ms` +
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
    close() {
      loop.stop();
      clearInterval(rateTimer);
      clearInterval(reportTimer);
      transport.close();
      gateway?.close();
    },
  };
}
