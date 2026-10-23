/**
 * Match lifecycle and deathmatch rules (docs/06 §5.2, docs/07 §5.4, docs/01 §6, docs/03 §8):
 *
 *   WAITING ─▶ COUNTDOWN ─▶ IN_PROGRESS ─▶ ENDING ─▶ POSTGAME ─▶ WAITING (rematch) | CLOSED
 *
 * A Match wraps a Game and is stepped instead of it. It always steps the Game (the tick keeps
 * counting for the netcode), freezes human inputs outside the warm-up and the match itself, and
 * scores the Game's events. Otherwise it only observes the Game, so rooms and replays without a
 * Match are unchanged. Everything is driven by ticks, inputs and commands: deterministic.
 */
import { HitZone, NO_WEAPON } from '@military-forge/content';
import { MAX_PLAYERS, ticks } from './constants';
import type { Game } from './game';
import { Fnv32 } from './hash';
import { createInput, type Input } from './input';
import { resetPickups } from './pickups';
import type { PlayerState } from './player';

export const MatchPhase = {
  /** lobby + warm-up yard: inputs live, nothing is scored */
  Waiting: 0,
  /** spawn assignment, then everyone frozen until GO */
  Countdown: 1,
  InProgress: 2,
  /** scoreboard; results are final */
  Ending: 3,
  /** rematch vote */
  Postgame: 4,
  Closed: 5,
} as const;
export type MatchPhase = (typeof MatchPhase)[keyof typeof MatchPhase];

export const MATCH_PHASE_NAMES = ['WAITING', 'COUNTDOWN', 'IN_PROGRESS', 'ENDING', 'POSTGAME', 'CLOSED'] as const;

export const MatchEndReason = {
  None: 0,
  KillLimit: 1,
  TimeLimit: 2,
} as const;
export type MatchEndReason = (typeof MatchEndReason)[keyof typeof MatchEndReason];

export interface MatchRules {
  /** seconds of play, 0 = no time limit */
  timeLimit: number;
  /** score that ends the match, 0 = no kill limit */
  killLimit: number;
  /** seconds */
  countdown: number;
  /** seconds on the scoreboard before the rematch vote */
  ending: number;
  /** seconds of rematch vote */
  postgame: number;
  /** players needed to start the countdown (bots count) */
  minPlayers: number;
  /** when the vote times out with no votes: close the room (quick play) or go back to the lobby (custom rooms) */
  onNoRematch: 'close' | 'lobby';
  /**
   * Team modes (protocol v21): 0 = free-for-all; 2, 3 or 4 teams (Team Deathmatch). The kill limit is
   * then the team's: the first team to it wins.
   */
  teams: number;
}

/** The modes a room can play: free-for-all, then 2, 3 and 4 teams. */
export const TEAM_MODES = [0, 2, 3, 4] as const;
export const MAX_TEAMS = 4;

/** The kill limit a mode starts with (the admin page tunes the team ones): first team to 30, 25, 20. */
export function defaultKillLimit(teams: number): number {
  return teams === 3 ? 25 : teams === 4 ? 20 : 30;
}

/** Deathmatch: most kills in 6 min or first to 30 (docs/01 §6); phase lengths from docs/06 §5.2. */
export const DEATHMATCH_RULES: Readonly<MatchRules> = {
  timeLimit: 360,
  killLimit: 30,
  countdown: 5,
  ending: 10,
  postgame: 15,
  minPlayers: 2,
  onNoRematch: 'close',
  teams: 0,
};

export function createMatchRules(overrides: Partial<MatchRules> = {}): MatchRules {
  return { ...DEATHMATCH_RULES, ...overrides };
}

/** Assists: ≥ 25 damage within the 10 s before the death (docs/03 §8). */
export const ASSIST_MIN_DAMAGE = 25;
export const ASSIST_WINDOW_TICKS = ticks(10);

export type MatchEvent =
  | { type: 'phase'; phase: MatchPhase; prev: MatchPhase }
  /** a death while IN_PROGRESS; killer === victim is a suicide */
  | { type: 'kill'; killer: number; victim: number; source: number; assists: number[]; streak: number };

interface RecentHit {
  attacker: MatchPlayer;
  damage: number;
  tick: number;
}

/** One player's lobby flags and match stats. Replaced (not reused) when the slot changes hands. */
export class MatchPlayer {
  ready = false;
  rematch = false;
  /** left the room during this match; kept for its standings */
  left = false;

