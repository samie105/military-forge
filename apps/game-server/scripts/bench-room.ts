/**
 * Room tick benchmark: N humans (fake connections) + the map's dummies, inputs every tick,
 * snapshots encoded every 2nd tick exactly as in production. The fake clients encode into reused
 * buffers so the numbers (and the GC pauses) are the server's own.
 * Fake clients ack each snapshot 5 snapshots (~150 ms) after it was sent, like a client at
 * 150 ms RTT, so the server delta-compresses against acked baselines (docs/05 §11).
 * Run: pnpm --filter @military-forge/game-server bench [humans=2] [ticks=6000] [--no-delta] [--no-aoi]
 */
import { PerformanceObserver, constants, type PerformanceEntry } from 'node:perf_hooks';
import { BitWriter, MsgType, encodeHello, encodeInputInto } from '@military-forge/protocol';
import { Btn, createInput } from '@military-forge/sim';
import { Room, type ClientConn } from '../src/room';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const humans = Number(args[0] ?? 2);
const ticks = Number(args[1] ?? 6000);
const delta = !process.argv.includes('--no-delta');
const aoi = !process.argv.includes('--no-aoi');
const ACK_DELAY_SNAPSHOTS = 5;
const gcPauses: number[] = [];
let majorGcs = 0;
const gc = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcPauses.push(e.duration);
    if ((e as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) majorGcs++;
  }
});
gc.observe({ entryTypes: ['gc'] });

const room = new Room({ dummies: true, maxHumans: 16, aoi });
let bytesOut = 0;
let snapshotBytes = 0;
let snapshots = 0;
const clients = Array.from({ length: humans }, (_, i) => {
  const received: number[] = [];
  const conn: ClientConn = {
    send: (b) => {
      bytesOut += b.length;
      if (b[0] !== MsgType.Snapshot) return;
      snapshotBytes += b.length;
      snapshots++;
      received.push(b[1]! | (b[2]! << 8)); // seq
    },
    close: () => {},
    bufferedAmount: () => 0,
  };
  const client = room.connect(conn);
  room.receive(client, encodeHello(`p${i}`));
  return { client, received, writer: new BitWriter(64), inputs: [createInput(), createInput(), createInput(), createInput()] };
});
const packet = { newestTick: 0, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [] as ReturnType<typeof createInput>[] };

const tickTimes: number[] = [];
const totalTimes: number[] = [];
for (let t = 1; t <= ticks; t++) {
  if (t % 60 === 0) room.resetRateLimits(); // the real server does this every second
  const t0 = performance.now();
  clients.forEach((c, i) => {
    // newest first, 4× redundancy like the real client; tagged one tick ahead of the server
    for (let k = c.inputs.length - 1; k > 0; k--) Object.assign(c.inputs[k]!, c.inputs[k - 1]);
    const input = c.inputs[0]!;
    input.buttons = (t % 120 < 60 ? Btn.Right : Btn.Left) | (t % 90 < 30 ? Btn.Jet : 0) | (t % 7 === 0 ? Btn.Fire : 0) | (t % 300 === i ? Btn.Grenade : 0);
    input.aim = (t * 97) & 0xffff;
    packet.newestTick = t & 0xffff;
    packet.ackSnapshotSeq = delta && c.received.length > ACK_DELAY_SNAPSHOTS ? c.received[c.received.length - 1 - ACK_DELAY_SNAPSHOTS]! : 0;
    packet.inputs = c.inputs;
    room.receive(c.client, encodeInputInto(c.writer, packet, Math.min(4, t)));
  });
  const t1 = performance.now();
  room.tick();
  const t2 = performance.now();
  tickTimes.push(t2 - t1);
  totalTimes.push(t2 - t0);
}
await new Promise((r) => setTimeout(r, 50)); // let the GC observer flush
gc.disconnect();

const stats = (times: number[]) => {
  const warm = times.slice(Math.min(600, times.length >> 1)).sort((a, b) => a - b);
  const pct = (p: number) => warm[Math.min(warm.length - 1, Math.floor(p * warm.length))]!.toFixed(3);
  return `avg ${(warm.reduce((a, b) => a + b, 0) / warm.length).toFixed(3)} · p50 ${pct(0.5)} · p99 ${pct(0.99)} · max ${pct(1)}`;
};
console.log(`${room.humanCount} humans + ${room.game.playerCount() - room.humanCount} dummies, ${ticks} ticks · delta ${delta ? 'on' : 'off'} · AOI ${aoi ? 'on' : 'off'}`);
console.log(`  tick ms:           ${stats(tickTimes)}`);
console.log(`  receive+tick ms:   ${stats(totalTimes)}`);
console.log(
  `  GC: ${gcPauses.length} pauses (${majorGcs} major), ${gcPauses.reduce((a, b) => a + b, 0).toFixed(1)} ms total, max ${Math.max(0, ...gcPauses).toFixed(2)} ms` +
    ` · inputs used ${clients.reduce((n, c) => n + c.client.inputs.used, 0)}, missed ${clients.reduce((n, c) => n + c.client.inputs.missed, 0)}`,
);
console.log(
  `  snapshot KB/s per client: ${(bytesOut / humans / (ticks / 60) / 1024).toFixed(1)} · avg snapshot ${(snapshotBytes / Math.max(1, snapshots)).toFixed(0)} B`,
);
