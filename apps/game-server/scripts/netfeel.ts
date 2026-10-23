/**
 * How the game feels at high ping (the owner's report, 19 Oct 2026: Nigeria on mobile data to the
 * Johannesburg server). Two clients against a real Room through the network conditioner on a manual
 * clock (test/netsimHarness.ts); client 0 plays a combat loop that uses every action (move, jet,
 * dash, fire, reload, swap, grenade, melee, shield), and the report measures what a player feels:
 *
 *   - own actions: how many the server never did (a press lost to loss or lateness), and how long
 *     an own grenade takes to appear after the throw;
 *   - own movement: corrections, and how big the visible correction (the smoothed offset) gets;
 *     frames where the local player lurched (a hard resync's fast-forward);
 *   - other players: frames where interpolation ran dry (they freeze), the interpolation delay;
 *   - hits: lag compensation's hit rate on a walking target, and how many shots hit the rewind cap;
 *   - data: down KB/s and snapshot sizes.
 *
 * Each profile runs SEEDS times with different loss/jitter/spike draws; the numbers are over all.
 * Run: pnpm --filter @military-forge/game-server netfeel [seconds=120] [profile filter]
 */
import { FEEL_PRESETS, REMOTE_EXTRAPOLATE_TICKS, symmetric, upSpikes, type ConditionerSettings, type NetClient, type RemotePose } from '@military-forge/netcode';
import { Btn, type Input } from '@military-forge/sim';
import { movement, simulate } from '../test/netsimHarness';
import { shootingRange } from '../test/shootingRange';

const seconds = Number(process.argv[2] ?? 120);
const SEEDS = [0, 1, 2];
const only = process.argv[3] ?? '';
const WARMUP_S = 10;
const TICK = 1000 / 60;

/** Client 0's combat loop: the movement loop plus every action on its own beat. */
function combat(tMs: number, out: Input): void {
  let b = movement(tMs, 0);
  const t = Math.floor(tMs / TICK);
  const on = (period: number, phase: number, len = 2) => (t + phase) % period < len;
  if (on(18, 0)) b |= Btn.Fire; // a tap every 300 ms
  if (on(240, 37)) b |= Btn.Reload;
  if (on(300, 91)) b |= Btn.Swap;
  if (on(180, 53, 12)) b |= Btn.Grenade; // hold 200 ms, release: a throw every 3 s
  if (on(210, 140)) b |= Btn.Melee;
  if (on(150, 70)) b |= Btn.Dash;
  if (on(360, 200)) b |= Btn.Shield;
  out.buttons = b;
  out.aim = 0x1800; // up and to the right, thrown hard: grenades land well away from us
  out.throwStrength = 7;
}

interface Feel {
  pressesLost: Record<string, [lost: number, total: number]>;
  grenadeShowMs: number[];
  offsetsCm: number[];
  lurches: number;
  correctionsPerMin: number;
  missedPerMin: number;
  resyncs: number;
  stallPct: number;
  interpMs: number[];
  ageP50: number;
  ageP99: number;
  downKBs: number;
  snapBytes: number[];
  rttP50: number;
  /** own predicted grenades: made, matched to the server's, drawn as the server's after diverging, never shown by the server */
  own: [number, number, number, number];
  /** how fast corrections pull the drawn local player (m/s, per frame) */
  slides: number[];
  /** the other player as drawn vs where the server had it at that render tick (cm, per frame) */
  remoteErrCm: number[];
  /** frames where the other player's drawn motion jumped > 25 cm off its real motion */
  remotePops: number;
  /** % of frames the other player was held still (past the newest snapshot and any extrapolation) */
  heldPct: number;
  /** corrections shown as a jump (too big to slide), a minute */
  jumpsPerMin: number;
}

const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : 0);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