  score = 0;
  kills = 0;
  deaths = 0;
  suicides = 0;
  assists = 0;
  damageDealt = 0;
  damageTaken = 0;
  headshots = 0;
  streak = 0;
  bestStreak = 0;
  /** match tick of the last score change (tie-break: who got there first) */
  scoreTick = 0;
  /** hits taken in the assist window, oldest first */
  readonly recentHits: RecentHit[] = [];

  constructor(
    readonly id: number,
    /** unique within the room (join order); ids are slot numbers and get reused after a leave */
    readonly key: number,
    readonly state: PlayerState,
    tick: number,
  ) {
    this.scoreTick = tick;
  }

  get name(): string {
    return this.state.name;
  }

  get isBot(): boolean {
    return this.state.isBot;
  }

  /** MVP rating: kills and damage up, deaths down. */
  get rating(): number {
    return 100 * this.kills + 50 * this.assists + Math.round(this.damageDealt) - 50 * this.deaths;
  }

  resetStats(tick: number): void {
    this.score = this.kills = this.deaths = this.suicides = this.assists = 0;
    this.damageDealt = this.damageTaken = this.headshots = this.streak = this.bestStreak = 0;
    this.scoreTick = tick;
    this.recentHits.length = 0;
  }
}

export interface MatchStanding {
  /** 1-based */
  placement: number;
  /** slot id: a player who joins after a leave can get the leaver's id, so check `left` too */
  id: number;
  /** unique within the room: tells a leaver and the joiner who took over the slot apart */
  key: number;
  name: string;
  isBot: boolean;
  left: boolean;
  score: number;
  kills: number;
  deaths: number;
  suicides: number;
  assists: number;
  /** rounded to whole HP */
  damageDealt: number;
  damageTaken: number;
  headshots: number;
  bestStreak: number;
  rating: number;
  mvp: boolean;
  /** team modes: the player's team (−1 in a free-for-all) */
  team?: number;
}

export interface MatchResults {
  /** 1 for the room's first match, counting up with rematches */
  number: number;
  reason: MatchEndReason;
  /** ticks played IN_PROGRESS */
  durationTicks: number;
  /** MatchStanding.key of 1st place, −1 if nobody played (a key, not a slot id: 1st may have left) */
  winnerKey: number;
  /** MatchStanding.key of the MVP, −1 when nobody earned a positive rating */
  mvpKey: number;
  standings: MatchStanding[];
  /** team modes: the teams' final scores (empty in a free-for-all) */
  teamScores?: number[];
  /** team modes: the winning team, −1 for a draw or a free-for-all */
  winnerTeam?: number;
}

/** score ↓, kills ↓, deaths ↑, damage ↓, earliest to reach the score, id */
function compareStandings(a: MatchPlayer, b: MatchPlayer): number {
  return (
    b.score - a.score ||
    b.kills - a.kills ||
    a.deaths - b.deaths ||
    b.damageDealt - a.damageDealt ||
    a.scoreTick - b.scoreTick ||
    a.id - b.id
  );
}

export class Match {
  readonly rules: MatchRules;
  phase: MatchPhase = MatchPhase.Waiting;
  /** ticks spent in the current phase */
  phaseTick = 0;
  /** ticks since the Match was created */
  tick = 0;
  /** matches played in this room: 1 from the first GO; a cancelled countdown does not count */
  number = 0;
  endReason: MatchEndReason = MatchEndReason.None;
  /** final results, from ENDING until the next match starts (kept through the lobby and countdown) */
  results: MatchResults | null = null;
  /** events produced by the most recent step() */
  readonly events: MatchEvent[] = [];
  /** live roster by player id, in step with game.players */
  readonly players: (MatchPlayer | null)[] = new Array<MatchPlayer | null>(MAX_PLAYERS).fill(null);
  /** players who left during the current match */
  readonly departed: MatchPlayer[] = [];
  /** team modes: each team's score (team kills, less suicides), and the tick it last changed */
  teamScores: number[] = [];
  private teamScoreTicks: number[] = [];
  /**
   * The room's party of a player (social parties: kept together when teams are dealt), null = none.
   * Rooms set it; local play leaves it.
   */
  groupOf: ((id: number) => string | null) | null = null;
  private startRequested = false;
  private lobbyRequested = false;
  /** next MatchPlayer.key */
  private joins = 0;
  private readonly frozen: Input[] = Array.from({ length: MAX_PLAYERS }, createInput);
  private readonly frozenRefs: (Input | undefined)[] = new Array<Input | undefined>(MAX_PLAYERS);

