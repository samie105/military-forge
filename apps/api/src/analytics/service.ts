/**
 * Play stats, the API side (docs/16-player-metrics.md): turns batches into rows for the ingest
 * queue, runs the maintenance (day partitions, rollups, retention, deletions) and answers the
 * dashboard and the segments.
 *
 * Maintenance runs in this process on a one-minute timer (one API process on the box). Every step
 * is idempotent, so a second process would only repeat work.
 */
import { ANONYMOUS_KINDS, type ClientEvent, type MatchStatsReport } from '@military-forge/shared';
import { sql } from 'drizzle-orm';
import type { AnalyticsConfig } from '../config';
import type { Db } from '../db/client';
import type { Kv } from '../kv/kv';
import type { Logger } from '../log';
import { GeoIpTable, inEurope } from './country';
import { dashboard, type Dashboard } from './dashboard';
import { Ingest, type IngestOptions, type RawEvent } from './ingest';
import { Partitions, addDays, rowsOf, utcDay } from './partitions';
import { rollupDay } from './rollup';
import { segmentsFor, type Segments } from './segments';

/** A client's `t` may be this far in the past (a batch kept while offline) or the future (a fast clock). */
const MAX_PAST_MS = 24 * 3_600_000;
const MAX_FUTURE_MS = 60_000;
/** Rollups of today and yesterday run this often. */
const ROLLUP_EVERY_MS = 10 * 60_000;
/** Day rows and first/last days: kept 13 months (D1/D7/D30 and year-on-year), then deleted. */
export const PLAYER_DAYS_KEPT = 400;
/** Hourly counts: kept five weeks. */
export const HOURLY_KEPT_DAYS = 35;
/** a session id → the player, so a beacon sent as the page closes (no token) still counts as theirs */
const SID_TTL_MS = 24 * 3_600_000;
const sidKey = (sid: string) => `asid:${sid}`;

export interface ClientContext {
  consent: 'analytics' | 'none';
  sid: string | null;
  /** from the request's access token, when it has one */
  uid: string | null;
  country: string;
  /** Sec-GPC: 1 */
  gpc: boolean;
  build: string;
}

