/**
 * Simulated-network harness: NetClients (prediction, clock sync, pacing) ↔ network conditioner ↔
 * a real Room, on a manual clock, so a minute of play runs in ~100 ms and is reproducible.
 * Used by test/netcode.test.ts and `pnpm --filter @military-forge/game-server netsim`.
 */
import { MsgType, isUnreliableMessage } from '@military-forge/protocol';
import { ConditionedLink, ManualScheduler, NetClient, type ConditionerSettings, type Scheduler } from '@military-forge/netcode';
import { Btn, type Input } from '@military-forge/sim';
import { Room, type Client, type RoomOptions } from '../src/room';

const TICK_MS = 1000 / 60;

/** Walk right, jet, walk left, hover-tap, crouch, idle: a 6 s loop of the movement we care about. */
export function movement(tMs: number, phase: number): number {
  const t = (tMs + phase) % 6000;
  if (t < 1500) return Btn.Right;
  if (t < 2100) return Btn.Jet | Btn.Right;
  if (t < 3600) return Btn.Left;
  if (t < 4800) return t % 400 < 150 ? Btn.Jet : 0;
  if (t < 5200) return Btn.Down;
  return 0;
}

export interface ClientResult {
  net: NetClient;
  server: Client;
  /** counted after warm-up */
  corrections: number;
  mispredictions: number;
  resyncs: number;
  /** ticks the server had to repeat an input because this client's was late or lost */
  missedInputs: number;
  /** bytes delivered to this client after warm-up, per second */
  downBytesPerSec: number;
  /** messages and payload bytes this client sent after warm-up, per second */
  upPacketsPerSec: number;
  upBytesPerSec: number;
  /** how old snapshots were on arrival (ms, after warm-up): p50 / p99 */
  snapshotAgeP50: number;
  snapshotAgeP99: number;
  /** % of frames where remote players had to be held (render tick past the newest snapshot) */
  interpStallPct: number;
}

export interface SimResult {
  clients: ClientResult[];
  /** client 0's latest health report, sampled every 100 ms after warm-up */
  healths: number[];
  timeScales: number[];
  /** client 0: predicted tick − server tick, sampled every 100 ms */
  leadTicks: number[];
  minutes: number;
}

export interface SimOptions {
  warmupSeconds?: number;
  /** server tick wake-up noise (±ms) */
  serverJitterMs?: number;
  /** render frame noise (±ms) */
  frameJitterMs?: number;
  /** client frame interval (default 1 tick: 60 fps); 33 = 30 fps, two ticks sampled per frame */
  frameMs?: number;
  /**
   * Client 0's tab goes to the background for [fromMs, toMs): frames drop to 1 Hz and its timers
   * (the conditioner's) only fire on 1 s boundaries, like Chrome's background throttling.
   */
  sleep?: { fromMs: number; toMs: number };
  /**
   * Client 0's connection drops at fromMs (the server sees the socket close, packets in flight are
   * lost) and a new one opens at toMs, presenting the session token.
   */
  drop?: { fromMs: number; toMs: number };
  /**
   * Client 0's connection stalls for [fromMs, toMs) and then recovers, like a TCP path that went
   * dead for a while: the socket stays open, nothing arrives either way, and at toMs everything held
   * is delivered at once, in order (a stream keeps what it couldn't send).
   */
  stall?: { fromMs: number; toMs: number };
  /** every message a client hands its transport */
  onSend?: (k: number, bytes: Uint8Array, nowMs: number) => void;
  /** bytes client k's transport reports queued (WebSocket bufferedAmount; default 0) */
  backlog?: (k: number, nowMs: number) => number;
  /** room options (default: dummies on, seed 3) */
  room?: RoomOptions;
  /** each client's input for one tick (default: the movement loop) */
  input?: (k: number, nowMs: number, net: NetClient, out: Input) => void;
  /** called before every server tick (place players, heal targets, count shots…) */
  beforeTick?: (room: Room, nets: NetClient[]) => void;
  /** called after every server tick */
  afterTick?: (room: Room, nets: NetClient[]) => void;
  /** these clients run in low-bandwidth mode (docs/05 §2.2) */
  lowBandwidth?: number[];
  /**
   * 'wt' (default): datagrams, lost unreliable messages are gone (WebTransport).
   * 'ws': a TCP stream, losses are retransmitted and stall everything behind them (WebSocket).
   */
  transport?: 'ws' | 'wt';
}

