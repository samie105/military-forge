/**
 * Per-match play stats for the owner's dashboard (docs/16-player-metrics.md §3.2): who played
 * with what, how long they lived, what killed them, when and how they left, their ping band and
 * reconnects, for people and bots. The room feeds it the same match events the results recorder
 * reads, plus joins, leaves and reconnects; at the match's end it hands one report to the sink
 * (results.ts posts it to the API, signed, off the tick: the post is async).
 *
 * Tick cost: nothing per tick beyond the room's existing walk over the match's events (empty on
 * almost every tick); a kill touches two small records. Measured in scripts/bench-match-stats.ts.
 *
 * No Node imports: a room also runs in a browser (local rooms), where it has no sink and isn't made.
 */
import { DEFAULT_GUN_IDS, weapons } from '@military-forge/content';
import { RAGE_QUIT_S, pingBand, type LeavePhase, type MatchMode, type MatchPlayerStats, type MatchStatsReport } from '@military-forge/shared';
import { MatchEndReason, MatchPhase, TICK_RATE, type Match, type MatchPlayer, type PlayerState } from '@military-forge/sim';
import { killSourceName, newMatchId } from './matchRecorder';

export interface MatchStatsSink {
  reportStats(r: MatchStatsReport): void;
}

/** A player's connection as the room knows it, read at a leave and at the end. */
export interface NetInfo {
  pingMs: number;
  transport: 'ws' | 'wt' | 'lan' | undefined;
}

interface Rec {
  uid: string | null;
  guns: [string, string] | null;
  /** tick the current life began (after a respawn), or -1 while dead */
  aliveSince: number;
  lifeTicks: number;
  lives: number;
  /** tick of the last death, -1 = none */
  lastDeath: number;
  /** tick in the match the player started (match start, or their join) */
  since: number;
  leftTick: number;
  leftPhase: LeavePhase | null;
  killsBy: Record<string, number>;
  deathsBy: Record<string, number>;
  botKills: number;
  botDeaths: number;
  reconnects: number;
  net: NetInfo | null;
}

const phaseName = (p: MatchPhase): LeavePhase => (p === MatchPhase.Waiting ? 'lobby' : p === MatchPhase.Countdown ? 'countdown' : p === MatchPhase.InProgress ? 'playing' : 'results');

export class MatchStats {
  /** this match's players by their soldier (people get one on join; bots on first sight) */
  private readonly recs = new Map<PlayerState, Rec>();
  /** who joined before the match began, kept across matches (rematches) */
  private readonly people = new Map<PlayerState, { uid: string | null; guns: [string, string] | null; reconnects: number }>();
  private startedAt = 0;
  private startTick = -1;

  constructor(
    private readonly sink: MatchStatsSink,
    private readonly room: 'code' | 'default',
    private readonly now: () => number = Date.now,
  ) {}

  private rec(p: PlayerState, tick: number): Rec {
    let r = this.recs.get(p);
    if (!r) {
      const who = this.people.get(p);
      const since = Math.max(tick, this.startTick);
      r = { uid: who?.uid ?? null, guns: who?.guns ?? null, aliveSince: since, lifeTicks: 0, lives: 0, lastDeath: -1, since, leftTick: -1, leftPhase: null, killsBy: {}, deathsBy: {}, botKills: 0, botDeaths: 0, reconnects: who?.reconnects ?? 0, net: null };
      this.recs.set(p, r);
    }
    return r;
  }

  /** A person joined: their account id (the join ticket's) and chosen guns (weapon indices; none: the default pair). */
  joined(p: PlayerState, uid: string | null, guns: readonly [number, number] | null, tick: number): void {
    const ids: [string, string] = guns ? [weapons[guns[0]]?.id ?? 'unknown', weapons[guns[1]]?.id ?? 'unknown'] : [DEFAULT_GUN_IDS[0], DEFAULT_GUN_IDS[1]];
    this.people.set(p, { uid, guns: ids, reconnects: 0 });
    if (this.startTick >= 0) this.rec(p, tick);
  }

  reconnected(p: PlayerState): void {
    const who = this.people.get(p);
    if (who) who.reconnects++;
    const r = this.recs.get(p);
    if (r) r.reconnects++;
  }

  /** The player's session ended (left, or didn't come back in time). */
  left(p: PlayerState, phase: MatchPhase, tick: number, net: NetInfo): void {
    this.people.delete(p);
    const r = this.recs.get(p);
    if (!r || r.leftTick >= 0) return;
    r.leftTick = tick;
    r.leftPhase = phaseName(phase);
    r.net = net;
    if (r.aliveSince >= 0 && r.aliveSince <= tick) {
      r.lifeTicks += tick - r.aliveSince;
      r.lives++;
      r.aliveSince = -1;
    }
  }

