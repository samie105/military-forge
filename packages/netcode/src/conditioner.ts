/**
 * Network conditioner (docs/05 §15.2): adds latency, jitter, loss and duplication to one direction
 * of a connection. The client wraps its WebSocket with two of these (up + down); the server can
 * condition every connection with a flag. Only unreliable messages (INPUT, PING, PONG, SNAPSHOT)
 * are dropped or duplicated; reliable ones are only delayed, in order.
 *
 * Runtime-agnostic: time and timers are injected (browser, Node, or a fake clock in tests), and
 * randomness is seeded, so a test run is reproducible.
 */
import { Xoshiro128 } from '@military-forge/shared';

export interface LinkSettings {
  /** one-way delay, ms */
  latencyMs: number;
  /** ± uniform jitter added to the delay, ms */
  jitterMs: number;
  /** 0..100 */
  lossPct: number;
  /** 0..100: extra copy of an unreliable message, with its own delay */
  dupPct: number;
  /** let unreliable messages overtake each other (UDP-like); off = in-order like TCP/WebSocket */
  reorder: boolean;
  /**
   * Model a TCP stream (WebSocket) instead of datagrams: nothing is dropped, but a lost message is
   * resent about one round trip later and everything behind it waits (head-of-line blocking).
   * Off = datagram-like (WebTransport): lost unreliable messages are simply gone.
   */
  stream?: boolean;
  /** extra delay of a retransmitted message in stream mode, ms (default ≈ one RTT: 2 × latency, ≥ 40) */
  retransmitMs?: number;
  /**
   * Loss comes in bursts (a Gilbert–Elliott model): mean length of a bad spell, ms. During a spell
   * BURST_LOSS_PCT of messages are lost, outside it none; `lossPct` stays the long-run average.
   * 0 / unset: independent losses.
   */
  burstMs?: number;
  /**
   * Latency spikes (a mobile uplink's queue filling up, "bufferbloat"): extra one-way delay at a
   * spike's peak, ms. Messages stay in order through a spike (a queue is a queue). 0 / unset: none.
   */
  spikeMs?: number;
  /** mean time between spike starts, ms (default 8000) */
  spikeEveryMs?: number;
  /** how long one spike lasts, ms (default 1500) */
  spikeLengthMs?: number;
}

/** loss inside a burst (burstMs): the bursts are as long and as frequent as the average needs */
export const BURST_LOSS_PCT = 60;

export interface ConditionerSettings {
  enabled: boolean;
  /** client → server */
  up: LinkSettings;
  /** server → client */
  down: LinkSettings;
}

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Timers on a manual clock: advance() runs everything due, in time order (tests, simulations). */
export class ManualScheduler implements Scheduler {
  time = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.time + Math.max(0, ms), fn, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let next = -1;
      for (let i = 0; i < this.timers.length; i++) {
        const t = this.timers[i]!;
        if (t.at <= end && (next < 0 || t.at < this.timers[next]!.at || (t.at === this.timers[next]!.at && t.id < this.timers[next]!.id))) next = i;
      }
      if (next < 0) break;
      const [timer] = this.timers.splice(next, 1);
      this.time = Math.max(this.time, timer!.at);
      timer!.fn();
    }
    this.time = end;
  }
}

export function createLinkSettings(partial: Partial<LinkSettings> = {}): LinkSettings {
  return { latencyMs: 0, jitterMs: 0, lossPct: 0, dupPct: 0, reorder: false, ...partial };
}

export function createConditionerSettings(enabled = false, up: Partial<LinkSettings> = {}, down: Partial<LinkSettings> = up): ConditionerSettings {
  return { enabled, up: createLinkSettings(up), down: createLinkSettings(down) };
}

/** Same shape for both directions: RTT split evenly. */
export function symmetric(rttMs: number, lossPct = 0, jitterMs = 0, dupPct = 0): ConditionerSettings {
  const link = { latencyMs: rttMs / 2, jitterMs, lossPct, dupPct };
  return createConditionerSettings(true, link, link);
}

