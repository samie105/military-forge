/**
 * Match → shell view model (docs/06 §4, layer L4). The game loop calls `matchView` every frame;
 * the shell store only changes (and React only re-renders) when `sameView` says something visible did.
 */
import { MatchEndReason, MatchPhase, TICK_RATE, type Match, type MatchResults, type MatchStanding } from '@military-forge/sim';

export interface MatchView {
  phase: MatchPhase;
  /** the match counting down, being played or last finished: 1 for the room's first */
  number: number;
  /** whole seconds left in the current timed phase, 0 when untimed */
  secondsLeft: number;
  /** IN_PROGRESS with no time limit: the clock shows elapsed time instead */
  untimed: boolean;
  /** whole seconds played, only while `untimed` (0 otherwise, so timed matches don't re-render twice a second) */
  secondsElapsed: number;
  killLimit: number;
  /** the time limit in seconds (0 = none) */
  timeLimit: number;
  /** the countdown's length in seconds (the countdown ring) */
  countdownTotal: number;
  /** the map's name ("Lunar Outpost") */
  mapName: string;
  localId: number;
  myScore: number;
  leaderScore: number;
  /** who leads (ties: the first in the standings); '' when nobody plays */
  leaderName: string;
  /** WAITING: you are ready */
  ready: boolean;
  /** ENDING/POSTGAME: rematch votes so far, humans who can vote, and whether you voted */
  votes: number;
  humans: number;
  voted: boolean;
  /** final results of the last match (ENDING onwards, and in the lobby after it) */
  results: MatchResults | null;
  /** team modes (v21): 0 = free-for-all, else 2–4 teams */
  teams?: number;
  /** team modes: each team's score now (the final ones once ended); empty in a free-for-all */
  teamScores?: readonly number[];
  /** team modes: the local player's team, −1 = none */
  myTeam?: number;
}

export function matchView(match: Match, localId: number): MatchView {
  let leaderScore = 0;
  let leaderName = '';
  let votes = 0;
  let any = false;
  for (const m of match.players) {
    if (!m) continue;
    if (!any || m.score > leaderScore) {
      leaderScore = m.score;
      leaderName = playerName(m.name, m.isBot);
    }
    any = true;
    if (m.rematch) votes++;
  }
  const me = match.players[localId];
  const untimed = match.phase === MatchPhase.InProgress && match.phaseLength() === 0;
  return {
    phase: match.phase,
    // Match.number counts from GO; the countdown already announces the next one
    number: match.phase === MatchPhase.Countdown ? match.number + 1 : match.number,
    secondsLeft: Math.ceil(match.ticksLeft / TICK_RATE),
    untimed,
    secondsElapsed: untimed ? Math.floor(match.phaseTick / TICK_RATE) : 0,
    killLimit: match.rules.killLimit,
    timeLimit: match.rules.timeLimit,
    countdownTotal: match.rules.countdown,
    mapName: match.game.map.name,
    localId,
    myScore: me?.score ?? 0,
    leaderScore,
    leaderName,
    ready: me?.ready ?? false,
    votes,
    humans: match.humanCount(),
    voted: me?.rematch ?? false,
    results: match.results,
    teams: match.teams,
    teamScores: match.results && match.phase >= MatchPhase.Ending ? (match.results.teamScores ?? []) : match.teamScores,
    myTeam: match.teams > 0 ? (me?.state.team ?? -1) : -1,
  };
}

export function sameView(a: MatchView | null, b: MatchView | null): boolean {
  if (!a || !b) return a === b;
  for (const k of Object.keys(a) as (keyof MatchView)[]) {
    if (k === 'teamScores') {
      const x = a.teamScores ?? [];
      const y = b.teamScores ?? [];
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    } else if (a[k] !== b[k]) return false;
  }
  return true;
}

/** 0:05, 4:32, 12:00 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

export const END_REASON: Record<MatchEndReason, string> = {
  [MatchEndReason.None]: 'Match over',
  [MatchEndReason.KillLimit]: 'Kill limit reached',
  [MatchEndReason.TimeLimit]: "Time's up",
};

/**
 * The results headline for one player: "Draw" when the top score is shared and theirs is it (a 0–0
 * time-out, or a tie on points: the order underneath is only the tie-break), else "Victory" for
 * first and "2nd place"… for the rest.
 */
export function resultHeadline(me: Pick<MatchStanding, 'placement' | 'score'>, standings: readonly Pick<MatchStanding, 'score'>[]): { text: string; win: boolean } {
  const top = standings.length ? Math.max(...standings.map((s) => s.score)) : me.score;
  const tied = standings.filter((s) => s.score === top).length > 1;
  if (tied && me.score === top) return { text: 'Draw', win: false };
  return me.placement === 1 ? { text: 'Victory', win: true } : { text: `${ordinal(me.placement)} place`, win: false };
}

export function kdRatio(s: Pick<MatchStanding, 'kills' | 'deaths'>): string {
  return (s.kills / Math.max(1, s.deaths)).toFixed(2);
}

/**
 * XP placeholder until progression lands (docs/13 §R; the API's results worker will award the
 * real XP): 100 for finishing, 10 per kill, 5 per assist, 50 for winning outright (not a draw).
 */
export function placeholderXp(s: MatchStanding, won = s.placement === 1): number {
  return 100 + 10 * s.kills + 5 * s.assists + (won ? 50 : 0);
}

/** A name next to a Bot badge: the bots' own "[BOT] " tag (packages/bots) is left to the badge. */
export function playerName(name: string, bot: boolean): string {
  return bot ? name.replace(/^\[BOT\]\s*/, '') : name;
}
