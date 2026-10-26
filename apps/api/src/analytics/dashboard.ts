/**
 * The owner's dashboard (admin page → Players; docs/16 §5): every panel as a table, from the
 * rollups only (never the raw events), so a 90-day view costs a few small queries. The same tables
 * export as CSV. Nothing here names a player: every row is a count.
 */
import { FUNNEL_STEPS } from '@military-forge/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { addDays, rowsOf } from './partitions';
import { SESSION_BANDS } from './rollup';

export type Cell = string | number | null;

export interface Table {
  title: string;
  /** one line on what it shows and how it's counted */
  note: string;
  columns: string[];
  rows: Cell[][];
}

export interface Dashboard {
  range: { from: string; to: string; days: number };
  generatedAt: string;
  kpis: {
    dau: number;
    wau: number;
    mau: number;
    newToday: number;
    players: number;
    matches: number;
    avgSessionS: number | null;
    d1: number | null;
    d7: number | null;
  };
  tables: Record<string, Table>;
}

export const PANELS = [
  'active',
  'retention',
  'funnel',
  'sessions',
  'matches-per-player',
  'devices',
  'weapons',
  'maps',
  'modes',
  'quits',
  'quit-phase',
  'last-screen',
  'vs-bots',
  'network',
  'countries',
  'features',
  'ads',
  'errors',
  'ingest',
] as const;
export type Panel = (typeof PANELS)[number];

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
const num = (x: unknown): number => Number(x ?? 0);

interface Agg {
  n: number;
  sum: number;
}