export const NET_PRESETS: Readonly<Record<string, ConditionerSettings>> = {
  off: createConditionerSettings(false),
  'LAN (20 ms)': symmetric(20, 0, 1),
  'Good (80 ms, 0.5%)': symmetric(80, 0.5, 4),
  'Target (150 ms, 2%)': symmetric(150, 2, 5),
  'Bad wifi (200 ms, 5%, jitter)': symmetric(200, 5, 25, 1),
  'Mobile (300 ms, 3%)': symmetric(300, 3, 40),
};

/**
 * The owner's conditions (19 Oct 2026, Nigeria on mobile data to Johannesburg): the profiles the
 * high-ping work is judged on (`pnpm --filter @military-forge/game-server netfeel`).
 */
export const FEEL_PRESETS: Readonly<Record<string, ConditionerSettings>> = {
  'Target (150 ms ±40, 3%)': symmetric(150, 3, 40),
  'Bad (250 ms, 10% in bursts)': burst(symmetric(250, 10, 20), 120),
  // MTN 4G, Port Harcourt → Johannesburg, measured with /probe on 19 Oct: median 513 ms, p95 1347 ms,
  // 0 % loss. Uplink queue spikes (+1 s, 2.5 s long, one every ~7 s) reproduce that: median 513, p95 1343
  'MTN 4G (500 ms, spikes to 1.3 s)': upSpikes(symmetric(500, 0, 25), 1000, 7000, 2500),
};

/** The same settings with latency spikes on the uplink only (a phone's upload queue). */
export function upSpikes(s: ConditionerSettings, spikeMs: number, spikeEveryMs = 8000, spikeLengthMs = 1500): ConditionerSettings {
  return { ...s, up: { ...s.up, spikeMs, spikeEveryMs, spikeLengthMs } };
}

/** The same settings with loss in bursts of `burstMs` on average (both directions). */
export function burst(s: ConditionerSettings, burstMs: number): ConditionerSettings {
  return { ...s, up: { ...s.up, burstMs }, down: { ...s.down, burstMs } };
}

/** The same settings with latency spikes (both directions, independently). */
export function spikes(s: ConditionerSettings, spikeMs: number, spikeEveryMs = 8000, spikeLengthMs = 1500): ConditionerSettings {
  const k = { spikeMs, spikeEveryMs, spikeLengthMs };
  return { ...s, up: { ...s.up, ...k }, down: { ...s.down, ...k } };
}

export function copySettings(dst: ConditionerSettings, src: Readonly<ConditionerSettings>): ConditionerSettings {
  dst.enabled = src.enabled;
  Object.assign(dst.up, src.up);
  Object.assign(dst.down, src.down);
  return dst;
}

/**
 * "rtt=150,loss=2,jitter=5,dup=0,reorder=1" (both directions) plus optional per-direction keys
 * "up.latency=…", "down.loss=…". Used by the server flag (NET_SIM) and the client URL (?netsim=).
 * Returns null for an empty spec.
 */
export function parseNetSim(spec: string | undefined | null): ConditionerSettings | null {
  if (!spec || !spec.trim()) return null;
  const s = createConditionerSettings(true);
  for (const part of spec.split(/[,&;\s]+/)) {
    if (!part) continue;
    const [rawKey, rawValue = '1'] = part.split('=');
    const key = rawKey!.trim().toLowerCase();
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`netsim: bad value in "${part}"`);
    const [dir, field] = key.includes('.') ? (key.split('.') as [string, string]) : ['both', key];
    const links = dir === 'up' ? [s.up] : dir === 'down' ? [s.down] : dir === 'both' ? [s.up, s.down] : null;
    if (!links) throw new Error(`netsim: unknown direction in "${part}"`);
    for (const l of links) {
      switch (field) {
        case 'rtt':
          l.latencyMs = value / 2;
          break;
        case 'lat':
        case 'latency':
        case 'lag':
          l.latencyMs = value;
          break;
        case 'jitter':
        case 'jit':
          l.jitterMs = value;
          break;
        case 'loss':
          l.lossPct = value;
          break;
        case 'dup':
          l.dupPct = value;
          break;
        case 'reorder':
          l.reorder = value !== 0;
          break;
        case 'burst':
          l.burstMs = value;
          break;
        case 'spike':
          l.spikeMs = value;
          break;
        case 'spikeevery':
          l.spikeEveryMs = value;
          break;
        case 'spikelen':
          l.spikeLengthMs = value;
          break;
        default:
          throw new Error(`netsim: unknown key "${field}"`);
      }
    }
  }
  return s;
}

