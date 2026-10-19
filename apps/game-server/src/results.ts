/**
 * Match results to the API (docs/06 §7, docs/07 §12): when a match ends, the room hands its report
 * here and it goes to the API's `POST /internal/matches`, signed.
 *
 * Signing mirrors the join tickets (tickets.ts), the other way round: the game server holds an
 * Ed25519 key of its own (RESULTS_PRIVATE_KEY) and the API only its public half, so nobody can post
 * results without the box's key, and the API's keys can't sign them. The token is the API's JWT
 * format (EdDSA, its fixed header) with an issuer and audience of its own, a one-minute life, the
 * match id as `sub`, and the SHA-256 of the exact body, so a token can't carry another report.
 * Writes are idempotent by match id, so a retry (or a replay within the minute) changes nothing.
 *
 * Only people who came in with an API ticket are in the report (their `sub` is the account id);
 * bots, and guests on a dev server without tickets, never are.
 */
import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { weapons } from '@military-forge/content';
import { CONTENT_HASH, PROTOCOL_VERSION } from '@military-forge/protocol';
import { DamageSource, MatchEndReason, MatchPhase, TICK_RATE, type Match, type MatchPlayer, type PlayerState } from '@military-forge/sim';

export const RESULTS_ISSUER = 'game-server';
export const RESULTS_AUDIENCE = 'api-results';
const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
const TOKEN_LIFETIME_S = 60;

export interface MatchReportPlayer {
  /** the API account id (the join ticket's `sub`) */
  userId: string;
  nickname: string;
  /** 1-based, among everyone who played (bots included) */
  placement: number;
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  damageDealt: number;
  damageTaken: number;
  headshots: number;
  bestStreak: number;
  /** left before the end */
  left: boolean;
  mvp: boolean;
  /** kills by what made them: a weapon id, or melee / grenade / mine / gas / world */
  killsBy: Record<string, number>;
}

export interface MatchReport {
  /** made by the game server when the match ends; the API's idempotency key */
  matchId: string;
  /** the room code ('' = the default room) */
  room: string;
  mode: 'deathmatch';
  map: string;
  /** ISO times */
  startedAt: string;
  endedAt: string;
  durationS: number;
  reason: 'kill_limit' | 'time_limit' | 'other';
  /** everyone who played, people and bots */
  playerCount: number;
  botCount: number;
  serverBuild: string;
  players: MatchReportPlayer[];
}

export function newMatchId(): string {
  return randomUUID();
}

export function resultsPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem.replaceAll('\\n', '\n'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`expected an Ed25519 private key, got ${key.asymmetricKeyType}`);
  return key;
}

