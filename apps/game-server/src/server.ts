/** Game server = Room + tick loop + a WebSocket transport (uWebSockets.js, or `ws` as fallback). */
import type { Scheduler } from '@military-forge/netcode';
import { TICK_RATE } from '@military-forge/sim';
import { startTickLoop } from './loop';
import { Room, type RoomOptions } from './room';
import { loadUws, startUws, startWs, type TransportKind } from './transports';

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
): Promise<RunningServer> {
  const room = new Room(roomOptions);
  const uws = prefer === 'uws' ? loadUws() : null;
  if (prefer === 'uws' && !uws) log('[game-server] uWebSockets.js not found, using the `ws` fallback (run `pnpm uws:fetch` to enable uWS)');
  const transport = uws ? await startUws(uws.mod, port, room) : await startWs(port, room);

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
    },
  };
}
