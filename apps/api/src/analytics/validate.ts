/**
 * The vocabulary (@military-forge/shared analytics.ts) as validators. Anything that doesn't match is
 * dropped: an unknown kind, a field outside its list, a string where a count goes. Strings are only
 * ever ids from a fixed pattern (a creative, a route, a map), never text a player typed.
 */
import {
  AD_ID,
  ANALYTICS_VERSION,
  ARRIVALS,
  ERROR_KINDS,
  FEATURES,
  FORM_FACTORS,
  FUNNEL_STEPS,
  INPUT_KINDS,
  LEAVE_PHASES,
  MATCH_MODES,
  MAX_BATCH_EVENTS,
  PERF_TIERS,
  PING_BANDS,
  PLACE_ID,
  SCREENS,
  type ClientEvent,
} from '@military-forge/shared';
import { z } from 'zod';

const count = (max = 1_000_000) => z.number().int().min(0).max(max);
const t = z.number().finite();
const adId = z.string().regex(AD_ID);
const place = z.string().regex(PLACE_ID);

const clientEvents = [
  z.strictObject({
    k: z.literal('session.start'),
    t,
    n: count(),
    days: count(100_000),
    input: z.enum(INPUT_KINDS),
    form: z.enum(FORM_FACTORS),
    tier: z.enum(PERF_TIERS),
    installed: z.boolean(),
    arrival: z.enum(ARRIVALS),
    tzo: z.number().int().min(-840).max(840),
  }),
  z.strictObject({ k: z.literal('session.active'), t, s: count(24 * 3600) }),
  z.strictObject({ k: z.literal('session.end'), t, last: z.enum(SCREENS) }),
  z.strictObject({ k: z.literal('funnel'), t, step: z.enum(FUNNEL_STEPS) }),
  z.strictObject({ k: z.literal('feature'), t, f: z.enum(FEATURES) }),
  z.strictObject({ k: z.literal('input'), t, input: z.enum(INPUT_KINDS) }),
  z.strictObject({ k: z.literal('match.client'), t, mode: z.enum(MATCH_MODES), finished: z.boolean(), won: z.boolean(), kills: count(10_000), deaths: count(10_000), s: count(24 * 3600), bots: z.boolean() }),
  z.strictObject({ k: z.literal('error'), t, e: z.enum(ERROR_KINDS), where: place }),
  z.strictObject({ k: z.literal('ad.view'), t, c: adId, adv: adId, ms: count(24 * 3600_000), share: count(1000) }),
  z.strictObject({ k: z.literal('ad.save'), t, c: adId, adv: adId }),
  z.strictObject({ k: z.literal('ad.visit'), t, c: adId, adv: adId }),
] as const;

export const ClientEventSchema = z.discriminatedUnion('k', clientEvents);

/** The batch's frame; its events are checked one by one (a bad one is dropped, the rest kept). */
export const ClientBatchSchema = z.strictObject({
  v: z.literal(ANALYTICS_VERSION),
  consent: z.enum(['analytics', 'none']),
  sid: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,32}$/)
    .nullable(),
  tz: z.string().max(64).optional(),
  build: z.string().max(40),
  events: z.array(z.unknown()).max(MAX_BATCH_EVENTS),
});
export type ClientBatchFrame = z.infer<typeof ClientBatchSchema>;

/** The events of a batch that are in the vocabulary (the others are counted as invalid). */
export function validEvents(events: readonly unknown[]): { ok: ClientEvent[]; invalid: number } {
  const ok: ClientEvent[] = [];
  let invalid = 0;
  for (const e of events) {
    const r = ClientEventSchema.safeParse(e);
    if (r.success) ok.push(r.data as ClientEvent);
    else invalid++;
  }
  return { ok, invalid };
}

const tally = z.record(z.string().regex(PLACE_ID), count()).refine((o) => Object.keys(o).length <= 64, 'too many sources');

export const MatchPlayerStatsSchema = z.strictObject({
  uid: z.string().min(1).max(64).nullable(),
  bot: z.boolean(),
  placement: z.number().int().min(1).max(64),
  won: z.boolean(),
  kills: count(),
  deaths: count(),
  assists: count(),
  damage: count(),
  damageTaken: count(),
  headshots: count(),
  bestStreak: count(),
  guns: z.tuple([z.string().regex(PLACE_ID), z.string().regex(PLACE_ID)]).nullable(),
  killsBy: tally,
  deathsBy: tally,
  botKills: count(),
  botDeaths: count(),
  playedS: count(24 * 3600),
  lifeS: z.number().min(0).max(24 * 3600),
  left: z.boolean(),
  leftAtS: count(24 * 3600).nullable(),
  leftPhase: z.enum(LEAVE_PHASES).nullable(),
  rage: z.boolean(),
  ping: z.enum(PING_BANDS),
  reconnects: count(1000),
  transport: z.enum(['ws', 'wt', 'bot', 'unknown']),
});

export const MatchStatsReportSchema = z.strictObject({
  v: z.literal(ANALYTICS_VERSION),
  matchId: z.uuid(),
  mode: z.enum(MATCH_MODES),
  map: z.string().regex(PLACE_ID),
  room: z.enum(['code', 'default']),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  durationS: count(24 * 3600),
  reason: z.enum(['kill_limit', 'time_limit', 'other']),
  humans: count(64),
  bots: count(64),
  players: z.array(MatchPlayerStatsSchema).max(64),
});
