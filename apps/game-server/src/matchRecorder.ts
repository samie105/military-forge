/**
 * A match's report as the room builds it (results.ts sends it to the API, signed). No Node imports,
 * so a room runs in a browser too (a local room's host, apps/web/src/lan), where nothing is
 * reported: local rooms never touch accounts, XP or leaderboards.
 */
import { weapons } from '@military-forge/content';
import { CONTENT_HASH, PROTOCOL_VERSION } from '@military-forge/protocol';
import { DamageSource, MatchEndReason, MatchPhase, TICK_RATE, type Match, type MatchPlayer, type PlayerState } from '@military-forge/sim';

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

/** A fresh match id (Web Crypto: the same in Node and the browser). */
export function newMatchId(): string {
  return globalThis.crypto.randomUUID();
}

export interface ResultsSink {
  report(r: MatchReport): void;
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
