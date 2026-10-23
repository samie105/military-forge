/**
 * A local room's Room, in a worker of the host's page (host.ts). The page's own timers slow to once
 * a second when its tab is hidden, and its frames can stall a tick behind a heavy render; a
 * worker's timers keep the room at 60 Hz either way. The page keeps the network side (WebRTC
 * channels, the relay) and passes bytes in and out:
 *
 *   page → worker   {t:'open', options} · {t:'connect', id} · {t:'recv', id, bytes} ·
 *                   {t:'disconnect', id, resumable} · {t:'close', code, reason}
 *   worker → page   {t:'send', id, bytes} · {t:'kick', id, code, reason}
 */
import { workNavBuilds } from '@military-forge/bots';
import { Room, type Client, type ClientConn } from '@military-forge/game-server/room';
import { TICK_RATE } from '@military-forge/sim';
import { LOCAL_ROOM_RULES, type RoomWorkerOptions } from './rules';

type In =
  | { t: 'open'; options: RoomWorkerOptions }
  | { t: 'connect'; id: number }
  | { t: 'recv'; id: number; bytes: ArrayBuffer }
  | { t: 'disconnect'; id: number; resumable: boolean }
  | { t: 'close'; code: number; reason: string };

const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCH_UP = 5;
/** spare time between ticks lent to nav graph builds (ms; game-server loop.ts's numbers) */
const IDLE_MAX_MS = 6;
const IDLE_MARGIN_MS = 4;
const scope = self as unknown as { postMessage(msg: unknown, transfer?: Transferable[]): void; onmessage: ((ev: MessageEvent<In>) => void) | null };

let room: Room | null = null;
const clients = new Map<number, Client>();
let next = 0;

function tick(): void {
  if (!room) return;
  const now = performance.now();
  let steps = 0;
  while (now >= next && steps < MAX_CATCH_UP) {
    room.tick();
    next += TICK_MS;
    steps++;
  }
  if (now - next > TICK_MS * MAX_CATCH_UP) next = now + TICK_MS;
  // the bots' nav graph (a new map or tuning) builds between ticks, as on the server (loop.ts)
  if (steps > 0) {
    const end = Math.min(performance.now() + IDLE_MAX_MS, next - IDLE_MARGIN_MS);
    if (performance.now() < end) workNavBuilds(() => performance.now() >= end);
  }
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.t) {
    case 'open': {
      const o = msg.options;
      room = new Room({
        dummies: false,
        dev: false,
        hostTuning: true,
        match: LOCAL_ROOM_RULES,
        seed: o.seed,
        code: 'LOCAL',
        ...(o.mapId ? { mapId: o.mapId } : {}),
        ...(o.fillBots ? { fillBots: o.fillBots } : {}),
      });
      next = performance.now() + TICK_MS;
      setInterval(tick, 4);
      setInterval(() => room?.resetRateLimits(), 1000);
      break;
    }
    case 'connect': {
      if (!room) return;
      const id = msg.id;
      const conn: ClientConn = {
        send: (bytes) => {
          const copy = bytes.slice();
          scope.postMessage({ t: 'send', id, bytes: copy.buffer }, [copy.buffer]);
        },
        close: (code, reason) => scope.postMessage({ t: 'kick', id, code, reason }),
        bufferedAmount: () => 0,
      };
      clients.set(id, room.connect(conn));
      break;
    }
    case 'recv': {
      const c = clients.get(msg.id);
      if (c && room) room.receive(c, new Uint8Array(msg.bytes));
      break;
    }
    case 'disconnect': {
      const c = clients.get(msg.id);
      clients.delete(msg.id);
      if (c && room) room.disconnect(c, msg.resumable);
      break;
    }
    case 'close':
      room?.closeAll(msg.code, msg.reason);
      break;
  }
};