  constructor(
    readonly game: Game,
    rules: Partial<MatchRules> = {},
  ) {
    this.rules = createMatchRules(rules);
    this.resetTeamScores();
    this.sync();
  }

  get teams(): number {
    return this.rules.teams;
  }

  /**
   * Host, lobby only: the mode. Everyone is dealt onto the new teams (party mates together, bots
   * spread), or off teams for a free-for-all. Returns false when refused (not a mode, not the lobby).
   */
  setTeams(teams: number): boolean {
    if (!(TEAM_MODES as readonly number[]).includes(teams) || this.phase !== MatchPhase.Waiting) return false;
    this.rules.teams = teams;
    this.resetTeamScores();
    for (const p of this.game.players) if (p) p.team = -1;
    if (teams > 0) {
      // humans first in join order, then bots: parties land together, bots fill the gaps
      const order = this.players.filter((m): m is MatchPlayer => m !== null).sort((a, b) => Number(a.isBot) - Number(b.isBot) || a.key - b.key);
      for (const m of order) m.state.team = this.pickTeam(m.state);
    }
    return true;
  }

  /** Host, lobby only: a player onto a team (a swap in the lobby's team columns). */
  setTeam(id: number, team: number): boolean {
    const m = this.players[id];
    if (!m || this.teams === 0 || this.phase !== MatchPhase.Waiting) return false;
    if (!Number.isInteger(team) || team < 0 || team >= this.teams) return false;
    m.state.team = team;
    return true;
  }

  /** Players on each team now (team modes). */
  teamSizes(): number[] {
    const sizes = new Array<number>(this.teams).fill(0);
    for (const m of this.players) if (m && m.state.team >= 0 && m.state.team < this.teams) sizes[m.state.team]!++;
    return sizes;
  }

  /** A newcomer's team: a party mate's while it's at most one bigger than the smallest; else the smallest (lowest index). */
  private pickTeam(p: PlayerState): number {
    const sizes = this.teamSizes();
    const min = Math.min(...sizes);
    const group = this.groupOf?.(p.id) ?? null;
    if (group) {
      for (const m of this.players) {
        if (!m || m.state === p || m.state.team < 0 || this.groupOf?.(m.id) !== group) continue;
        if (sizes[m.state.team]! <= min + 1) return m.state.team;
      }
    }
    return sizes.indexOf(min);
  }

  /**
   * Countdown: even the teams out (no team more than one bigger than another). Bots move first, then
   * humans with no party mate on their team, the newest first.
   */
  private balanceTeams(): void {
    for (let guard = 0; guard < MAX_PLAYERS; guard++) {
      const sizes = this.teamSizes();
      const max = Math.max(...sizes);
      const min = Math.min(...sizes);
      if (max - min <= 1) return;
      const from = sizes.indexOf(max);
      const to = sizes.indexOf(min);
      const on = this.players.filter((m): m is MatchPlayer => m !== null && m.state.team === from);
      const loner = (m: MatchPlayer) => {
        const g = this.groupOf?.(m.id) ?? null;
        return !g || !on.some((o) => o !== m && this.groupOf?.(o.id) === g);
      };
      const pick = on.filter((m) => m.isBot).sort((a, b) => b.key - a.key)[0] ?? on.filter(loner).sort((a, b) => b.key - a.key)[0] ?? on.sort((a, b) => b.key - a.key)[0];
      if (!pick) return;
      pick.state.team = to;
    }
  }

  private resetTeamScores(): void {
    this.teamScores = new Array<number>(this.rules.teams).fill(0);
    this.teamScoreTicks = new Array<number>(this.rules.teams).fill(0);
  }

  private addTeamScore(team: number, delta: number): void {
    if (team < 0 || team >= this.teams) return;
    this.teamScores[team]! += delta;
    this.teamScoreTicks[team] = this.tick;
  }

  /** The leading team: most score, then the earliest to reach it; −1 on a level tie (a draw) or with no teams. */
  leadingTeam(): number {
    let best = -1;
    let draw = false;
    for (let t = 0; t < this.teams; t++) {
      if (best < 0 || this.teamScores[t]! > this.teamScores[best]!) {
        best = t;
        draw = false;
      } else if (this.teamScores[t] === this.teamScores[best]) draw = true;
    }
    return draw ? -1 : best;
  }

