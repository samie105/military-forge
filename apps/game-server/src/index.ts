import { maps } from '@military-forge/content';
import { describeNetSim, parseNetSim } from '@military-forge/netcode';
import { createServer, nodeScheduler } from './server';
import { defaultGatewaySocket } from './transports';

const port = Number(process.env.PORT ?? 9001);
const dev = process.env.NODE_ENV !== 'production';
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

const server = await createServer(
  port,
  {
    dev,
    dummies: true,
    mapId,
    seed: Number(process.env.SEED ?? 1),
    ...(netSim ? { netSim: { settings: netSim, scheduler: nodeScheduler } } : {}),
  },
  console.log,
  'uws',
  wtSocket,
);
console.log(
  `[game-server] room "${server.room.game.map.id}" on ws://localhost:${server.port} · transport ${server.transport === 'uws' ? 'uWebSockets.js' : 'ws (fallback)'} · dev commands ${dev ? 'on' : 'off'}` +
    (netSim ? ` · NET_SIM ${describeNetSim(netSim)}` : '') +
    (wtSocket ? ` · WebTransport gateway socket ${wtSocket}` : ''),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
