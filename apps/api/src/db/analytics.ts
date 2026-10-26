/**
 * The play-stats tables (docs/16-player-metrics.md §4), for typed queries. They're created by the
 * hand-written migration drizzle/0005_analytics.sql (the raw table is partitioned by day, which
 * Drizzle can't declare), so this module is kept out of drizzle-kit's schema (drizzle.config.ts):
 * a later `db:generate` leaves them alone. Change them with a new hand-written migration.
 */
import { bigint, boolean, date, doublePrecision, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true } as const;

/** Raw events, append-only, partitioned by UTC day of `at`; dropped after the retention window. */
export const analyticsEvents = pgTable('analytics_events', {
  at: timestamp('at', tz).notNull(),
  kind: text('kind').notNull(),
  v: smallint('v').notNull(),
  /** the player's pseudonymous id (guest or account); null for anonymous kinds */
  uid: text('uid'),
  /** the page load's random session id (client), or the match id (server) */
  sid: text('sid'),
  /** ISO 3166 alpha-2 from the request (never the address), '??' = unknown */
  country: text('country'),
  props: jsonb('props').notNull().$type<Record<string, unknown>>(),
});

/** Anonymous counts per hour: `metric` (e.g. "events", "ingest.dropped"), `dim` (its breakdown), n and a sum. */
export const analyticsHourly = pgTable(
  'analytics_hourly',
  {
    hour: timestamp('hour', tz).notNull(),
    metric: text('metric').notNull(),
    dim: text('dim').notNull(),
    n: bigint('n', { mode: 'number' }).notNull(),
    sum: doublePrecision('sum').notNull(),
  },
  (t) => [primaryKey({ name: 'analytics_hourly_pk', columns: [t.hour, t.metric, t.dim] })],
);

/** Anonymous counts per UTC day (the dashboard's tables, kept for good). */
export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    day: date('day', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    dim: text('dim').notNull(),
    n: bigint('n', { mode: 'number' }).notNull(),
    sum: doublePrecision('sum').notNull(),
  },
  (t) => [primaryKey({ name: 'analytics_daily_pk', columns: [t.day, t.metric, t.dim] })],
);

/** One row per player per day played: active players, retention and the ad segments. */
export const analyticsPlayerDays = pgTable(
  'analytics_player_days',
  {
    day: date('day', { mode: 'string' }).notNull(),
    uid: text('uid').notNull(),
    /** the player said yes that day (client stats came in); only these rows feed the segments */
    consented: boolean('consented').notNull(),
    sessions: integer('sessions').notNull(),
    activeS: integer('active_s').notNull(),
    matches: integer('matches').notNull(),
    finished: integer('finished').notNull(),
    leftEarly: integer('left_early').notNull(),
    rage: integer('rage').notNull(),
    input: text('input'),
    form: text('form'),
    tier: text('tier'),
    /** bit h set = played in local hour h */
    hours: integer('hours').notNull(),
    /** matches by mode */
    modes: jsonb('modes').notNull().$type<Record<string, number>>(),
    country: text('country'),
  },
  (t) => [primaryKey({ name: 'analytics_player_days_pk', columns: [t.day, t.uid] })],
);

/** Each player's first and last day seen (retention cohorts, new vs returning). */
export const analyticsPlayers = pgTable('analytics_players', {
  uid: text('uid').primaryKey(),
  firstDay: date('first_day', { mode: 'string' }).notNull(),
  lastDay: date('last_day', { mode: 'string' }).notNull(),
});

/** Players whose stats are to be deleted (Delete my data; a deleted account, by trigger). */
export const analyticsForget = pgTable('analytics_forget', {
  uid: text('uid').primaryKey(),
  at: timestamp('at', tz).notNull(),
});
