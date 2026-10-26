/**
 * Rollups (docs/16 §4.3): the raw events of a day turned into anonymous counts (analytics_daily,
 * analytics_hourly) and one row per player per day (analytics_player_days, analytics_players).
 *
 * Each run recomputes a whole day from its partition (delete, then insert, in one transaction), so
 * it is idempotent: run it again, or after late events arrive, and the result is the same. The
 * maintenance runs it for today and yesterday every few minutes; older days keep their rollups
 * after their raw partition is dropped.
 *
 * Weights: a client row kept at a share under load carries `props.w` = 1/share (ingest.ts), so the
 * weighted counts and sums here stay unbiased.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { addDays } from './partitions';

/** The daily metrics this file computes from raw events (a re-run replaces exactly these). */
export const DAILY_METRICS = [
  'events',
  'funnel',
  'feature',
  'error',
  'session.end',
  'session.len',
  'device.input',
  'device.form',
  'device.tier',
  'device.installed',
  'arrival',
  'country',
  'match.mode',
  'match.map',
  'match.bots',
  'weapon.pick',
  'weapon.kills',
  'weapon.deaths',
  'quit.minute',
  'quit.phase',
  'vs.bots',
  'ping',
  'reconnects',
  'ad.view',
  'ad.save',
  'ad.visit',
  'ingest.dropped',
] as const;

/** Session length bands, in seconds (the dashboard's order). */
export const SESSION_BANDS: readonly [string, number][] = [
  ['<1m', 60],
  ['1-5m', 300],
  ['5-15m', 900],
  ['15-30m', 1800],
  ['30-60m', 3600],
  ['60m+', Infinity],
];

const W = sql.raw(`coalesce((props->>'w')::float8, 1)`);

function bandCase(col: string): SQL {
  const parts = SESSION_BANDS.filter(([, max]) => Number.isFinite(max)).map(([name, max]) => `when ${col} < ${max} then '${name}'`);
  return sql.raw(`case ${parts.join(' ')} else '60m+' end`);
}