export function describeNetSim(s: Readonly<ConditionerSettings>): string {
  if (!s.enabled) return 'off';
  const d = (l: LinkSettings) =>
    `${l.latencyMs.toFixed(0)}±${l.jitterMs.toFixed(0)} ms ${l.lossPct}%${l.stream ? ' (TCP retransmits)' : ''}${l.burstMs ? ` in ${l.burstMs} ms bursts` : ''}${l.spikeMs ? ` spikes +${l.spikeMs} ms` : ''}${l.dupPct ? ` dup ${l.dupPct}%` : ''}${l.reorder ? ' reorder' : ''}`;
  return `up ${d(s.up)} · down ${d(s.down)}`;
}

export interface LinkStats {
  sent: number;
  dropped: number;
  duplicated: number;
  delivered: number;
  /** stream mode: messages that needed a retransmit (and held up everything behind them) */
  retransmitted: number;
}

interface Pending {
  at: number;
  bytes: Uint8Array;
}

/**
 * One direction. `settings` is read live on every send (the debug panel edits it in place);
 * `enabled()` lets the owner switch the whole conditioner off without rebuilding links.
 */
export class ConditionedLink {
  readonly stats: LinkStats = { sent: 0, dropped: 0, duplicated: 0, delivered: 0, retransmitted: 0 };
  private readonly queue: Pending[] = [];
  private readonly rng: Xoshiro128;
  /** draws for the burst and spike schedules: their own, so the schedule doesn't depend on the traffic */
  private readonly scheduleRng: Xoshiro128;
  private timer: unknown = null;
  private timerAt = Infinity;
  /** delivery time of the newest in-order message (keeps FIFO when reorder is off) */
  private lastAt = -Infinity;
  private disposed = false;
  /** burst loss (burstMs): the current spell, bad or good, and when it ends */
  private bad = true;
  private spellEnds = -Infinity;
  /** latency spikes (spikeMs): the next (or current) spike's start */
  private spikeAt = Number.NaN;

  constructor(
    private readonly settings: LinkSettings,
    private readonly enabled: () => boolean,
    private readonly scheduler: Scheduler,
    private readonly deliver: (bytes: Uint8Array) => void,
    private readonly isUnreliable: (bytes: Uint8Array) => boolean,
    seed = 1,
  ) {
    this.rng = new Xoshiro128(seed);
    this.scheduleRng = new Xoshiro128((seed ^ 0x5bd1e995) >>> 0);
  }

  /** messages waiting to be delivered */
  get inFlight(): number {
    return this.queue.length;
  }

