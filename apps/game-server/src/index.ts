import { BOT_LEVELS, warmNavGraphs, type BotLevelId } from '@military-forge/bots';
import { maps } from '@military-forge/content';
import { describeNetSim, parseNetSim } from '@military-forge/netcode';
import { createServer, nodeScheduler } from './server';
import { TicketVerifier, ticketPublicKey } from './tickets';
import { defaultGatewaySocket } from './transports';

const port = Number(process.env.PORT ?? 9001);
const dev = process.env.NODE_ENV !== 'production';
// HOST=127.0.0.1 keeps the server behind a local proxy (pnpm playtest); DEFAULT_ROOM=0 drops the
// uncoded dev room so only rooms by code (rooms.ts) exist; MAX_ROOMS caps them.
const host = process.env.HOST || undefined;
const defaultRoom = process.env.DEFAULT_ROOM !== '0';
const maxRooms = process.env.MAX_ROOMS ? Number(process.env.MAX_ROOMS) : undefined;
// Join tickets (docs/06 §6): JOIN_TICKET_PUBLIC_KEY is the API's ticket key (PEM). With it, a new
// player in a room by code needs the API's ticket; production refuses to run rooms without it.
// TRUST_PROXY=1: client addresses from X-Forwarded-For (only behind our own proxy, pnpm playtest).
const ticketKeyPem = process.env.JOIN_TICKET_PUBLIC_KEY;
let tickets: TicketVerifier | null = null;
try {
  tickets = ticketKeyPem ? new TicketVerifier(ticketPublicKey(ticketKeyPem)) : null;
} catch (e) {
  console.error(`[game-server] JOIN_TICKET_PUBLIC_KEY: ${(e as Error).message}`);
  process.exit(1);
}
if (!dev && !tickets) {
  console.error(`[game-server] production needs JOIN_TICKET_PUBLIC_KEY (the API's join-ticket public key, PEM): rooms by code admit players with the API's tickets only`);
  process.exit(1);
}
const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
// Network conditioner on every connection (docs/05 §15.2), e.g. NET_SIM="rtt=150,loss=2" or --net-sim=rtt=150,loss=2
const netSimSpec = process.argv.find((a) => a.startsWith('--net-sim='))?.slice('--net-sim='.length) ?? process.env.NET_SIM;
const netSim = dev ? parseNetSim(netSimSpec) : null;
// WebTransport gateway socket (apps/wt-gateway connects to it). Dev: on by default, one per port,
// in a private directory. Production: --wt-socket= or WT_SOCKET (e.g. /run/military-forge/gs1.sock).
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const devSocket = () => {
  try {
    return defaultGatewaySocket(port);
  } catch (e) {
    console.log(`[game-server] no WebTransport (WebSocket only): ${(e as Error).message}`);
    return undefined;
  }
};
const wtSocket = arg('wt-socket') ?? process.env.WT_SOCKET ?? (dev ? devSocket() : undefined);
// The room's map: --map=flux-lab or MAP=flux-lab (docs/02 §20 demo maps: lunar-outpost, storm-front, flux-lab)
const mapId = arg('map') ?? process.env.MAP ?? 'movement-test';
if (!maps[mapId]) {
  console.error(`[game-server] unknown map "${mapId}" (maps: ${Object.keys(maps).join(', ')})`);
  process.exit(1);
}
// Bots (docs/08 §9): --bots=4 or BOTS=4 keeps every room with a human in it at 4 players, topping
// it up with bots ([BOT] names); --bot-level= or BOT_LEVEL= easy|normal|hard (default normal).
const botTarget = Number(arg('bots') ?? process.env.BOTS ?? 0);
const botLevel = (arg('bot-level') ?? process.env.BOT_LEVEL ?? 'normal') as BotLevelId;
if (!Number.isInteger(botTarget) || botTarget < 0 || !Object.hasOwn(BOT_LEVELS, botLevel)) {
  console.error(`[game-server] bots: --bots= takes a whole number of players, --bot-level= one of ${Object.keys(BOT_LEVELS).join(', ')}`);
  process.exit(1);
}
const fillBots = botTarget > 0 ? { target: botTarget, level: botLevel } : undefined;
// a nav graph takes 90–270 ms to build: build the rooms' map before anyone joins, not on the first bot
if (fillBots) warmNavGraphs([maps[mapId]!]);

const server = await createServer(
  port,
  {
    dev,
    // bots take the dummies' place in the default room
    dummies: !fillBots,
    ...(fillBots ? { fillBots } : {}),
    mapId,
    seed: Number(process.env.SEED ?? 1),
    ...(netSim ? { netSim: { settings: netSim, scheduler: nodeScheduler } } : {}),
  },
  console.log,
  'uws',
  defaultRoom ? wtSocket : undefined,
  {
    ...(host ? { host } : {}),
    defaultRoom,
    ...(maxRooms !== undefined && Number.isInteger(maxRooms) && maxRooms >= 0 ? { maxRooms } : {}),
    // rooms by code play the same map (one map per room until rooms can switch)
    roomOptions: { mapId, ...(fillBots ? { fillBots } : {}) },
    tickets,
    trustProxy,
  },
);
console.log(
  `[game-server] ${server.room ? `room "${server.room.game.map.id}"` : 'no default room'} + rooms by code on ws://${host ?? 'localhost'}:${server.port} · transport ${server.transport === 'uws' ? 'uWebSockets.js' : 'ws (fallback)'} · dev commands ${dev ? 'on' : 'off'}` +
    ` · join tickets ${tickets ? 'required' : 'off (dev)'}` +
    (fillBots ? ` · bots fill rooms to ${fillBots.target} (${fillBots.level})` : '') +
    (netSim ? ` · NET_SIM ${describeNetSim(netSim)}` : '') +
    (wtSocket ? ` · WebTransport gateway socket ${wtSocket}` : ''),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