  /** Inputs reach the sim (warm-up and the match itself); otherwise everyone is frozen. */
  get live(): boolean {
    return this.phase === MatchPhase.Waiting || this.phase === MatchPhase.InProgress;
  }

  /** Length of a timed phase in ticks, 0 when untimed. */
  phaseLength(phase: MatchPhase = this.phase): number {
    const r = this.rules;
    switch (phase) {
      case MatchPhase.Countdown:
        return ticks(r.countdown);
      case MatchPhase.InProgress:
        return ticks(r.timeLimit);
      case MatchPhase.Ending:
        return ticks(r.ending);
      case MatchPhase.Postgame:
        return ticks(r.postgame);
      default:
        return 0;
    }
  }

  /** Ticks until the current timed phase ends (0 when untimed). */
  get ticksLeft(): number {
    const n = this.phaseLength();
    return n > 0 ? Math.max(0, n - this.phaseTick) : 0;
  }

  // ── commands (lobby UI / network); transitions happen at the end of the next step ──

  setReady(id: number, ready = true): void {
    this.sync();
    const m = this.players[id];
    if (m && this.phase === MatchPhase.Waiting) m.ready = ready;
  }

  /** Host: start the countdown without waiting for ready-up. Needs minPlayers on the next step, else it is dropped. */
  start(): void {
    if (this.phase === MatchPhase.Waiting) this.startRequested = true;
  }

  voteRematch(id: number): void {
    this.sync();
    const m = this.players[id];
    if (m && (this.phase === MatchPhase.Ending || this.phase === MatchPhase.Postgame)) m.rematch = true;
  }

  /**
   * Host: everyone back to the lobby (abandons a running match without results). Like every
   * command it takes effect at the end of the next step, so its phase event is in that step's events.
   */
  returnToLobby(): void {
    if (this.phase !== MatchPhase.Waiting && this.phase !== MatchPhase.Closed) this.lobbyRequested = true;
  }

  /** Advances one tick: `inputs` as for Game.step. */
  step(inputs: ReadonlyArray<Readonly<Input> | undefined>): void {
    this.events.length = 0;
    this.sync();
    this.game.inputsFrozen = !this.live;
    this.game.step(this.live ? inputs : this.freeze(inputs));
    if (this.phase === MatchPhase.InProgress) this.score();
    this.tick++;
    this.phaseTick++;
    this.advance();
  }

  /** Current standings, best first (also the scoreboard order). */
  standings(): MatchStanding[] {
    const list: MatchPlayer[] = [];
    for (const m of this.players) if (m) list.push(m);
    list.push(...this.departed);
    list.sort(compareStandings);
    const out = list.map(
      (m, i): MatchStanding => ({
        placement: i + 1,
        id: m.id,
        key: m.key,
        name: m.name,
        isBot: m.isBot,
        left: m.left,
        score: m.score,
        kills: m.kills,
        deaths: m.deaths,
        suicides: m.suicides,
        assists: m.assists,
        damageDealt: Math.round(m.damageDealt),
        damageTaken: Math.round(m.damageTaken),
        headshots: m.headshots,
        bestStreak: m.bestStreak,
        rating: m.rating,
        mvp: false,
        team: this.teams > 0 ? m.state.team : -1,
      }),
    );
    // highest positive rating; ties go to the better placement
    let mvp: MatchStanding | undefined;
    for (const s of out) if (s.rating > 0 && (!mvp || s.rating > mvp.rating)) mvp = s;
    if (mvp) mvp.mvp = true;
    return out;
  }

  humanCount(): number {
    let n = 0;
    for (const m of this.players) if (m && !m.isBot) n++;
    return n;
  }