  /**
   * The match's events this tick (room.ts, right after the results recorder). `net` reads a
   * player's connection at the end; `respawnS` is the room's respawn delay.
   */
  onMatchEvents(match: Match, mapId: string, tick: number, respawnS: number, net: (p: PlayerState) => NetInfo | null): void {
    for (const e of match.events) {
      if (e.type === 'phase' && e.phase === MatchPhase.InProgress) {
        this.recs.clear();
        this.startedAt = this.now();
        this.startTick = tick;
        for (const m of match.players) if (m) this.rec(m.state, tick);
      } else if (e.type === 'kill' && this.startTick >= 0) {
        const victim = match.players[e.victim];
        if (!victim) continue;
        const v = this.rec(victim.state, tick);
        const source = e.killer === e.victim ? 'self' : killSourceName(e.source);
        v.deathsBy[source] = (v.deathsBy[source] ?? 0) + 1;
        if (v.aliveSince >= 0) {
          v.lifeTicks += Math.max(0, tick - v.aliveSince);
          v.lives++;
        }
        v.lastDeath = tick;
        v.aliveSince = tick + Math.round(respawnS * TICK_RATE);
        const killer = e.killer !== e.victim ? match.players[e.killer] : undefined;
        if (killer) {
          const k = this.rec(killer.state, tick);
          k.killsBy[source] = (k.killsBy[source] ?? 0) + 1;
          if (victim.isBot) k.botKills++;
          if (killer.isBot) v.botDeaths++;
        }
      } else if (e.type === 'phase' && e.phase === MatchPhase.Ending && match.results && this.startTick >= 0) {
        this.sink.reportStats(this.build(match, mapId, tick, net));
        this.startTick = -1;
      }
    }
  }

  private build(match: Match, mapId: string, tick: number, net: (p: PlayerState) => NetInfo | null): MatchStatsReport {
    const r = match.results!;
    const byKey = new Map<number, MatchPlayer>();
    for (const m of [...match.players, ...match.departed]) if (m) byKey.set(m.key, m);
    const players: MatchPlayerStats[] = [];
    for (const s of r.standings) {
      const state = byKey.get(s.key)?.state;
      if (!state) continue;
      const rec = this.rec(state, tick);
      const end = rec.leftTick >= 0 ? rec.leftTick : tick;
      let lifeTicks = rec.lifeTicks;
      let lives = rec.lives;
      if (rec.leftTick < 0 && rec.aliveSince >= 0 && rec.aliveSince <= tick) {
        lifeTicks += tick - rec.aliveSince;
        lives++;
      }
      const n = s.isBot ? null : (rec.net ?? net(state));
      const won = s.left ? false : match.teams > 0 ? s.team !== undefined && s.team >= 0 && s.team === r.winnerTeam : s.placement === 1;
      players.push({
        uid: s.isBot ? null : rec.uid,
        bot: s.isBot,
        placement: s.placement,
        won,
        kills: s.kills,
        deaths: s.deaths,
        assists: s.assists,
        damage: Math.round(s.damageDealt),
        damageTaken: Math.round(s.damageTaken),
        headshots: s.headshots,
        bestStreak: s.bestStreak,
        guns: s.isBot ? null : rec.guns,
        killsBy: rec.killsBy,
        deathsBy: rec.deathsBy,
        botKills: rec.botKills,
        botDeaths: rec.botDeaths,
        playedS: Math.max(0, Math.round((end - rec.since) / TICK_RATE)),
        lifeS: lives ? Math.round((lifeTicks / lives / TICK_RATE) * 10) / 10 : 0,
        left: s.left,
        leftAtS: rec.leftTick >= 0 ? Math.max(0, Math.round((rec.leftTick - this.startTick) / TICK_RATE)) : null,
        leftPhase: rec.leftPhase,
        rage: rec.leftTick >= 0 && rec.leftPhase === 'playing' && rec.lastDeath >= 0 && rec.leftTick - rec.lastDeath <= RAGE_QUIT_S * TICK_RATE,
        ping: s.isBot ? 'unknown' : pingBand(n?.pingMs ?? -1),
        reconnects: rec.reconnects,
        transport: s.isBot ? 'bot' : n?.transport === 'ws' || n?.transport === 'wt' ? n.transport : 'unknown',
      });
    }
    const mode: MatchMode = match.teams === 2 ? 'team2' : match.teams === 3 ? 'team3' : match.teams === 4 ? 'team4' : 'ffa';
    const endedAt = this.now();
    return {
      v: 1,
      matchId: newMatchId(),
      mode,
      map: mapId,
      room: this.room,
      startedAt: new Date(this.startedAt || endedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationS: Math.round(r.durationTicks / TICK_RATE),
      reason: r.reason === MatchEndReason.KillLimit ? 'kill_limit' : r.reason === MatchEndReason.TimeLimit ? 'time_limit' : 'other',
      humans: r.standings.filter((x) => !x.isBot).length,
      bots: r.standings.filter((x) => x.isBot).length,
      players,
    };
  }
}
