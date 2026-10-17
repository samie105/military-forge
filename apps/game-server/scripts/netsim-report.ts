/**
 * Netcode under simulated network conditions: 2 clients walking/jetting against a real Room,
 * through the network conditioner, on a manual clock (see test/netsimHarness.ts).
 * Then lag compensation: a shooter on a tower aims at a target walking below, where its screen
 * draws it (test/shootingRange.ts), with and without the server rewinding the target.
 * Run: pnpm --filter @military-forge/game-server netsim [seconds=130]
 */
import { NET_PRESETS, describeNetSim, type ConditionerSettings } from '@military-forge/netcode';
import { simulate } from '../test/netsimHarness';
import { shootingRange } from '../test/shootingRange';

const seconds = Number(process.argv[2] ?? 130);
const reorder = (s: ConditionerSettings): ConditionerSettings => ({ ...s, up: { ...s.up, reorder: true }, down: { ...s.down, reorder: true } });
const profiles: [string, ConditionerSettings][] = [
  ...Object.entries(NET_PRESETS).filter(([name]) => name !== 'off'),
  ['Bad wifi + reordering', reorder(NET_PRESETS['Bad wifi (200 ms, 5%, jitter)']!)],
];

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const pct = (xs: number[], pred: (x: number) => boolean) => ((100 * xs.filter(pred).length) / Math.max(1, xs.length)).toFixed(0);

console.log(`${seconds} s per profile (first 10 s are warm-up), 2 clients walking/jetting/crouching, ws-like in-order delivery unless noted\n`);
console.log('| profile | corrections/min | mispredictions/min | inputs missed/min | health 1–2 | mean lead | RTT | snapshot loss | down KB/s |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [name, settings] of profiles) {
  const t0 = performance.now();
  const r = simulate(settings, seconds);
  const per = (f: (c: (typeof r.clients)[number]) => number) => (mean(r.clients.map(f)) / r.minutes).toFixed(2);
  const s = r.clients[0]!.net.stats();
  console.log(
    `| ${name} | ${per((c) => c.corrections)} | ${per((c) => c.mispredictions)} | ${per((c) => c.missedInputs)} | ${pct(r.healths, (h) => h >= 1 && h <= 2)}% | ${mean(r.leadTicks).toFixed(1)} ticks | ${s.rttMs.toFixed(0)} ms | ${s.snapshotLossPct.toFixed(1)}% | ${(mean(r.clients.map((c) => c.downBytesPerSec)) / 1024).toFixed(2)} |`,
  );
  if (process.env.VERBOSE) console.log(`    ${describeNetSim(settings)} · ${(performance.now() - t0).toFixed(0)} ms wall`);
}

console.log('\nLag compensation: shooter aims at the target where its screen draws it (Hammer .44, target walking 5 m/s, ~36 shots)\n');
console.log('| profile | hits with lag comp | hits without | server pose = screen (< 1 cm) | mean rewind | clamped by the cap |');
console.log('|---|---|---|---|---|---|');
for (const [name, settings] of profiles) {
  const on = shootingRange(settings, true);
  const off = shootingRange(settings, false);
  const exact = on.poseErrors.filter((e) => e < 0.01).length;
  const rewind = mean(on.rewindTicks) * (1000 / 60);
  const rate = (r: typeof on) => `${((100 * r.hits) / Math.max(1, r.shots)).toFixed(0)}%`;
  console.log(`| ${name} | ${rate(on)} | ${rate(off)} | ${exact}/${on.poseErrors.length} | ${rewind.toFixed(0)} ms | ${on.clamped} |`);
}

// WebSocket over TLS over TCP/IP: ~2–6 B frame header + 29 B TLS record + 40 B TCP/IP per message
const FRAMING = 70;
console.log('\nLow-bandwidth mode (docs/05 §2.2): 30 Hz inputs (2 ticks per packet), 15 Hz snapshots; wire bytes include ~70 B framing per message\n');
console.log('| profile | mode | up msgs/s | up KB/s on the wire | down msgs/s | down KB/s on the wire | corrections/min | lag-comp poses exact |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [name, settings] of profiles.filter(([n]) => n.startsWith('Target') || n.startsWith('Mobile'))) {
  const r = simulate(settings, seconds, { lowBandwidth: [0] });
  const lagNormal = shootingRange(settings, true, 40, false);
  const lagSlim = shootingRange(settings, true, 40, true);
  for (const [k, label, lag] of [[1, 'normal', lagNormal], [0, 'low-bandwidth', lagSlim]] as const) {
    const c = r.clients[k]!;
    const downMsgs = 30 / (k === 0 ? 2 : 1) + 1; // snapshots + pongs
    const exact = lag.poseErrors.filter((e) => e < 0.01).length;
    console.log(
      `| ${name} | ${label} | ${c.upPacketsPerSec.toFixed(0)} | ${((c.upBytesPerSec + c.upPacketsPerSec * FRAMING) / 1024).toFixed(2)} | ${downMsgs.toFixed(0)} | ${((c.downBytesPerSec + downMsgs * FRAMING) / 1024).toFixed(2)} | ${(c.corrections / r.minutes).toFixed(2)} | ${exact}/${lag.poseErrors.length} |`,
    );
  }
}

console.log('\nWebSocket (TCP) vs WebTransport (UDP datagrams), docs/05 §2: same loss, but on TCP a lost segment is resent ~1 RTT later and everything behind it waits\n');
console.log('| profile | transport | snapshot age p50 / p99 | frames with interpolation stalled | inputs missed/min | corrections/min | resyncs |');
console.log('|---|---|---|---|---|---|---|');
for (const [name, settings] of profiles.filter(([n]) => !n.startsWith('LAN') && !n.includes('reordering'))) {
  for (const transport of ['ws', 'wt'] as const) {
    const r = simulate(settings, seconds, { transport });
    const c = r.clients[0]!;
    console.log(
      `| ${name} | ${transport === 'ws' ? 'WebSocket' : 'WebTransport'} | ${c.snapshotAgeP50.toFixed(0)} / ${c.snapshotAgeP99.toFixed(0)} ms | ${c.interpStallPct.toFixed(1)}% | ${(c.missedInputs / r.minutes).toFixed(0)} | ${(c.corrections / r.minutes).toFixed(1)} | ${c.resyncs} |`,
    );
  }
}