/** Every daily metric's query for [from, to): rows of (metric, dim, n, sum). */
function dailySelects(from: string, to: string): SQL[] {
  const range = sql`at >= ${from}::timestamptz and at < ${to}::timestamptz`;
  const ev = (kind: string) => sql`${range} and kind = ${kind}`;
  const humans = sql`${ev('match.player')} and not (props->>'bot')::boolean`;
  return [
    sql`select 'events', kind, count(*)::float8, 0::float8 from analytics_events where ${range} group by kind`,
    sql`select 'funnel', props->>'step', count(distinct coalesce(sid, uid))::float8, 0::float8 from analytics_events where ${ev('funnel')} group by 1, 2`,
    sql`select 'feature', props->>'f', count(distinct coalesce(sid, uid))::float8, sum(${W}) from analytics_events where ${ev('feature')} group by 1, 2`,
    sql`select 'error', (props->>'e') || ':' || (props->>'where'), sum(${W}), count(*)::float8 from analytics_events where ${ev('error')} group by 1, 2`,
    sql`select 'session.end', props->>'last', count(*)::float8, 0::float8 from analytics_events where ${ev('session.end')} group by 1, 2`,
    sql`select 'session.len', band, count(*)::float8, sum(s) from (select ${bandCase('s')} as band, s from (select sid, sum((props->>'s')::float8 * ${W}) as s from analytics_events where ${ev('session.active')} and sid is not null group by sid) per_session) b group by 1, 2`,
    ...(['input', 'form', 'tier'] as const).map((f) => sql`select ${`device.${f}`}, props->>${f}, count(distinct sid)::float8, 0::float8 from analytics_events where ${ev('session.start')} group by 1, 2`),
    sql`select 'device.installed', props->>'installed', count(distinct sid)::float8, 0::float8 from analytics_events where ${ev('session.start')} group by 1, 2`,
    sql`select 'arrival', props->>'arrival', count(distinct sid)::float8, 0::float8 from analytics_events where ${ev('session.start')} group by 1, 2`,
    sql`select 'country', coalesce(country, '??'), count(distinct coalesce(sid, uid))::float8, 0::float8 from analytics_events where ${range} and kind in ('session.start', 'match.player') group by 1, 2`,
    sql`select 'match.mode', props->>'mode', count(*)::float8, sum((props->>'durationS')::float8) from analytics_events where ${ev('match.end')} group by 1, 2`,
    sql`select 'match.mode', props->>'mode', count(*)::float8, sum((props->>'s')::float8) from analytics_events where ${ev('match.client')} group by 1, 2`,
    sql`select 'match.map', props->>'map', count(*)::float8, sum((props->>'durationS')::float8) from analytics_events where ${ev('match.end')} group by 1, 2`,
    sql`select 'match.bots', case when (props->>'bots')::int > 0 then 'with-bots' else 'humans-only' end, count(*)::float8, sum((props->>'humans')::float8) from analytics_events where ${ev('match.end')} group by 1, 2`,
    sql`select 'weapon.pick', g, count(*)::float8, sum(case when (props->>'won')::boolean then 1 else 0 end)::float8
          from analytics_events, lateral (select jsonb_array_elements_text(case when jsonb_typeof(props->'guns') = 'array' then props->'guns' else '["default"]'::jsonb end) as g) gg
          where ${humans} group by 1, 2`,
    sql`select 'weapon.kills', k.key, sum(k.value::float8), count(*)::float8 from analytics_events, lateral jsonb_each_text(props->'killsBy') k where ${humans} group by 1, 2`,
    sql`select 'weapon.deaths', k.key, sum(k.value::float8), count(*)::float8 from analytics_events, lateral jsonb_each_text(props->'deathsBy') k where ${humans} group by 1, 2`,
    sql`select 'quit.minute', least(floor((props->>'leftAtS')::float8 / 60), 10)::int::text, count(*)::float8, sum(case when (props->>'rage')::boolean then 1 else 0 end)::float8
          from analytics_events where ${humans} and (props->>'left')::boolean and props->>'leftPhase' = 'playing' and props->>'leftAtS' is not null group by 1, 2`,
    sql`select 'quit.phase', props->>'leftPhase', count(*)::float8, sum(case when (props->>'rage')::boolean then 1 else 0 end)::float8 from analytics_events where ${humans} and (props->>'left')::boolean group by 1, 2`,
    sql`select 'vs.bots', d.dim, sum(d.n), count(*)::float8 from analytics_events, lateral (values
          ('human.kills', case when not (props->>'bot')::boolean then (props->>'kills')::float8 else 0 end),
          ('human.deaths', case when not (props->>'bot')::boolean then (props->>'deaths')::float8 else 0 end),
          ('human.kills.bots', case when not (props->>'bot')::boolean then (props->>'botKills')::float8 else 0 end),
          ('human.deaths.bots', case when not (props->>'bot')::boolean then (props->>'botDeaths')::float8 else 0 end),
          ('bot.kills', case when (props->>'bot')::boolean then (props->>'kills')::float8 else 0 end),
          ('bot.deaths', case when (props->>'bot')::boolean then (props->>'deaths')::float8 else 0 end)
        ) d(dim, n) where ${ev('match.player')} group by 1, 2`,
    sql`select 'ping', props->>'ping', count(*)::float8, 0::float8 from analytics_events where ${humans} group by 1, 2`,
    sql`select 'reconnects', case when (props->>'reconnects')::int = 0 then '0' when (props->>'reconnects')::int = 1 then '1' else '2+' end, count(*)::float8, 0::float8 from analytics_events where ${humans} group by 1, 2`,
    sql`select 'ad.view', (props->>'c') || '|' || (props->>'adv'), sum(${W}), sum((props->>'ms')::float8 * ${W}) from analytics_events where ${ev('ad.view')} group by 1, 2`,
    sql`select 'ad.save', (props->>'c') || '|' || (props->>'adv'), sum(${W}), 0::float8 from analytics_events where ${ev('ad.save')} group by 1, 2`,
    sql`select 'ad.visit', (props->>'c') || '|' || (props->>'adv'), sum(${W}), 0::float8 from analytics_events where ${ev('ad.visit')} group by 1, 2`,
    sql`select 'ingest.dropped', dim, sum(n)::float8, 0::float8 from analytics_hourly where metric = 'ingest.dropped' and hour >= ${from}::timestamptz and hour < ${to}::timestamptz group by 1, 2`,
  ];
}