  send(bytes: Uint8Array): void {
    if (this.disposed) return;
    this.stats.sent++;
    const s = this.settings;
    const unreliable = this.isUnreliable(bytes);
    if (!this.enabled()) {
      if (this.queue.length === 0) {
        this.stats.delivered++;
        this.deliver(bytes);
      } else this.schedule(bytes, this.scheduler.now(), false); // drain what's in flight first, in order
      return;
    }
    if (s.stream) {
      // TCP: the segment is resent ~1 RTT later and the stream stalls behind it
      let at = this.scheduler.now() + this.delay();
      if (this.lost()) {
        this.stats.retransmitted++;
        at += s.retransmitMs ?? Math.max(40, 2 * s.latencyMs);
      }
      this.schedule(bytes, at, false);
      return;
    }
    if (unreliable && this.lost()) {
      this.stats.dropped++;
      return;
    }
    const now = this.scheduler.now();
    // a spike is a queue: nothing overtakes inside it
    const reorder = s.reorder && this.spike(now) === 0;
    this.schedule(bytes, now + this.delay(), unreliable && reorder);
    if (unreliable && s.dupPct > 0 && this.rng.nextFloat() * 100 < s.dupPct) {
      this.stats.duplicated++;
      this.schedule(bytes, now + this.delay(), reorder);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  private delay(): number {
    const s = this.settings;
    return Math.max(0, s.latencyMs + s.jitterMs * (2 * this.rng.nextFloat() - 1)) + this.spike(this.scheduler.now());
  }

  /** Whether the next message is lost: independent draws, or bursts (burstMs). */
  private lost(): boolean {
    const s = this.settings;
    if (!(s.lossPct > 0)) return false;
    if (!s.burstMs || s.burstMs <= 0) return this.rng.nextFloat() * 100 < s.lossPct;
    const now = this.scheduler.now();
    // the share of time spent in bad spells that gives the average loss
    const share = Math.min(1, s.lossPct / BURST_LOSS_PCT);
    const inBad = share >= 1 ? s.lossPct : BURST_LOSS_PCT;
    if (share >= 1) return this.rng.nextFloat() * 100 < inBad;
    if (this.spellEnds === -Infinity) this.spellEnds = now; // starts in a good spell, drawn below
    while (now >= this.spellEnds) {
      this.bad = !this.bad;
      const mean = this.bad ? s.burstMs : (s.burstMs * (1 - share)) / share;
      this.spellEnds += Math.max(1, 2 * this.scheduleRng.nextFloat() * mean); // uniform around the mean
    }
    return this.bad && this.rng.nextFloat() * 100 < inBad;
  }

  /** Extra one-way delay now from a latency spike (spikeMs), ms. */
  private spike(now: number): number {
    const s = this.settings;
    if (!s.spikeMs || s.spikeMs <= 0) return 0;
    const every = s.spikeEveryMs ?? 8000;
    const length = s.spikeLengthMs ?? 1500;
    // gaps uniform around the mean (Math.log isn't deterministic across engines)
    if (Number.isNaN(this.spikeAt)) this.spikeAt = now + 2 * this.scheduleRng.nextFloat() * every;
    while (now >= this.spikeAt + length) this.spikeAt += length + 2 * this.scheduleRng.nextFloat() * every;
    if (now < this.spikeAt) return 0;
    // the queue fills over most of the spike and drains quickly at its end
    const u = (now - this.spikeAt) / length;
    return s.spikeMs * (u < 0.8 ? u / 0.8 : (1 - u) / 0.2);
  }

  private schedule(bytes: Uint8Array, at: number, mayReorder: boolean): void {
    if (!mayReorder) {
      at = Math.max(at, this.lastAt);
      this.lastAt = at;
    }
    // sorted insert, stable for equal times (queues are short: ~RTT × 60 Hz entries)
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.at > at) i--;
    this.queue.splice(i, 0, { at, bytes });
    this.arm();
  }

  private arm(): void {
    const next = this.queue[0];
    if (!next) return;
    if (this.timer !== null && this.timerAt <= next.at) return;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timerAt = next.at;
    this.timer = this.scheduler.setTimeout(() => this.flush(), Math.max(0, next.at - this.scheduler.now()));
  }

  /** Delivers everything due. Called by the timer; tests with a fake clock may call it directly. */
  flush(): void {
    this.timer = null;
    this.timerAt = Infinity;
    const now = this.scheduler.now();
    while (!this.disposed && this.queue.length > 0 && this.queue[0]!.at <= now) {
      const { bytes } = this.queue.shift()!;
      this.stats.delivered++;
      this.deliver(bytes);
    }
    this.arm();
  }
}
