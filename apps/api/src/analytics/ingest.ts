/**
 * The write path for play stats (docs/16 §4.2): requests only queue rows in memory; a timer writes
 * them in bounded batches (one multi-row INSERT of at most `batch` rows, server rows first). Nothing
 * is written on a request's path, and nothing at all on the game server's (it posts once per match).
 *
 * Back-pressure: the pressure is the client queue's fill or the event loop's lag, whichever is
 * worse. Under pressure the heavy, sampled client kinds (SHED_FIRST: ad views, active-time pings,
 * feature counts) are dropped first, at random, and the ones kept are weighted up (`props.w`) so
 * sums stay unbiased; then the other client kinds; at full pressure every client row is dropped.
 * Match events are never dropped: when their queue is full the API answers 503 and the game
 * server tries again later. Drops are counted per kind into `analytics_hourly` (ingest.dropped).
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { SHED_FIRST, type ClientEventKind } from '@military-forge/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { analyticsEvents } from '../db/analytics';
import type { Logger } from '../log';
import { utcDay, type Partitions } from './partitions';

export type RawEvent = typeof analyticsEvents.$inferInsert;

export interface IngestOptions {
  /** client rows queued at most (pressure 1 when full) */
  maxClient?: number;
  /** server rows queued at most (then 503) */
  maxServer?: number;
  /** rows per INSERT */
  batch?: number;
  /** event-loop lag (ms) that counts as full pressure */
  lagLimitMs?: number;
  random?: () => number;
  /** the event loop's recent lag in ms (tests inject it) */
  lagMs?: () => number;
  now?: () => number;
}

export interface IngestStats {
  queuedClient: number;
  queuedServer: number;
  written: number;
  dropped: number;
  pressure: number;
  lastFlushMs: number;
  lastFlushRows: number;
}

/** How much of a client kind to keep at pressure p (0 … 1+). */
export function keepShare(kind: string, p: number): number {
  if (p < 0.25) return 1;
  if (SHED_FIRST.has(kind as ClientEventKind)) return Math.max(0, Math.min(1, (0.75 - p) / 0.5));
  if (p < 0.75) return 1;
  return Math.max(0, Math.min(1, (1 - p) / 0.25));
}

export class Ingest {
  private client: RawEvent[] = [];
  private server: RawEvent[] = [];
  private readonly droppedBy = new Map<string, number>();
  private droppedTotal = 0;
  private written = 0;
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private histogram: IntervalHistogram | null = null;
  private lastFlushMs = 0;
  private lastFlushRows = 0;
  private readonly maxClient: number;
  private readonly maxServer: number;
  private readonly batch: number;
  private readonly lagLimitMs: number;
  private readonly random: () => number;
  private readonly lag: () => number;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly partitions: Partitions,
    private readonly log: Logger,
    o: IngestOptions = {},
  ) {
    this.maxClient = o.maxClient ?? 20_000;
    this.maxServer = o.maxServer ?? 50_000;
    this.batch = o.batch ?? 500;
    this.lagLimitMs = o.lagLimitMs ?? 250;
    this.random = o.random ?? Math.random;
    this.now = o.now ?? Date.now;
    this.lag = o.lagMs ?? (() => this.loopLag());
  }

  private loopLag(): number {
    if (!this.histogram) return 0;
    const ms = this.histogram.mean / 1e6;
    return Number.isFinite(ms) ? Math.max(0, ms - 20) : 0; // minus the sampling resolution
  }

  /** The pressure now: 0 idle … 1 full (client queue full, or the loop lagging `lagLimitMs`). */
  pressure(): number {
    return Math.max(this.client.length / this.maxClient, this.lag() / this.lagLimitMs);
  }

  /** Queues client rows, shedding under pressure. Returns how many were kept. */
  acceptClient(rows: readonly RawEvent[]): number {
    const p = this.pressure();
    let kept = 0;
    for (const r of rows) {
      const share = keepShare(r.kind, p);
      if (share <= 0 || (share < 1 && this.random() >= share) || this.client.length >= this.maxClient) {
        this.drop(r.kind);
        continue;
      }
      // kept at a share: weighted so sums and counts stay unbiased
      this.client.push(share < 1 ? { ...r, props: { ...r.props, w: ((r.props.w as number | undefined) ?? 1) / share } } : r);
      kept++;
    }
    return kept;
  }

  /** Queues match rows; false when the queue is full (the caller answers 503: the game server retries). */
  acceptServer(rows: readonly RawEvent[]): boolean {
    if (this.server.length + rows.length > this.maxServer) return false;
    this.server.push(...rows);
    return true;
  }

  private drop(kind: string, n = 1): void {
    this.droppedBy.set(kind, (this.droppedBy.get(kind) ?? 0) + n);
    this.droppedTotal += n;
  }

  stats(): IngestStats {
    return { queuedClient: this.client.length, queuedServer: this.server.length, written: this.written, dropped: this.droppedTotal, pressure: Math.round(this.pressure() * 100) / 100, lastFlushMs: this.lastFlushMs, lastFlushRows: this.lastFlushRows };
  }

  /** Writes everything queued now, in batches (one flush at a time). */
  flush(): Promise<void> {
    this.flushing ??= this.writeAll().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async writeAll(): Promise<void> {
    const started = performance.now();
    let rows = 0;
    while (this.server.length || this.client.length) {
      const fromServer = this.server.splice(0, this.batch);
      const take = fromServer.length ? fromServer : this.client.splice(0, this.batch);
      try {
        for (const day of new Set(take.map((r) => utcDay(r.at.getTime())))) await this.partitions.ensure(day);
        await this.db.insert(analyticsEvents).values(take);
        rows += take.length;
        this.written += take.length;
      } catch (err) {
        // the database is down or slow: match rows wait for the next flush; client rows go back while there's room
        this.log.warn({ err, rows: take.length }, 'analytics batch not written');
        if (fromServer.length) this.server.unshift(...fromServer);
        else {
          const room = Math.max(0, this.maxClient - this.client.length);
          this.client.unshift(...take.slice(0, room));
          if (take.length > room) this.drop('db-error', take.length - room);
        }
        break;
      }
    }
    await this.writeDropped();
    this.lastFlushMs = Math.round((performance.now() - started) * 10) / 10;
    this.lastFlushRows = rows;
  }

  /** The drops since the last flush, added to this hour's ingest.dropped counts. */
  private async writeDropped(): Promise<void> {
    if (!this.droppedBy.size) return;
    const hour = new Date(Math.floor(this.now() / 3_600_000) * 3_600_000);
    const entries = [...this.droppedBy];
    this.droppedBy.clear();
    try {
      for (const [kind, n] of entries) {
        await this.db.execute(sql`insert into analytics_hourly (hour, metric, dim, n, sum) values (${hour.toISOString()}::timestamptz, 'ingest.dropped', ${kind}, ${n}, 0)
          on conflict (hour, metric, dim) do update set n = analytics_hourly.n + excluded.n`);
      }
    } catch (err) {
      this.log.warn({ err }, 'analytics drop counts not written');
    }
  }

  /** Flushes every `everyMs` and watches the event loop's lag. */
  start(everyMs = 1000): void {
    if (this.timer) return;
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.timer = setInterval(() => {
      void this.flush().catch((err: unknown) => this.log.error({ err }, 'analytics flush failed'));
      this.histogram?.reset();
    }, everyMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram?.disable();
    await this.flush();
  }
}