/** The Authorization header's token for exactly this body. */
export function signReport(body: string, matchId: string, key: KeyObject, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const claims = {
    iss: RESULTS_ISSUER,
    aud: RESULTS_AUDIENCE,
    sub: matchId,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_S,
    jti: randomUUID(),
    bodySha256: createHash('sha256').update(body).digest('base64url'),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(null, Buffer.from(`${HEADER}.${payload}`), key).toString('base64url');
  return `${HEADER}.${payload}.${signature}`;
}

export interface ResultsSink {
  report(r: MatchReport): void;
}

/**
 * Posts reports to the API with retries (1 s, 5 s, 30 s, 2 min, 10 min): the API restarting or
 * busy for a while loses nothing. A 4xx other than 429 is final (the report is wrong; logged).
 * Reports live in memory only, so a game server restart drops the ones still waiting.
 */
export class ResultsReporter implements ResultsSink {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly apiUrl: string,
    private readonly key: KeyObject,
    private readonly log: (line: string) => void = console.log,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly delaysMs: readonly number[] = [1_000, 5_000, 30_000, 120_000, 600_000],
  ) {}

  report(r: MatchReport): void {
    if (r.players.length === 0) return; // only bots or ticketless guests: nothing to record
    const p = this.send(r).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Waits for the reports in flight (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async send(r: MatchReport): Promise<void> {
    const body = JSON.stringify(r);
    for (let attempt = 0; ; attempt++) {
      let status: number;
      try {
        const res = await this.fetchImpl(`${this.apiUrl}/internal/matches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `GameServer ${signReport(body, r.matchId, this.key)}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        if (res.ok) return;
        if (status >= 400 && status < 500 && status !== 429) {
          this.log(`[results] the API refused match ${r.matchId}: ${status} ${(await res.text()).slice(0, 200)}`);
          return;
        }
      } catch (e) {
        status = -1;
        if (attempt === 0) this.log(`[results] match ${r.matchId}: ${(e as Error).message}; retrying`);
      }
      const wait = this.delaysMs[attempt];
      if (wait === undefined) {
        this.log(`[results] gave up on match ${r.matchId} (last status ${status})`);
        return;
      }
      await new Promise((done) => setTimeout(done, wait).unref?.());
    }
  }
}

const SOURCE_NAMES: Record<number, string> = {
  [DamageSource.Mine]: 'mine',
  [DamageSource.Gas]: 'gas',
  [DamageSource.Melee]: 'melee',
  [DamageSource.World]: 'world',
  [DamageSource.Grenade]: 'grenade',
};

/** What a kill is credited to: the weapon's id, or the kind of damage. */
export function killSourceName(source: number): string {
  return weapons[source]?.id ?? SOURCE_NAMES[source] ?? 'other';
}

/**
 * Follows a room's match and hands a report to the sink when it ends (room.ts calls it each tick
 * with the match's events). It knows which players are people with accounts: the room tells it
 * when a ticketed player joins.
 */
export class MatchRecorder {
  private readonly accounts = new WeakMap<PlayerState, string>();
  private startedAt = 0;
  /** MatchPlayer.key → kills by source, this match */
  private readonly killsBy = new Map<number, Record<string, number>>();

  constructor(
    private readonly sink: ResultsSink,
    private readonly room: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** `player` is the person whose API account is `userId` (the join ticket's `sub`). */
  setAccount(player: PlayerState, userId: string): void {
    this.accounts.set(player, userId);
  }

  onMatchEvents(match: Match, mapId: string): void {
    for (const e of match.events) {
      if (e.type === 'phase' && e.phase === MatchPhase.InProgress) {
        this.startedAt = this.now();
        this.killsBy.clear();
      } else if (e.type === 'kill' && e.killer !== e.victim) {
        const key = match.players[e.killer]?.key;
        if (key === undefined) continue;
        const by = this.killsBy.get(key) ?? {};
        const name = killSourceName(e.source);
        by[name] = (by[name] ?? 0) + 1;
        this.killsBy.set(key, by);
      } else if (e.type === 'phase' && e.phase === MatchPhase.Ending && match.results) {
        this.sink.report(this.build(match, mapId));
      }
    }
  }

  private build(match: Match, mapId: string): MatchReport {
    const r = match.results!;
    const byKey = new Map<number, MatchPlayer>();
    for (const m of [...match.players, ...match.departed]) if (m) byKey.set(m.key, m);
    const endedAt = this.now();
    const players: MatchReportPlayer[] = [];
    for (const s of r.standings) {
      const state = byKey.get(s.key)?.state;
      const userId = state && !s.isBot ? this.accounts.get(state) : undefined;
      if (!userId) continue; // bots and ticketless guests get no rows
      players.push({
        userId,
        nickname: s.name,
        placement: s.placement,
        score: s.score,
        kills: s.kills,
        deaths: s.deaths,
        assists: s.assists,
        damageDealt: s.damageDealt,
        damageTaken: s.damageTaken,
        headshots: s.headshots,
        bestStreak: s.bestStreak,
        left: s.left,
        mvp: s.mvp,
        killsBy: this.killsBy.get(s.key) ?? {},
      });
    }
    return {
      matchId: newMatchId(),
      room: this.room,
      mode: 'deathmatch',
      map: mapId,
      startedAt: new Date(this.startedAt || endedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationS: Math.round(r.durationTicks / TICK_RATE),
      reason: r.reason === MatchEndReason.KillLimit ? 'kill_limit' : r.reason === MatchEndReason.TimeLimit ? 'time_limit' : 'other',
      playerCount: r.standings.length,
      botCount: r.standings.filter((s) => s.isBot).length,
      serverBuild: `p${PROTOCOL_VERSION}-${CONTENT_HASH.toString(16)}`,
      players,
    };
  }
}
