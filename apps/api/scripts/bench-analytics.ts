/**
 * What play stats cost Postgres (docs/16 §4.4): writes a day of realistic events through the real
 * ingest queue (500-row INSERTs into the day partition), then rolls the day up, and prints the
 * insert cost per row, the rollup time and the bytes per event on disk.
 *
 * Run against a throwaway database (it creates the tables and fills them):
 *   DATABASE_URL=postgres://… pnpm --filter @military-forge/api exec tsx scripts/bench-analytics.ts [events=200000]
 */
import { randomUUID } from 'node:crypto';
import type { ClientEvent, MatchPlayerStats } from '@military-forge/shared';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db/client';
import { MemoryKv } from '../src/kv/kv';
import { createLogger } from '../src/log';
import { AnalyticsService } from '../src/analytics/service';
import { rowsOf } from '../src/analytics/partitions';

const total = Number(process.argv[2] ?? 200_000);
const config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn' });
if (config.db.kind !== 'postgres') throw new Error('set DATABASE_URL to a throwaway Postgres');
const database = await openDatabase(config);
const db = database.db;
await db.execute(sql`truncate analytics_events, analytics_daily, analytics_hourly, analytics_player_days, analytics_players`);
const day = Date.parse('2026-10-26T00:00:00Z');
let clock = day + 12 * 3_600_000;
const svc = new AnalyticsService(db, new MemoryKv(), config.analytics, createLogger(config), () => clock, { lagMs: () => 0, maxClient: 1_000_000, maxServer: 1_000_000 });
await svc.partitions.ensure('2026-10-26');

const players = Array.from({ length: Math.max(50, Math.round(total / 200)) }, () => randomUUID());
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const at = () => day + Math.floor(Math.random() * 86_000_000);

// ~85 % client events (sessions, funnel, features, ad views), ~15 % match rows
let queued = 0;
const t0 = performance.now();
let writeMs = 0;
while (queued < total) {
  const uid = pick(players);
  const sid = randomUUID().replaceAll('-', '').slice(0, 24);
  const events: ClientEvent[] = [
    { k: 'session.start', t: at(), n: 1 + Math.floor(Math.random() * 20), days: 3, input: pick(['touch', 'keyboard', 'pad'] as const), form: pick(['phone', 'desktop'] as const), tier: pick(['low', 'medium', 'high'] as const), installed: false, arrival: 'direct', tzo: 60 },
    { k: 'funnel', t: at(), step: 'home' },
    { k: 'feature', t: at(), f: pick(['locker', 'armory', 'settings'] as const) },
    { k: 'session.active', t: at(), s: 60 + Math.floor(Math.random() * 1500) },
    { k: 'ad.view', t: at(), c: pick(['house:deet-a', 'house:deet-b', 'house:ws-1']), adv: pick(['deet', 'worldstreet']), ms: 1000 + Math.floor(Math.random() * 20_000), share: 40 },
    { k: 'session.end', t: at(), last: pick(['home', 'results', 'lobby'] as const) },
  ];
  clock = at();
  await svc.acceptClient(events, { consent: 'analytics', sid, uid, country: pick(['NG', 'ZA', 'GH']), gpc: false, build: 'bench' });
  queued += events.length;
  if (queued % 7 === 0) {
    const p = (bot: boolean): MatchPlayerStats => ({ uid: bot ? null : pick(players), bot, placement: 1, won: Math.random() < 0.3, kills: 5, deaths: 4, assists: 1, damage: 900, damageTaken: 800, headshots: 1, bestStreak: 2, guns: ['k47', 'buzz'], killsBy: { k47: 3, grenade: 2 }, deathsBy: { widow: 4 }, botKills: 2, botDeaths: 1, playedS: 300, lifeS: 55, left: false, leftAtS: null, leftPhase: null, rage: false, ping: '60-120', reconnects: 0, transport: 'ws' });
    const endedAt = new Date(at()).toISOString();
    svc.acceptMatch({ v: 1, matchId: randomUUID(), mode: 'ffa', map: 'fog-stair', room: 'code', startedAt: endedAt, endedAt, durationS: 360, reason: 'time_limit', humans: 4, bots: 4, players: [p(false), p(false), p(false), p(false), p(true), p(true), p(true), p(true)] });
    queued += 9;
  }
  if (svc.ingest.stats().queuedClient >= 5000) {
    const w = performance.now();
    await svc.ingest.flush();
    writeMs += performance.now() - w;
  }
}
const w = performance.now();
await svc.ingest.flush();
writeMs += performance.now() - w;
const written = svc.ingest.stats().written;
const wall = performance.now() - t0;

const r0 = performance.now();
const { rollupDay } = await import('../src/analytics/rollup');
await rollupDay(db, '2026-10-26');
const rollupMs = performance.now() - r0;
const d0 = performance.now();
await svc.dashboard(30);
const dashMs = performance.now() - d0;

const size = rowsOf<{ bytes: string }>(await db.execute(sql`select pg_total_relation_size('analytics_events_p20261026')::text as bytes`))[0]!.bytes;
const rollupRows = rowsOf<{ n: number }>(await db.execute(sql`select (select count(*) from analytics_daily) + (select count(*) from analytics_player_days) as n`))[0]!.n;
console.log(`${written} events written in ${(writeMs / 1000).toFixed(1)} s of INSERTs (500-row batches): ${((writeMs * 1000) / written).toFixed(1)} µs per event, ${Math.round(written / (writeMs / 1000))} events/s (wall ${(wall / 1000).toFixed(1)} s with generation)`);
console.log(`rollup of the day: ${(rollupMs / 1000).toFixed(2)} s → ${rollupRows} rollup rows; dashboard (30 days): ${dashMs.toFixed(0)} ms`);
console.log(`on disk: ${(Number(size) / 1e6).toFixed(1)} MB for the day's partition (${(Number(size) / written).toFixed(0)} bytes per event, index included)`);
await database.close();
