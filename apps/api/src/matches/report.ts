/**
 * What the game server sends when a match ends (apps/game-server/src/results.ts `MatchReport`),
 * and how its signature is checked. The game server signs with an Ed25519 key of its own; the API
 * holds only the public half (RESULTS_PUBLIC_KEY). The token is the API's JWT format with its own
 * issuer and audience, lives a minute, names the match (`sub`) and carries the SHA-256 of the exact
 * body, so it can't be reused for another report. A replay of the same report changes nothing:
 * matches are written once, by id.
 */
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { verifyJwt, type StandardClaims } from '../auth/tokens';

export const RESULTS_ISSUER = 'game-server';
export const RESULTS_AUDIENCE = 'api-results';
/** the game server's clock may run a little ahead of ours */
const CLOCK_SKEW_S = 5;
const MAX_LIFETIME_S = 120;

const count = z.number().int().min(0).max(1_000_000);
const name = z.string().min(1).max(64);

export const MatchReportBody = z.strictObject({
  matchId: z.uuid(),
  room: z.string().max(16),
  mode: z.enum(['deathmatch']),
  map: name,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  durationS: z.number().int().min(0).max(24 * 3600),
  reason: z.enum(['kill_limit', 'time_limit', 'other']),
  playerCount: z.number().int().min(0).max(64),
  botCount: z.number().int().min(0).max(64),
  serverBuild: z.string().max(64),
  players: z
    .array(
      z.strictObject({
        userId: name,
        nickname: name,
        placement: z.number().int().min(1).max(64),
        score: z.number().int().min(-1_000_000).max(1_000_000),
        kills: count,
        deaths: count,
        assists: count,
        damageDealt: count,
        damageTaken: count,
        headshots: count,
        bestStreak: count,
        left: z.boolean(),
        mvp: z.boolean(),
        killsBy: z.record(z.string().min(1).max(32), count).refine((o) => Object.keys(o).length <= 64, 'too many kill sources'),
      }),
    )
    .max(64),
});
export type MatchReportBody = z.infer<typeof MatchReportBody>;

interface ResultsClaims extends StandardClaims {
  bodySha256?: unknown;
}

export function resultsPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`expected an Ed25519 public key, got ${key.asymmetricKeyType}`);
  return key;
}

export type ReportAuthFailure = 'missing' | 'malformed' | 'bad_signature' | 'wrong_audience' | 'expired' | 'body_mismatch';

/** Checks `Authorization: GameServer <token>` against the raw body; returns the match id it names. */
export function checkReportAuth(header: string | undefined, rawBody: string, key: KeyObject, nowSeconds: number): { ok: true; matchId: string } | { ok: false; reason: ReportAuthFailure } {
  const token = header?.startsWith('GameServer ') ? header.slice('GameServer '.length).trim() : '';
  if (!token) return { ok: false, reason: 'missing' };
  let verdict: ReturnType<typeof verifyJwt<ResultsClaims>>;
  try {
    verdict = verifyJwt<ResultsClaims>(token, key, { iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, nowSeconds: nowSeconds - CLOCK_SKEW_S });
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!verdict.ok) return verdict;
  const c = verdict.claims;
  if (typeof c.iat !== 'number' || c.iat - CLOCK_SKEW_S > nowSeconds || c.exp - c.iat > MAX_LIFETIME_S) return { ok: false, reason: 'expired' };
  if (c.bodySha256 !== createHash('sha256').update(rawBody).digest('base64url')) return { ok: false, reason: 'body_mismatch' };
  return { ok: true, matchId: c.sub };
}