  /** Keeps the roster in step with game.players (joins, leaves, slots reused by someone else). */
  private sync(): void {
    const players = this.game.players;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const p = players[id] ?? null;
      const m = this.players[id] ?? null;
      if ((m?.state ?? null) === p) continue;
      if (m) {
        m.left = true;
        if (this.phase === MatchPhase.InProgress) this.departed.push(m);
      }
      this.players[id] = p ? new MatchPlayer(id, this.joins++, p, this.tick) : null;
      // team modes: a newcomer (bots too) is dealt onto a team at once
      if (p && this.teams > 0 && (p.team < 0 || p.team >= this.teams)) p.team = this.pickTeam(p);
    }
  }

  private freeze(inputs: ReadonlyArray<Readonly<Input> | undefined>): ReadonlyArray<Input | undefined> {
    const players = this.game.players;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const src = inputs[id] ?? players[id]?.input;
      if (!src) {
        this.frozenRefs[id] = undefined;
        continue;
      }
      const f = this.frozen[id]!;
      f.buttons = 0;
      f.aim = src.aim;
      f.weaponSelect = 0;
      f.throwStrength = src.throwStrength;
      f.dashStrength = src.dashStrength;
      this.frozenRefs[id] = f;
    }
    return this.frozenRefs;
  }

  private score(): void {
    for (const e of this.game.events) {
      if (e.type === 'hit') this.onHit(e.attacker, e.target, e.damage, e.zone);
      else if (e.type === 'death') this.onDeath(e.victim, e.killer, e.source);
    }
  }

  private onHit(attacker: number, target: number, damage: number, zone: number): void {
    const victim = this.players[target];
    if (!victim) return;
    victim.damageTaken += damage;
    const by = this.players[attacker];
    if (!by || by === victim) return;
    by.damageDealt += damage;
    if (zone === HitZone.Head) by.headshots++;
    const hits = victim.recentHits;
    while (hits.length && hits[0]!.tick <= this.tick - ASSIST_WINDOW_TICKS) hits.shift();
    hits.push({ attacker: by, damage, tick: this.tick });
  }

  private onDeath(victimId: number, killerId: number, source: number): void {
    const victim = this.players[victimId];
    if (!victim) return;
    victim.deaths++;
    victim.streak = 0;
    let killer: MatchPlayer | null = null;
    if (killerId === victimId) {
      victim.suicides++;
      this.addScore(victim, -1); // docs/03 §8: −1 suicide
      this.addTeamScore(victim.state.team, -1);
    } else {
      killer = this.players[killerId] ?? null;
      if (killer) {
        killer.kills++;
        killer.streak++;
        killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
        this.addScore(killer, 1);
        this.addTeamScore(killer.state.team, 1);
      }
    }
    const assists = this.creditAssists(victim, killer);
    victim.recentHits.length = 0;
    this.events.push({ type: 'kill', killer: killerId, victim: victimId, source, assists, streak: killer ? killer.streak : 0 });
  }

  private creditAssists(victim: MatchPlayer, killer: MatchPlayer | null): number[] {
    const since = this.tick - ASSIST_WINDOW_TICKS;
    const seen: MatchPlayer[] = [];
    const out: number[] = [];
    for (const hit of victim.recentHits) {
      const a = hit.attacker;
      if (seen.includes(a)) continue;
      seen.push(a);
      if (a === killer || this.players[a.id] !== a) continue;
      let sum = 0;
      for (const h of victim.recentHits) if (h.attacker === a && h.tick > since) sum += h.damage;
      if (sum >= ASSIST_MIN_DAMAGE) {
        a.assists++;
        out.push(a.id);
      }
    }
    return out;
  }

  private addScore(m: MatchPlayer, delta: number): void {
    m.score += delta;
    m.scoreTick = this.tick;
  }

  private topScore(): number {
    let top = -Infinity;
    for (const m of this.players) if (m && m.score > top) top = m.score;
    return top;
  }

  private playerCount(): number {
    let n = 0;
    for (const m of this.players) if (m) n++;
    return n;
  }

  /** True when there is at least one human and every human passes. Bot-only rooms need start(). */
  private everyHuman(test: (m: MatchPlayer) => boolean): boolean {
    let humans = 0;
    for (const m of this.players) {
      if (!m || m.isBot) continue;
      if (!test(m)) return false;
      humans++;
    }
    return humans > 0;
  }

  private advance(): void {
    const r = this.rules;
    if (this.lobbyRequested) {
      for (const m of this.players) if (m) m.ready = false;
      this.enter(MatchPhase.Waiting);
      return;
    }
    switch (this.phase) {
      case MatchPhase.Waiting:
        if (this.playerCount() >= r.minPlayers && (this.startRequested || this.everyHuman((m) => m.ready))) this.enter(MatchPhase.Countdown);
        else this.startRequested = false; // a start with too few players is refused, not remembered
        break;
      case MatchPhase.Countdown:
        if (this.playerCount() < r.minPlayers) this.enter(MatchPhase.Waiting);
        else if (this.phaseTick >= this.phaseLength()) this.enter(MatchPhase.InProgress);
        break;
      case MatchPhase.InProgress:
        if (r.killLimit > 0 && (this.teams > 0 ? Math.max(...this.teamScores) : this.topScore()) >= r.killLimit) this.finish(MatchEndReason.KillLimit);
        else if (r.timeLimit > 0 && this.phaseTick >= this.phaseLength()) this.finish(MatchEndReason.TimeLimit);
        break;
      case MatchPhase.Ending:
      case MatchPhase.Postgame: {
        if (this.everyHuman((m) => m.rematch)) this.rematch();
        else if (this.phaseTick < this.phaseLength()) break;
        else if (this.phase === MatchPhase.Ending) this.enter(MatchPhase.Postgame);
        else if (this.players.some((m) => m?.rematch) || r.onNoRematch === 'lobby') this.rematch();
        else this.enter(MatchPhase.Closed);
        break;
      }
      default:
        break;
    }
  }

  private enter(phase: MatchPhase): void {
    const prev = this.phase;
    this.phase = phase;
    this.phaseTick = 0;
    this.startRequested = false;
    this.lobbyRequested = false;
    if (phase === MatchPhase.Countdown) this.beginMatch();
    if (phase === MatchPhase.InProgress) {
      this.number++;
      this.results = null;
      this.endReason = MatchEndReason.None;
    }
    if (phase === MatchPhase.Waiting) {
      this.departed.length = 0;
      for (const m of this.players) if (m) m.rematch = false;
    }
    this.events.push({ type: 'phase', phase, prev });
  }

  /** Countdown entry: spawn assignment and loadout lock (docs/06 §5.2), fresh stats. */
  private beginMatch(): void {
    this.departed.length = 0;
    if (this.teams > 0) this.balanceTeams();
    this.resetTeamScores();
    const game = this.game;
    for (const g of game.grenades) g.alive = false;
    resetPickups(game); // warm-up items gone, spawners start over
    for (const c of game.clouds) c.alive = false;
    // Everyone dead first, then respawned in id order: each spawn is the farthest from those placed before it.
    for (const p of game.players) if (p) p.alive = false;
    for (const p of game.players) {
      if (!p) continue;
      p.keptGuns = [NO_WEAPON, NO_WEAPON]; // a new match starts everyone on their own loadout, not the warm-up's crate guns
      game.respawn(p);
      p.kills = 0;
      p.deaths = 0;
    }
    for (const m of this.players) m?.resetStats(this.tick);
  }

  private finish(reason: MatchEndReason): void {
    this.endReason = reason;
    const standings = this.standings();
    this.results = {
      number: this.number,
      reason,
      durationTicks: this.phaseTick,
      winnerKey: standings[0]?.key ?? -1,
      mvpKey: standings.find((s) => s.mvp)?.key ?? -1,
      standings,
      teamScores: this.teamScores.slice(),
      winnerTeam: this.teams > 0 ? this.leadingTeam() : -1,
    };
    this.enter(MatchPhase.Ending);
  }

  /** Same room, same players: voters start the next lobby ready. */
  private rematch(): void {
    for (const m of this.players) if (m) m.ready = m.rematch;
    this.enter(MatchPhase.Waiting);
  }
}