/** Defers callbacks to the next whole second while `asleep()` (background-tab timer alignment). */
function throttled(base: Scheduler, asleep: () => boolean): Scheduler {
  return {
    now: () => base.now(),
    clearTimeout: (h) => base.clearTimeout((h as { id: unknown }).id),
    setTimeout(fn, ms) {
      const handle = { id: null as unknown };
      const fire = () => {
        if (asleep()) {
          const now = base.now();
          handle.id = base.setTimeout(fire, Math.ceil((now + 1) / 1000) * 1000 - now);
        } else fn();
      };
      handle.id = base.setTimeout(fire, ms);
      return handle;
    },
  };
}

function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function simulate(settings: ConditionerSettings, seconds: number, options: SimOptions = {}): SimResult {
  const warmupSeconds = options.warmupSeconds ?? 10;
  const serverJitterMs = options.serverJitterMs ?? 1;
  const frameJitterMs = options.frameJitterMs ?? 1.5;
  const clock = new ManualScheduler();
  const sleep = options.sleep;
  const asleep = () => !!sleep && clock.now() >= sleep.fromMs && clock.now() < sleep.toMs;
  const room = new Room({ dummies: true, seed: 3, ...options.room });
  if (options.transport === 'ws') {
    settings = { ...settings, up: { ...settings.up, stream: true }, down: { ...settings.down, stream: true } };
  }
  const snapshotAges: number[][] = [[], []];
  const stallFrames = [0, 0];
  const frames = [0, 0];
  const nets: NetClient[] = [];
  const conns: Client[] = [];
  const ups: ConditionedLink[] = [];
  const downs: ConditionedLink[] = [];
  const downBytes = [0, 0];
  const upBytes = [0, 0];
  const upPackets = [0, 0];
  const stall = options.stall;
  let stalled = false;
  const heldBack: (() => void)[] = [];
  /** client 0's deliveries wait while its connection is stalled */
  const deliver = (k: number, fn: () => void) => {
    if (k === 0 && stalled) heldBack.push(fn);
    else fn();
  };
  if (stall) {
    clock.setTimeout(() => (stalled = true), stall.fromMs);
    clock.setTimeout(() => {
      stalled = false;
      for (const fn of heldBack.splice(0)) fn();
    }, stall.toMs);
  }
  /** a connection for client k: a server Client plus a conditioned link each way */
  const wire = (k: number, seed: number) => {
    let down: ConditionedLink | null = null;
    const conn = room.connect({ send: (b) => down!.send(b), close: () => {}, bufferedAmount: () => 0 });
    const timers = k === 0 ? throttled(clock, asleep) : clock;
    ups[k] = new ConditionedLink(settings.up, () => settings.enabled, timers, (b) => deliver(k, () => room.receive(conn, b)), isUnreliableMessage, seed + 11 + k);
    down = new ConditionedLink(
      settings.down,
      () => settings.enabled,
      timers,
      (b) =>
        deliver(k, () => {
          if (clock.now() > warmupSeconds * 1000) {
            downBytes[k]! += b.length;
            if (b[0] === MsgType.Snapshot) snapshotAges[k]!.push(clock.now() - (b[3]! | (b[4]! << 8) | (b[5]! << 16) | (b[6]! << 24)) * TICK_MS);
          }
          nets[k]!.receive(b);
        }),
      isUnreliableMessage,
      seed + 21 + k,
    );
    downs[k] = down;
    conns[k] = conn;
  };
  for (let k = 0; k < 2; k++) {
    const net = new NetClient({
      name: `p${k}`,
      now: () => clock.now(),
      send: (b) => {
        if (clock.now() > warmupSeconds * 1000) {
          upBytes[k]! += b.length;
          upPackets[k]!++;
        }
        options.onSend?.(k, b, clock.now());
        ups[k]!.send(b);
      },
      stream: () => options.transport === 'ws',
      backlog: () => options.backlog?.(k, clock.now()) ?? 0,
    });
    if (options.lowBandwidth?.includes(k)) net.setLowBandwidth(true);
    nets.push(net);
    wire(k, 0);
  }
  nets.forEach((c, k) => clock.setTimeout(() => c.onOpen(), 30 * k));
  if (options.drop) {
    const { fromMs, toMs } = options.drop;
    clock.setTimeout(() => {
      ups[0]!.dispose();
      downs[0]!.dispose();
      room.disconnect(conns[0]!);
      nets[0]!.onClose();
    }, fromMs);
    clock.setTimeout(() => {
      wire(0, 100);
      nets[0]!.onOpen();
    }, toMs);
  }

  let rng = 12345;
  const noise = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  let serverTicks = 0;
  let nextTick = TICK_MS + noise() * serverJitterMs;
  const nextFrame = [5, 11];
  const lastFrame = [0, 0];
  const healths: number[] = [];
  const timeScales: number[] = [];
  const leadTicks: number[] = [];
  const base = nets.map(() => ({ corrections: 0, mispredictions: 0, resyncs: 0, missed: 0 }));
  const input = (k: number) => (_me: unknown, out: Input) => {
    out.aim = 0;
    out.weaponSelect = 0;
    out.throwStrength = 7;
    if (options.input) options.input(k, clock.now(), nets[k]!, out);
    else out.buttons = movement(clock.now(), k * 1700);
  };

  const end = seconds * 1000;
  for (let now = 1; now <= end; now++) {
    clock.advance(1);
    // server: 60 Hz on its own clock, waking up to ±serverJitter late/early
    while (now >= nextTick) {
      options.beforeTick?.(room, nets);
      room.tick();
      options.afterTick?.(room, nets);
      serverTicks++;
      nextTick = (serverTicks + 1) * TICK_MS + noise() * serverJitterMs;
    }
    if (now % 1000 === 0) room.resetRateLimits(); // as the real server does
    // clients: ~60 fps frames, each with its own phase and noise (rAF is not tick-aligned)
    for (let k = 0; k < nets.length; k++) {
      if (now < nextFrame[k]!) continue;
      nets[k]!.update((now - lastFrame[k]!) / 1000, input(k));
      const view = nets[k]!.remoteRenderTick(now); // "draw" the frame: the next input reports this view
      const newest = nets[k]!.snapshots.at(-1)?.msg.serverTick;
      if (now > warmupSeconds * 1000 && newest !== undefined) {
        frames[k]!++;
        if (view > newest) stallFrames[k]!++;
      }
      lastFrame[k] = now;
      nextFrame[k] = k === 0 && asleep() ? Math.ceil((now + 1) / 1000) * 1000 : now + (options.frameMs ?? TICK_MS) + noise() * frameJitterMs;
    }
    if (now === warmupSeconds * 1000) {
      nets.forEach((c, k) => {
        base[k] = { corrections: c.predictor!.stats.corrections, mispredictions: c.predictor!.stats.mispredictions, resyncs: c.pacer.resyncs, missed: conns[k]!.inputs.missed };
      });
    }
    if (now > warmupSeconds * 1000 && now % 100 === 0) {
      const c = nets[0]!;
      healths.push(c.pacer.health);
      timeScales.push(c.pacer.timeScale);
      leadTicks.push(c.predictor!.tick - room.game.tick);
    }
  }
  return {
    clients: nets.map((net, k) => ({
      net,
      server: conns[k]!,
      corrections: net.predictor!.stats.corrections - base[k]!.corrections,
      mispredictions: net.predictor!.stats.mispredictions - base[k]!.mispredictions,
      resyncs: net.pacer.resyncs - base[k]!.resyncs,
      missedInputs: conns[k]!.inputs.missed - base[k]!.missed,
      downBytesPerSec: downBytes[k]! / (seconds - warmupSeconds),
      upPacketsPerSec: upPackets[k]! / (seconds - warmupSeconds),
      upBytesPerSec: upBytes[k]! / (seconds - warmupSeconds),
      snapshotAgeP50: percentile(snapshotAges[k]!, 0.5),
      snapshotAgeP99: percentile(snapshotAges[k]!, 0.99),
      interpStallPct: (100 * stallFrames[k]!) / Math.max(1, frames[k]!),
    })),
    healths,
    timeScales,
    leadTicks,
    minutes: (seconds - warmupSeconds) / 60,
  };
}