function feel(settings: ConditionerSettings, transport: 'wt' | 'ws', linkSeed: number): Feel {
  // presses: what client 0 predicted vs what the server did, after warm-up
  const predicted: Record<string, number> = { shot: 0, dash: 0, throw: 0 };
  const served: Record<string, number> = { shot: 0, dash: 0, throw: 0 };
  const throwsAt: number[] = [];
  let shownLast = new Set<string>();
  const grenadeShowMs: number[] = [];
  const offsetsCm: number[] = [];
  const interpMs: number[] = [];
  const snapBytes: number[] = [];
  const rtts: number[] = [];
  let lurches = 0;
  let lastSnap: unknown = null;
  let last: { x: number; y: number } | null = null;
  let me = -1;
  const slides: number[] = [];
  const remoteErrCm: number[] = [];
  let remotePops = 0;
  let held = 0;
  let framesSeen = 0;
  let snaps0 = -1;
  /** where the server had the other player, by tick */
  const truth = new Map<number, { x: number; y: number }>();
  let other = -1;
  const drawn: RemotePose = { x: 0, y: 0, src: null! };
  let lastDrawn: { x: number; y: number; tx: number; ty: number } | null = null;
  const warm = (now: number) => now > WARMUP_S * 1000;
  const kinds = (type: string) => (type === 'shot' || type === 'dash' || type === 'throw' ? type : null);
  const r = simulate(settings, seconds, {
    transport,
    linkSeed,
    warmupSeconds: WARMUP_S,
    // every snapshot carries the other player (no area of interest): the smoothness table draws it
    room: { dummies: false, seed: 3, aoi: false },
    input: (k, now, _net, out) => (k === 0 ? combat(now, out) : (out.buttons = movement(now, 1700))),
    beforeTick: (room, nets) => {
      for (const n of nets) {
        const p = n.myId >= 0 ? room.game.players[n.myId] : null;
        if (!p) continue;
        p.hp = room.game.tuning.healthMax; // measuring feel, not kills
        if (p.grenadeCounts[0]! < 2) p.grenadeCounts[0] = 2; // keep a frag to throw
      }
    },
    afterTick: (room, nets) => {
      me = nets[0]!.myId;
      other = nets[1]!.myId;
      const o = other >= 0 ? room.game.players[other] : null;
      if (o) truth.set(room.game.tick, { x: o.x, y: o.y });
      truth.delete(room.game.tick - 600);
      if (!warm(room.game.tick * TICK)) return;
      for (const e of room.game.events) {
        const kind = kinds(e.type);
        const who = 'shooter' in e ? e.shooter : 'player' in e ? e.player : 'owner' in e ? e.owner : -1;
        if (kind && who === me) served[kind]!++;
      }
    },
    onFrame: (k, now, net: NetClient, dt) => {
      if (k !== 0) return;
      for (const e of net.drainEvents()) {
        const kind = kinds(e.type);
        if (!kind || !warm(now)) continue;
        predicted[kind]!++;
        if (kind === 'throw') throwsAt.push(now);
      }
      const newest = net.snapshots.at(-1);
      if (newest && newest !== lastSnap && warm(now)) snapBytes.push(newest.bytes);
      lastSnap = newest;
      const shown = new Set<string>();
      for (const g of net.grenadeViews(now)) {
        if (g.owner !== net.myId) continue;
        shown.add(g.key);
        if (shownLast.has(g.key)) continue;
        // a throw the server never made shows nothing: skip throws older than any real delay
        while (throwsAt.length > 0 && now - throwsAt[0]! > 3000) throwsAt.shift();
        const at = throwsAt.shift();
        if (at !== undefined) grenadeShowMs.push(now - at);
      }
      shownLast = shown;
      const pred = net.predictor;
      if (!pred?.started || !warm(now)) return;
      slides.push(pred.lastSlideM / Math.max(1e-3, dt));
      if (snaps0 < 0) snaps0 = pred.stats.snaps;
      // the other player: drawn where, and where the server had it at that render tick
      const view = net.viewTick;
      const newestTick = net.snapshots.at(-1)?.msg.serverTick;
      if (other >= 0 && newestTick !== undefined && !Number.isNaN(view)) {
        framesSeen++;
        if (view > newestTick + REMOTE_EXTRAPOLATE_TICKS) held++;
        const t0 = truth.get(Math.floor(view));
        const t1 = truth.get(Math.floor(view) + 1);
        if (t0 && t1 && net.remotePose(other, view, drawn)) {
          const f = view - Math.floor(view);
          const tx = t0.x + (t1.x - t0.x) * f;
          const ty = t0.y + (t1.y - t0.y) * f;
          remoteErrCm.push(100 * Math.hypot(drawn.x - tx, drawn.y - ty));
          if (lastDrawn && Math.hypot(tx - lastDrawn.tx, ty - lastDrawn.ty) < 3) {
            const off = Math.hypot(drawn.x - lastDrawn.x - (tx - lastDrawn.tx), drawn.y - lastDrawn.y - (ty - lastDrawn.ty));
            if (off > 0.25) remotePops++;
          }
          lastDrawn = { x: drawn.x, y: drawn.y, tx, ty };
        } else lastDrawn = null;
      }
      offsetsCm.push(100 * Math.hypot(pred.offset.x, pred.offset.y));
      interpMs.push(net.interpDelay);
      rtts.push(net.rtt.median);
      const pos = pred.renderPosition(net.alpha, { x: 0, y: 0 });
      // faster than anything but a teleport moves in one frame (a blast launch tops out ~26 m/s)
      if (last && pred.player.alive && Math.hypot(pos.x - last.x, pos.y - last.y) > Math.max(0.6, 30 * dt) && Math.hypot(pos.x - last.x, pos.y - last.y) < 3) lurches++;
      last = pos;
    },
  });
  const c = r.clients[0]!;
  // snapshot sizes: from the per-snapshot record the client keeps
  const pressesLost: Feel['pressesLost'] = {};
  for (const k of Object.keys(predicted)) pressesLost[k] = [Math.max(0, predicted[k]! - served[k]!), predicted[k]!];
  return {
    pressesLost,
    grenadeShowMs,
    offsetsCm,
    lurches,
    correctionsPerMin: c.corrections / r.minutes,
    missedPerMin: c.missedInputs / r.minutes,
    resyncs: c.resyncs,
    stallPct: c.interpStallPct,
    interpMs,
    ageP50: c.snapshotAgeP50,
    ageP99: c.snapshotAgeP99,
    downKBs: c.downBytesPerSec / 1024,
    snapBytes,
    rttP50: pct(rtts, 0.5),
    own: ownStats(c.net),
    slides,
    remoteErrCm,
    remotePops,
    heldPct: (100 * held) / Math.max(1, framesSeen),
    jumpsPerMin: (c.net.predictor!.stats.snaps - Math.max(0, snaps0)) / r.minutes,
  };
}