/** Match state folded into a game state hash (golden replays of whole matches). */
export function hashMatch(match: Match, gameHash: number): number {
  const f = new Fnv32();
  f.int(gameHash);
  f.int(match.tick);
  f.int(match.phase);
  f.int(match.phaseTick);
  f.int(match.number);
  f.int(match.endReason);
  const player = (m: MatchPlayer): void => {
    f.int(m.id);
    f.int(m.key);
    f.bool(m.ready);
    f.bool(m.rematch);
    f.bool(m.left);
    f.int(m.score);
    f.int(m.kills);
    f.int(m.deaths);
    f.int(m.suicides);
    f.int(m.assists);
    f.fx(m.damageDealt);
    f.fx(m.damageTaken);
    f.int(m.headshots);
    f.int(m.streak);
    f.int(m.bestStreak);
    f.int(m.scoreTick);
    f.int(m.recentHits.length);
  };
  for (const m of match.players) {
    if (m) player(m);
    else f.int(-1);
  }
  for (const m of match.departed) player(m);
  // team modes only (a free-for-all hashes as it always did)
  for (const t of match.teamScores) f.int(t);
  const r = match.results;
  f.int(r ? r.number : -2);
  f.int(r ? r.winnerKey : -2);
  f.int(r ? r.mvpKey : -2);
  if (r) for (const s of r.standings) f.int(s.key);
  return f.h >>> 0;
}