export async function dashboard(db: Db, today: string, days: number, generatedAt: Date): Promise<Dashboard> {
  const to = today;
  const from = addDays(today, -(days - 1));

  // the anonymous counts, summed over the range: metric → dim → { n, sum }
  const daily = new Map<string, Map<string, Agg>>();
  for (const r of rowsOf<{ metric: string; dim: string; n: number; sum: number }>(
    await db.execute(sql`select metric, dim, sum(n)::float8 as n, sum(sum)::float8 as sum from analytics_daily where day between ${from}::date and ${to}::date group by 1, 2`),
  )) {
    const m = daily.get(r.metric) ?? new Map<string, Agg>();
    m.set(r.dim, { n: num(r.n), sum: num(r.sum) });
    daily.set(r.metric, m);
  }
  const metric = (name: string) => [...(daily.get(name) ?? new Map<string, Agg>())].sort((a, b) => b[1].n - a[1].n);
  const get = (name: string, dim: string): Agg => daily.get(name)?.get(dim) ?? { n: 0, sum: 0 };

  // active players per day, new (first seen that day) and returning
  const active = rowsOf<{ day: string; dau: number; new: number }>(
    await db.execute(sql`select d.day::text as day, count(*)::int as dau, count(*) filter (where p.first_day = d.day)::int as new
      from analytics_player_days d join analytics_players p on p.uid = d.uid
      where d.day between ${from}::date and ${to}::date group by d.day order by d.day`),
  );
  const window = async (n: number) =>
    num(rowsOf<{ n: number }>(await db.execute(sql`select count(distinct uid)::int as n from analytics_player_days where day > ${addDays(to, -n)}::date and day <= ${to}::date`))[0]?.n);
  const [wau, mau] = [await window(7), await window(30)];
  const players = num(rowsOf<{ n: number }>(await db.execute(sql`select count(distinct uid)::int as n from analytics_player_days where day between ${from}::date and ${to}::date`))[0]?.n);

  // D1 / D7 retention by first-seen day
  const cohorts = rowsOf<{ cohort: string; size: number; d1: number; d7: number }>(
    await db.execute(sql`select p.first_day::text as cohort, count(*)::int as size,
        count(*) filter (where exists (select 1 from analytics_player_days d where d.uid = p.uid and d.day = p.first_day + 1))::int as d1,
        count(*) filter (where exists (select 1 from analytics_player_days d where d.uid = p.uid and d.day = p.first_day + 7))::int as d7
      from analytics_players p where p.first_day between ${from}::date and ${to}::date group by 1 order by 1`),
  );
  const ripe = (cohort: string, after: number) => addDays(cohort, after) <= to;
  const sumRipe = (after: 1 | 7) => {
    const c = cohorts.filter((r) => ripe(r.cohort, after));
    const size = c.reduce((a, r) => a + num(r.size), 0);
    return pct(
      c.reduce((a, r) => a + num(after === 1 ? r.d1 : r.d7), 0),
      size,
    );
  };

  // matches per player over the range
  const perPlayer = rowsOf<{ bucket: string; players: number }>(
    await db.execute(sql`select case when m <= 0 then '0' when m = 1 then '1' when m <= 3 then '2-3' when m <= 9 then '4-9' when m <= 24 then '10-24' else '25+' end as bucket, count(*)::int as players
      from (select uid, sum(matches) as m from analytics_player_days where day between ${from}::date and ${to}::date group by uid) x group by 1`),
  );
  const BUCKETS = ['0', '1', '2-3', '4-9', '10-24', '25+'];

  const sessions = metric('session.len');
  const sessionN = sessions.reduce((a, [, v]) => a + v.n, 0);
  const sessionS = sessions.reduce((a, [, v]) => a + v.sum, 0);
  const matches = metric('match.mode').reduce((a, [, v]) => a + v.n, 0);

  const share = (rows: [string, Agg][]) => {
    const total = rows.reduce((a, [, v]) => a + v.n, 0);
    return rows.map(([dim, v]) => [dim, Math.round(v.n), pct(v.n, total)] as Cell[]);
  };

  const funnelRows: Cell[][] = [];
  let first = 0;
  let prev = 0;
  for (const step of FUNNEL_STEPS) {
    const n = get('funnel', step).n;
    if (step === FUNNEL_STEPS[0]) first = n;
    funnelRows.push([step, n, step === FUNNEL_STEPS[0] ? 100 : pct(n, prev), pct(n, first)]);
    prev = n;
  }

  const kills = new Map(metric('weapon.kills').map(([d, v]) => [d, v.n]));
  const deaths = new Map(metric('weapon.deaths').map(([d, v]) => [d, v.n]));
  const guns = new Set([...metric('weapon.pick').map(([d]) => d), ...kills.keys()]);
  const weaponRows = [...guns]
    .map((g) => {
      const p = get('weapon.pick', g);
      return [g, p.n, p.sum, pct(p.sum, p.n), kills.get(g) ?? 0, deaths.get(g) ?? 0] as Cell[];
    })
    .sort((a, b) => num(b[1]) - num(a[1]) || num(b[4]) - num(a[4]));

  const ads = new Set([...metric('ad.view'), ...metric('ad.save'), ...metric('ad.visit')].map(([d]) => d));
  const adRows = [...ads]
    .map((d) => {
      const [creative, advertiser] = d.split('|');
      const v = get('ad.view', d);
      const saves = get('ad.save', d).n;
      const visits = get('ad.visit', d).n;
      return [creative ?? d, advertiser ?? '', Math.round(v.n), Math.round(v.sum / 1000), v.n ? Math.round(v.sum / v.n / 100) / 10 : null, Math.round(saves), pct(saves, v.n), Math.round(visits), pct(visits, saves)] as Cell[];
    })
    .sort((a, b) => num(b[2]) - num(a[2]));

  const vs = (dim: string) => get('vs.bots', dim).n;
  const dropped = metric('ingest.dropped');
  const eventsTotal = metric('events').reduce((a, [, v]) => a + v.n, 0);

  const tables: Record<Panel, Table> = {
    active: {
      title: 'Active players',
      note: 'Players with a match or a consented session that UTC day. New: first seen that day.',
      columns: ['day', 'active', 'new', 'returning'],
      rows: active.map((r) => [r.day, num(r.dau), num(r.new), num(r.dau) - num(r.new)]),
    },
    retention: {
      title: 'Retention (D1, D7)',
      note: 'Of the players first seen on a day, the share back exactly 1 and 7 days later. Blank: not that old yet.',
      columns: ['cohort', 'players', 'D1', 'D1 %', 'D7', 'D7 %'],
      rows: cohorts.map((r) => [r.cohort, num(r.size), ripe(r.cohort, 1) ? num(r.d1) : null, ripe(r.cohort, 1) ? pct(num(r.d1), num(r.size)) : null, ripe(r.cohort, 7) ? num(r.d7) : null, ripe(r.cohort, 7) ? pct(num(r.d7), num(r.size)) : null]),
    },
    funnel: {
      title: 'First-run funnel',
      note: 'Sessions reaching each step (consenting players). Step %: of the step before; overall: of landings.',
      columns: ['step', 'sessions', 'step %', 'overall %'],
      rows: funnelRows,
    },
    sessions: {
      title: 'Session length',
      note: 'Foreground time per page load (consenting players).',
      columns: ['length', 'sessions', 'share %'],
      rows: SESSION_BANDS.map(([band]) => [band, Math.round(get('session.len', band).n), pct(get('session.len', band).n, sessionN)]),
    },
    'matches-per-player': {
      title: 'Matches per player',
      note: 'Over the range, players by how many matches they played.',
      columns: ['matches', 'players'],
      rows: BUCKETS.map((b) => [b, num(perPlayer.find((r) => r.bucket === b)?.players)]),
    },
    devices: {
      title: 'Devices',
      note: 'Sessions by input, screen size, graphics tier and installed app.',
      columns: ['split', 'value', 'sessions', 'share %'],
      rows: (['device.input', 'device.form', 'device.tier', 'device.installed', 'arrival'] as const).flatMap((m) => share(metric(m)).map((r) => [m.replace('device.', ''), ...r])),
    },
    weapons: {
      title: 'Weapons',
      note: 'Picks: players who brought the gun (their saved pair). Win rate: of those, won the match. Kills and deaths by it (people only).',
      columns: ['weapon', 'picks', 'wins', 'win %', 'kills', 'deaths by'],
      rows: weaponRows,
    },
    maps: {
      title: 'Maps',
      note: 'Matches played to the end or abandoned, and minutes played.',
      columns: ['map', 'matches', 'minutes', 'share %'],
      rows: metric('match.map').map(([d, v]) => [d, v.n, Math.round(v.sum / 60), pct(v.n, matches)]),
    },
    modes: {
      title: 'Modes',
      note: 'Rooms on the server (free-for-all, teams), plus local rooms and training seen by consenting devices.',
      columns: ['mode', 'matches', 'minutes'],
      rows: metric('match.mode').map(([d, v]) => [d, v.n, Math.round(v.sum / 60)]),
    },
    quits: {
      title: 'Where players quit a match',
      note: 'People who left a running match, by minute. Rage: left within 15 s of dying.',
      columns: ['minute', 'quits', 'rage quits', 'rage %'],
      rows: Array.from({ length: 11 }, (_, i) => {
        const a = get('quit.minute', String(i));
        return [i === 10 ? '10+' : String(i), a.n, a.sum, pct(a.sum, a.n)];
      }),
    },
    'quit-phase': {
      title: 'Leaving by phase',
      note: 'When people left a room before its match ended.',
      columns: ['phase', 'players', 'rage quits'],
      rows: metric('quit.phase').map(([d, v]) => [d, v.n, v.sum]),
    },
    'last-screen': {
      title: 'Last screen before closing',
      note: 'Where consenting sessions ended (the page closed or went away).',
      columns: ['screen', 'sessions', 'share %'],
      rows: share(metric('session.end')),
    },
    'vs-bots': {
      title: 'People and bots',
      note: 'Kills and deaths of people, and how many involved bots.',
      columns: ['measure', 'count'],
      rows: [
        ['people: kills', vs('human.kills')],
        ['people: kills of bots', vs('human.kills.bots')],
        ['people: deaths', vs('human.deaths')],
        ['people: deaths to bots', vs('human.deaths.bots')],
        ['bots: kills', vs('bot.kills')],
        ['bots: deaths', vs('bot.deaths')],
        ['matches with bots', get('match.bots', 'with-bots').n],
        ['matches of people only', get('match.bots', 'humans-only').n],
      ],
    },
    network: {
      title: 'Ping and reconnects',
      note: 'Each person per match: their round trip band, and how often they reconnected.',
      columns: ['measure', 'value', 'players', 'share %'],
      rows: [...share(metric('ping')).map((r) => ['ping', ...r]), ...share(metric('reconnects')).map((r) => ['reconnects', ...r])],
    },
    countries: {
      title: 'Countries',
      note: 'Coarse country of the request (the address is never kept). EU: a European time zone without a lookup table.',
      columns: ['country', 'sessions and players', 'share %'],
      rows: share(metric('country')),
    },
    features: {
      title: 'Feature use',
      note: 'Sessions that used each feature (consenting players), and times used.',
      columns: ['feature', 'sessions', 'uses'],
      rows: metric('feature').map(([d, v]) => [d, v.n, Math.round(v.sum)]),
    },
    ads: {
      title: 'Billboard ads by creative',
      note: 'Impressions: a creative on screen in a match (once per match per device). Saves: tap-to-save (the CTR). Visits: opened after the match.',
      columns: ['creative', 'advertiser', 'impressions', 'viewable s', 'avg s', 'saves', 'CTR %', 'visits', 'visits / saves %'],
      rows: adRows,
    },
    errors: {
      title: 'Errors on devices',
      note: 'Failures devices reported (anonymous): a route that couldn’t load, a missing file, the page not starting.',
      columns: ['error', 'where', 'count'],
      rows: metric('error')
        .slice(0, 50)
        .map(([d, v]) => {
          const [e, ...where] = d.split(':');
          return [e ?? d, where.join(':'), Math.round(v.n)];
        }),
    },
    ingest: {
      title: 'Pipeline',
      note: 'Events stored, and events dropped under load (the sampled kinds first).',
      columns: ['measure', 'kind', 'count'],
      rows: [['stored', 'all', eventsTotal], ...metric('events').map(([d, v]) => ['stored', d, v.n] as Cell[]), ...dropped.map(([d, v]) => ['dropped', d, v.n] as Cell[])],
    },
  };

  const last = active.at(-1);
  return {
    range: { from, to, days },
    generatedAt: generatedAt.toISOString(),
    kpis: {
      dau: last && last.day === to ? num(last.dau) : 0,
      wau,
      mau,
      newToday: last && last.day === to ? num(last.new) : 0,
      players,
      matches,
      avgSessionS: sessionN ? Math.round(sessionS / sessionN) : null,
      d1: sumRipe(1),
      d7: sumRipe(7),
    },
    tables,
  };
}

/** One panel as CSV (RFC 4180: quoted where needed, CRLF lines). */
export function toCsv(t: Table): string {
  const cell = (c: Cell) => {
    if (c === null) return '';
    // a text cell that a spreadsheet would read as a formula gets a leading apostrophe
    const s = typeof c === 'string' && /^[=+\-@\t\r]/.test(c) ? `'${c}` : String(c);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [t.columns, ...t.rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