function ownStats(net: NetClient): [number, number, number, number] {
  const s = (net as { ownShots?: { stats: { predicted: number; matched: number; diverged: number; unmatched: number } } | null }).ownShots?.stats;
  return s ? [s.predicted, s.matched, s.diverged, s.unmatched] : [0, 0, 0, 0];
}

/** all seeds' runs as one */
function feelOver(settings: ConditionerSettings, via: 'wt' | 'ws'): Feel {
  const runs = SEEDS.map((seed) => feel(settings, via, seed));
  const all = <T>(f: (x: Feel) => T[]) => runs.flatMap(f);
  const avg = (f: (x: Feel) => number) => mean(runs.map(f));
  const pressesLost: Feel['pressesLost'] = {};
  for (const k of Object.keys(runs[0]!.pressesLost)) pressesLost[k] = [runs.reduce((a, r) => a + r.pressesLost[k]![0], 0), runs.reduce((a, r) => a + r.pressesLost[k]![1], 0)];
  return {
    pressesLost,
    grenadeShowMs: all((r) => r.grenadeShowMs),
    offsetsCm: all((r) => r.offsetsCm),
    lurches: runs.reduce((a, r) => a + r.lurches, 0),
    correctionsPerMin: avg((r) => r.correctionsPerMin),
    missedPerMin: avg((r) => r.missedPerMin),
    resyncs: runs.reduce((a, r) => a + r.resyncs, 0),
    stallPct: avg((r) => r.stallPct),
    interpMs: all((r) => r.interpMs),
    ageP50: avg((r) => r.ageP50),
    ageP99: avg((r) => r.ageP99),
    downKBs: avg((r) => r.downKBs),
    snapBytes: all((r) => r.snapBytes),
    rttP50: avg((r) => r.rttP50),
    own: [0, 1, 2, 3].map((i) => runs.reduce((a, r) => a + r.own[i]!, 0)) as Feel['own'],
    slides: all((r) => r.slides),
    remoteErrCm: all((r) => r.remoteErrCm),
    remotePops: runs.reduce((a, r) => a + r.remotePops, 0),
    heldPct: avg((r) => r.heldPct),
    jumpsPerMin: avg((r) => r.jumpsPerMin),
  };
}