export class AnalyticsService {
  readonly partitions: Partitions;
  readonly ingest: Ingest;
  readonly geoip: GeoIpTable | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRollup = 0;
  private lastRetention = '';
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly kv: Kv,
    readonly config: AnalyticsConfig,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    ingestOptions: IngestOptions = {},
  ) {
    this.partitions = new Partitions(db);
    this.ingest = new Ingest(db, this.partitions, log, { now, ...ingestOptions });
    let geoip: GeoIpTable | null = null;
    if (config.geoipCsv) {
      try {
        geoip = GeoIpTable.load(config.geoipCsv);
        log.info({ ranges: geoip.size }, 'analytics: country table loaded');
      } catch (err) {
        log.warn({ err, file: config.geoipCsv }, 'analytics: no country table (the time zone stands in)');
      }
    }
    this.geoip = geoip;
  }

  /** The consent the page should ask for in this country. */
  consentMode(country: string): 'opt-in' | 'opt-out' {
    return inEurope(country) ? 'opt-in' : this.config.consentDefault;
  }

  /**
   * A client batch's events as rows, queued. Without a yes only the anonymous kinds are kept, with
   * no ids; ad kinds also need a yes in Europe (docs/14 §7.4); a browser's Global Privacy Control
   * without a yes keeps nothing. Ad rows never carry the player's id, even with a yes.
   */
  async acceptClient(events: readonly ClientEvent[], ctx: ClientContext): Promise<{ kept: number; refused: number }> {
    const yes = ctx.consent === 'analytics' && ctx.sid !== null;
    if (!yes && ctx.gpc) return { kept: 0, refused: events.length };
    let uid: string | null = null;
    if (yes) {
      if (ctx.uid) {
        uid = ctx.uid;
        await this.kv.set(sidKey(ctx.sid!), uid, { ttlMs: SID_TTL_MS }).catch(() => {});
      } else uid = await this.kv.get(sidKey(ctx.sid!)).catch(() => null);
    }
    const now = this.now();
    const rows: RawEvent[] = [];
    let refused = 0;
    for (const e of events) {
      const anonymous = ANONYMOUS_KINDS.has(e.k);
      if (!yes && (!anonymous || (e.k.startsWith('ad.') && inEurope(ctx.country)))) {
        refused++;
        continue;
      }
      const { k, t, ...props } = e;
      const at = Number.isFinite(t) && t >= now - MAX_PAST_MS && t <= now + MAX_FUTURE_MS ? t : now;
      rows.push({
        at: new Date(at),
        kind: k,
        v: 1,
        uid: anonymous ? null : uid,
        sid: anonymous ? null : ctx.sid,
        country: ctx.country,
        props: k === 'session.start' ? { ...props, build: ctx.build } : props,
      });
    }
    return { kept: this.ingest.acceptClient(rows), refused };
  }

  /** A match's stats from the game server, queued; false = the queue is full (answer 503). */
  acceptMatch(r: MatchStatsReport, country = '??'): boolean {
    const at = new Date(Math.min(Date.parse(r.endedAt), this.now()));
    const { players, v, matchId, ...match } = r;
    const rows: RawEvent[] = [{ at, kind: 'match.end', v, uid: null, sid: matchId, country, props: match }];
    for (const p of players) {
      const { uid, ...stats } = p;
      rows.push({ at, kind: 'match.player', v, uid: p.bot ? null : uid, sid: matchId, country, props: { ...stats, mode: r.mode, map: r.map } });
    }
    return this.ingest.acceptServer(rows);
  }

  /** The player asked to delete their play stats: the day rows go now, the raw events with the next maintenance. */
  async forget(uid: string): Promise<void> {
    await this.db.execute(sql`insert into analytics_forget (uid, at) values (${uid}, ${new Date(this.now()).toISOString()}::timestamptz) on conflict (uid) do update set at = excluded.at`);
    await this.db.execute(sql`delete from analytics_player_days where uid = ${uid}`);
    await this.db.execute(sql`delete from analytics_players where uid = ${uid}`);
  }

  segments(uid: string): Promise<Segments | null> {
    return segmentsFor(this.db, uid, utcDay(this.now()));
  }

  async dashboard(days: number): Promise<Dashboard> {
    return dashboard(this.db, utcDay(this.now()), days, new Date(this.now()));
  }

  /** Writes what's queued and recomputes today's and yesterday's rollups now. */
  async rollupNow(): Promise<void> {
    await this.ingest.flush();
    await this.processForget();
    const today = utcDay(this.now());
    await this.partitions.ensure(today);
    await rollupDay(this.db, addDays(today, -1));
    await rollupDay(this.db, today);
    this.lastRollup = this.now();
  }

  /** One maintenance pass (the timer's; tests call it). */
  maintain(): Promise<void> {
    this.running ??= this.maintainOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async maintainOnce(): Promise<void> {
    const now = this.now();
    const today = utcDay(now);
    const keepFrom = addDays(today, -(this.config.rawDays - 1));
    const dropped = await this.partitions.maintain(today, keepFrom);
    if (dropped.length) this.log.info({ dropped }, 'analytics: raw days past the retention window dropped');
    await this.processForget();
    if (now - this.lastRollup >= ROLLUP_EVERY_MS) await this.rollupNow();
    if (this.lastRetention !== today) {
      await this.db.execute(sql`delete from analytics_player_days where day < ${addDays(today, -PLAYER_DAYS_KEPT)}::date`);
      await this.db.execute(sql`delete from analytics_players where last_day < ${addDays(today, -PLAYER_DAYS_KEPT)}::date`);
      await this.db.execute(sql`delete from analytics_hourly where hour < ${new Date(now - HOURLY_KEPT_DAYS * 86_400_000).toISOString()}::timestamptz`);
      this.lastRetention = today;
    }
  }

  /** Deletes the raw events, day rows and first/last days of the players waiting to be forgotten. */
  async processForget(limit = 200): Promise<number> {
    const uids = rowsOf<{ uid: string }>(await this.db.execute(sql`select uid from analytics_forget order by at limit ${limit}`)).map((r) => r.uid);
    if (!uids.length) return 0;
    // rows still queued in memory for them are written first, then deleted with the rest
    await this.ingest.flush();
    const list = sql.join(
      uids.map((u) => sql`${u}`),
      sql`, `,
    );
    await this.db.execute(sql`delete from analytics_events where uid in (${list})`);
    await this.db.execute(sql`delete from analytics_player_days where uid in (${list})`);
    await this.db.execute(sql`delete from analytics_players where uid in (${list})`);
    await this.db.execute(sql`delete from analytics_forget where uid in (${list})`);
    this.log.info({ players: uids.length }, 'analytics: play stats deleted on request');
    return uids.length;
  }

  start(): void {
    if (this.timer) return;
    this.ingest.start();
    const tick = () => void this.maintain().catch((err: unknown) => this.log.error({ err }, 'analytics maintenance failed'));
    setTimeout(tick, 5_000).unref?.();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
    await this.ingest.stop();
  }
}
