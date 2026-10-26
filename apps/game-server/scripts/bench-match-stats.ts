/**
 * What the play stats (src/matchStats.ts, docs/16 §3.2) cost the room's tick: a match room with 2
 * people and bots filling it to 8 runs the same seeded match with and without a stats sink, the two
 * interleaved over several rounds; it prints each variant's mean and p99 tick time, and the time
 * spent inside the stats themselves (onMatchEvents, joins and leaves) per tick.
 * Run: pnpm --filter @military-forge/game-server exec tsx scripts/bench-match-stats.ts [ticks=7200] [rounds=6]
 */
import { warmNavGraphs } from '@military-forge/bots';
import { maps } from '@military-forge/content';
import { CmdKind, encodeCmd, encodeHello } from '@military-forge/protocol';
import { MatchStats } from '../src/matchStats';
import { Room, type ClientConn } from '../src/room';

const ticks = Number(process.argv[2] ?? 7200);
const rounds = Number(process.argv[3] ?? 6);
const mapId = 'street-market';
warmNavGraphs([maps[mapId]!]);

let inStats = 0;
const original = MatchStats.prototype.onMatchEvents;
MatchStats.prototype.onMatchEvents = function (...args: Parameters<typeof original>) {
  const t0 = performance.now();
  original.apply(this, args);
  inStats += performance.now() - t0;
};

const conn = (): ClientConn => ({ send() {}, close() {}, bufferedAmount: () => 0 });

function run(withStats: boolean): { times: number[]; reports: number; statsMs: number; kills: number } {
  let reports = 0;
  const sink = { reportStats: () => void reports++ };
  const room = new Room({ dummies: false, dev: false, mapId, seed: 7, match: { countdown: 1, timeLimit: 600, killLimit: 0, ending: 1 }, fillBots: { target: 8, level: 'hard' }, ...(withStats ? { stats: sink, code: 'BENCH1' } : {}) });
  const clients = ['Ade', 'Kemi'].map((n) => {
    const c = room.connect(conn());
    room.receive(c, encodeHello(n));
    return c;
  });
  for (const c of clients) room.receive(c, encodeCmd(CmdKind.Ready, '1'));
  for (let i = 0; i < 120; i++) room.tick(); // countdown, warm-up
  inStats = 0;
  const times: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    room.tick();
    times.push(performance.now() - t0);
  }
  const kills = room.match!.standings().reduce((a, x) => a + x.kills + x.suicides, 0);
  return { times, reports, statsMs: inStats, kills };
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p99: s[Math.floor(s.length * 0.99)]! };
};

const all: Record<'off' | 'on', number[]> = { off: [], on: [] };
let statsMs = 0;
let kills = 0;
run(true); // JIT warm-up
for (let r = 0; r < rounds; r++) {
  for (const v of r % 2 ? (['on', 'off'] as const) : (['off', 'on'] as const)) {
    const out = run(v === 'on');
    all[v].push(...out.times);
    if (v === 'on') {
      statsMs += out.statsMs;
      kills += out.kills;
    }
  }
}
const off = stats(all.off);
const on = stats(all.on);
console.log(`${rounds} rounds × ${ticks} ticks, ${mapId}, 2 people + bots to 8 (hard): ${kills} deaths through the stats`);
console.log(`without stats: mean ${(off.mean * 1000).toFixed(1)} µs, p99 ${(off.p99 * 1000).toFixed(1)} µs`);
console.log(`with stats:    mean ${(on.mean * 1000).toFixed(1)} µs, p99 ${(on.p99 * 1000).toFixed(1)} µs`);
console.log(`inside MatchStats.onMatchEvents: ${((statsMs / (rounds * ticks)) * 1000).toFixed(3)} µs per tick (${((statsMs / (rounds * ticks) / on.mean) * 100).toFixed(3)} % of the tick)`);