// what a box in Lagos might give the same phone (docs/09 §4.1): MTN peers at IXPN in Lagos, so the
// path loses the detour; the phone's own upload queue (the spikes) stays if that's where they come from
const LAGOS: [string, ConditionerSettings][] = [
  ['Lagos box, est. (90 ms ±25, no spikes)', symmetric(90, 0, 25)],
  ['Lagos box, est. (90 ms, same spikes)', upSpikes(symmetric(90, 0, 25), 1000, 7000, 2500)],
];
const profiles = [...Object.entries(FEEL_PRESETS), ...LAGOS].filter(([n]) => n.toLowerCase().includes(only.toLowerCase()));
console.log(`${SEEDS.length} runs × ${seconds} s per profile (first ${WARMUP_S} s of each warm-up); client 0 plays every action; WT = datagrams, WS = TCP retransmits (only with loss)\n`);
console.log('| profile | via | presses lost (shot · dash · throw) | own grenade shows after (p50 / max) · predicted: matched, diverged, never on server | corrections/min | visible correction p99 / max | lurches | inputs missed/min | resyncs | remote past the newest snapshot | interp delay | RTT seen | down KB/s · snapshot B p50/p95 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
const feels: [string, Feel, 'wt' | 'ws'][] = [];
for (const [name, settings] of profiles) {
  for (const via of ['wt', 'ws'] as const) {
    if (via === 'ws' && !settings.up.lossPct && !settings.down.lossPct) continue; // no loss: the same as WT
    const f = feelOver(settings, via);
    feels.push([name, f, via]);
    const lost = ['shot', 'dash', 'throw'].map((k) => `${f.pressesLost[k]![0]}/${f.pressesLost[k]![1]}`).join(' · ');
    console.log(
      `| ${name} | ${via.toUpperCase()} | ${lost} | ${pct(f.grenadeShowMs, 0.5).toFixed(0)} / ${Math.max(0, ...f.grenadeShowMs).toFixed(0)} ms${f.own[0] ? ` · ${f.own[1]}/${f.own[0]}, ${f.own[2]}, ${f.own[3]}` : ''} | ${f.correctionsPerMin.toFixed(1)} | ${pct(f.offsetsCm, 0.99).toFixed(1)} / ${Math.max(0, ...f.offsetsCm).toFixed(0)} cm | ${f.lurches} | ${f.missedPerMin.toFixed(0)} | ${f.resyncs} | ${f.stallPct.toFixed(1)}% | ${mean(f.interpMs).toFixed(0)} ms | ${f.rttP50.toFixed(0)} ms | ${f.downKBs.toFixed(1)} · ${pct(f.snapBytes, 0.5)}/${pct(f.snapBytes, 0.95)} |`,
    );
  }
}

console.log('\nSmoothness: corrections as felt (how fast they pull the drawn local player), and the other player as drawn (vs where the server had it at that render tick)\n');
console.log('| profile | via | correction pull p99 / max | visible correction p99 / max | corrections shown as a jump /min | other player held still | other player off p50 / p99 / max | other player pops (> 25 cm a frame) /min |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [name, f, via] of feels) {
  const minutes = (SEEDS.length * (seconds - WARMUP_S)) / 60;
  console.log(
    `| ${name} | ${via.toUpperCase()} | ${pct(f.slides, 0.99).toFixed(2)} / ${Math.max(0, ...f.slides).toFixed(1)} m/s | ${pct(f.offsetsCm, 0.99).toFixed(1)} / ${Math.max(0, ...f.offsetsCm).toFixed(0)} cm | ${f.jumpsPerMin.toFixed(1)} | ${f.heldPct.toFixed(1)}% | ${pct(f.remoteErrCm, 0.5).toFixed(0)} / ${pct(f.remoteErrCm, 0.99).toFixed(0)} / ${Math.max(0, ...f.remoteErrCm).toFixed(0)} cm | ${(f.remotePops / minutes).toFixed(1)} |`,
  );
}

if (process.env.NETFEEL_NO_HITS) process.exit(0);
console.log('\nHits: a shooter on a tower taps at a target walking 5 m/s below, aiming where its screen draws it (WT). "Moved": how far the target had gone since the pose the shot was tested at (p50 / p95), what a target feels as being hit late\n');
console.log('| profile | hits | shots that hit the rewind cap | mean rewind | moved | hits with the old trial box (900 ms total) | moved |');
console.log('|---|---|---|---|---|---|---|');
for (const [name, settings] of profiles) {
  const range = (lagComp: true | { maxRewindMs: number }) => {
    const runs = SEEDS.map((linkSeed) => shootingRange({ ...settings }, lagComp, 60, false, undefined, 0, linkSeed));
    const shots = runs.reduce((a, r) => a + r.shots, 0);
    const moved = runs.flatMap((r) => r.moved);
    return {
      shots,
      rate: `${((100 * runs.reduce((a, r) => a + r.hits, 0)) / Math.max(1, shots)).toFixed(0)}%`,
      clamped: runs.reduce((a, r) => a + r.clamped, 0),
      rewind: mean(runs.flatMap((r) => r.rewindTicks)) * TICK,
      moved: `${pct(moved, 0.5).toFixed(2)} / ${pct(moved, 0.95).toFixed(2)} m`,
    };
  };
  const d = range(true);
  const wide = range({ maxRewindMs: 900 });
  console.log(`| ${name} | ${d.rate} of ${d.shots} | ${d.clamped} | ${d.rewind.toFixed(0)} ms | ${d.moved} | ${wide.rate} (${wide.clamped} capped) | ${wide.moved} |`);
}
