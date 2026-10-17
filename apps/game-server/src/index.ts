import { describeNetSim, parseNetSim } from '@military-forge/netcode';
import { createServer, nodeScheduler } from './server';

const port = Number(process.env.PORT ?? 9001);
const dev = process.env.NODE_ENV !== 'production';
// Network conditioner on every connection (docs/05 §15.2), e.g. NET_SIM="rtt=150,loss=2" or --net-sim=rtt=150,loss=2
const netSimSpec = process.argv.find((a) => a.startsWith('--net-sim='))?.slice('--net-sim='.length) ?? process.env.NET_SIM;
const netSim = dev ? parseNetSim(netSimSpec) : null;

const server = await createServer(port, {
  dev,
  dummies: true,
  seed: Number(process.env.SEED ?? 1),
  ...(netSim ? { netSim: { settings: netSim, scheduler: nodeScheduler } } : {}),
});
console.log(
  `[game-server] room "${server.room.game.map.id}" on ws://localhost:${server.port} · transport ${server.transport === 'uws' ? 'uWebSockets.js' : 'ws (fallback)'} · dev commands ${dev ? 'on' : 'off'}` +
    (netSim ? ` · NET_SIM ${describeNetSim(netSim)}` : ''),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
