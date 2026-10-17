/**
 * Packet-level network impairment for WebTransport (QUIC) tests: a UDP proxy that delays, jitters
 * and drops real datagrams in each direction, so QUIC's own loss recovery is what's measured (the
 * in-app conditioner works on whole game messages instead).
 *
 *   browser ⇄ 127.0.0.1:<listen> (this proxy) ⇄ 127.0.0.1:<target> (wt-gateway)
 *
 * Run: pnpm --filter @military-forge/game-server exec tsx scripts/udp-impair.ts --listen 4434 --target 4433 --rtt 150 --loss 2 --jitter 5
 * and start the gateway with WT_PUBLIC_URL=https://127.0.0.1:4434/wt so browsers come through here.
 */
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';

const arg = (name: string, d: number) => Number(process.argv.find((_, i) => process.argv[i - 1] === `--${name}`) ?? d);
const listen = arg('listen', 4434);
const target = arg('target', 4433);
const oneWay = arg('rtt', 150) / 2;
const jitter = arg('jitter', 5);
const loss = arg('loss', 2) / 100;

const front = createSocket('udp4');
const upstreams = new Map<string, Socket>();
const stats = { up: 0, down: 0, upDropped: 0, downDropped: 0 };
const delay = () => Math.max(0, oneWay + jitter * (2 * Math.random() - 1));

front.on('message', (msg: Buffer, from: RemoteInfo) => {
  const key = `${from.address}:${from.port}`;
  let up = upstreams.get(key);
  if (!up) {
    const sock = createSocket('udp4');
    sock.on('message', (reply: Buffer) => {
      stats.down++;
      if (Math.random() < loss) return void stats.downDropped++;
      setTimeout(() => front.send(reply, from.port, from.address), delay());
    });
    sock.connect(target, '127.0.0.1');
    upstreams.set(key, sock);
    up = sock;
  }
  stats.up++;
  if (Math.random() < loss) return void stats.upDropped++;
  const sock = up;
  setTimeout(() => sock.send(msg), delay());
});

front.bind(listen, '127.0.0.1', () => {
  console.log(`[udp-impair] 127.0.0.1:${listen} → 127.0.0.1:${target} · ${oneWay}±${jitter} ms each way · ${loss * 100}% loss each way`);
});
setInterval(() => {
  console.log(`[udp-impair] up ${stats.up} (${stats.upDropped} dropped) · down ${stats.down} (${stats.downDropped} dropped) · ${upstreams.size} client(s)`);
}, 10_000);