/** The hourly metrics recomputed from raw events (ingest.dropped is added to as it happens, never recomputed). */
export const HOURLY_METRICS = ['events', 'error'] as const;

/** Recomputes one UTC day's anonymous counts. */
export async function rollupDay(db: Db, day: string): Promise<void> {
  const from = `${day} 00:00:00+00`;
  const to = `${addDays(day, 1)} 00:00:00+00`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from analytics_daily where day = ${day}::date and metric in ${sql.raw(`(${DAILY_METRICS.map((m) => `'${m}'`).join(', ')})`)}`);
    for (const q of dailySelects(from, to)) {
      await tx.execute(sql`insert into analytics_daily (day, metric, dim, n, sum)
        select ${day}::date, m, coalesce(d, '?'), sum(n), coalesce(sum(s), 0) from (${q}) as x(m, d, n, s) group by 1, 2, 3`);
    }
    // the day's hours
    await tx.execute(sql`delete from analytics_hourly where hour >= ${from}::timestamptz and hour < ${to}::timestamptz and metric in ('events', 'error')`);
    await tx.execute(sql`insert into analytics_hourly (hour, metric, dim, n, sum)
      select date_trunc('hour', at), 'events', kind, count(*), 0 from analytics_events where at >= ${from}::timestamptz and at < ${to}::timestamptz group by 1, 2, 3`);
    await tx.execute(sql`insert into analytics_hourly (hour, metric, dim, n, sum)
      select date_trunc('hour', at), 'error', props->>'e', count(*), 0 from analytics_events where at >= ${from}::timestamptz and at < ${to}::timestamptz and kind = 'error' group by 1, 2, 3`);
    await rollupPlayers(tx as unknown as Db, day, from, to);
  });
}

/** One row per player who played that day; first and last days seen. */
async function rollupPlayers(db: Db, day: string, from: string, to: string): Promise<void> {
  await db.execute(sql`delete from analytics_player_days where day = ${day}::date`);
  await db.execute(sql`
    with ev as (
      select uid, kind, props, country, at from analytics_events
      where at >= ${from}::timestamptz and at < ${to}::timestamptz and uid is not null
        -- a player waiting to be forgotten (Delete my data) never comes back through a recount
        and uid not in (select uid from analytics_forget)
    ), modes as (
      select uid, jsonb_object_agg(mode, n) as modes from (
        select uid, props->>'mode' as mode, count(*) as n from ev where kind in ('match.player', 'match.client') group by 1, 2
      ) m group by uid
    )
    insert into analytics_player_days (day, uid, consented, sessions, active_s, matches, finished, left_early, rage, input, form, tier, hours, modes, country)
    select ${day}::date, ev.uid,
      bool_or(kind not in ('match.player', 'match.end')),
      count(*) filter (where kind = 'session.start'),
      coalesce(round(sum((props->>'s')::float8 * coalesce((props->>'w')::float8, 1)) filter (where kind = 'session.active')), 0)::int,
      count(*) filter (where kind in ('match.player', 'match.client')),
      count(*) filter (where (kind = 'match.player' and not (props->>'left')::boolean) or (kind = 'match.client' and (props->>'finished')::boolean)),
      count(*) filter (where kind = 'match.player' and (props->>'left')::boolean),
      count(*) filter (where kind = 'match.player' and (props->>'rage')::boolean),
      mode() within group (order by props->>'input') filter (where kind in ('session.start', 'input')),
      mode() within group (order by props->>'form') filter (where kind = 'session.start'),
      mode() within group (order by props->>'tier') filter (where kind = 'session.start'),
      coalesce(bit_or(1 << (extract(hour from at + make_interval(mins => (props->>'tzo')::int))::int)) filter (where kind = 'session.start'), 0),
      coalesce(max(modes.modes::text)::jsonb, '{}'::jsonb),
      mode() within group (order by country)
    from ev left join modes on modes.uid = ev.uid
    group by ev.uid`);
  await db.execute(sql`
    insert into analytics_players (uid, first_day, last_day)
    select uid, day, day from analytics_player_days where day = ${day}::date
    on conflict (uid) do update set first_day = least(analytics_players.first_day, excluded.first_day), last_day = greatest(analytics_players.last_day, excluded.last_day)`);
}
