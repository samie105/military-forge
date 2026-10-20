/**
 * MATCH_STATE (0x23) → the shell's view models: the same MatchView the local match produces (so the
 * countdown, status and results screens don't care where a match runs) plus the online lobby.
 */
import { maps } from '@military-forge/content';
import type { BotLevelWire, MatchStateMsg } from '@military-forge/protocol';
import { MatchPhase, TICK_RATE, type MatchResults } from '@military-forge/sim';
import { playerName, type MatchView } from './matchView';

/** What the shell reads from an online mode (onlineMode.ts implements it). */
export interface OnlineSource {
  readonly room: string;
  readonly localId: number;
  readonly matchState: MatchStateMsg | null;
  serverTickNow(now?: number): number;
}

export interface LobbyPlayer {
  id: number;
  name: string;
  /** a bot filling the room ([BOT] name): never ready, never needs to be */
  isBot: boolean;
  ready: boolean;
  host: boolean;
  you: boolean;
  /** -1 = not reported yet */
  pingMs: number;
}

export interface LobbyView {
  code: string;
  players: LobbyPlayer[];
  isHost: boolean;
  /** you are ready */
  ready: boolean;
  /** players needed to start (bots count) */
  minPlayers: number;
  timeLimit: number;
  killLimit: number;
  mapId: string;
  mapName: string;
  /** the room's bots: the players they fill it up to (0 = no bots), and their level (v17) */
  bots: number;
  botLevel: BotLevelWire;
}

const ENDED = new Set<number>([MatchPhase.Ending, MatchPhase.Postgame, MatchPhase.Closed]);

function phaseLength(s: MatchStateMsg, phase = s.phase): number {
  switch (phase) {
    case MatchPhase.Countdown:
      return s.rules.countdown * TICK_RATE;
    case MatchPhase.InProgress:
      return s.rules.timeLimit * TICK_RATE;
    case MatchPhase.Ending:
      return s.rules.ending * TICK_RATE;
    case MatchPhase.Postgame:
      return s.rules.postgame * TICK_RATE;
    default:
      return 0;
  }
}

const resultsCache = new WeakMap<MatchStateMsg, MatchResults | null>();

/** The final standings with placements, as the results screen reads them (one object per MATCH_STATE). */
function resultsOf(s: MatchStateMsg): MatchResults | null {
  if (resultsCache.has(s)) return resultsCache.get(s)!;
  const results = buildResults(s);
  resultsCache.set(s, results);
  return results;
}

function buildResults(s: MatchStateMsg): MatchResults | null {
  if (!s.results) return null;
  return {
    number: s.results.number,
    reason: s.results.reason as MatchResults['reason'],
    durationTicks: s.results.durationTicks,
    winnerKey: s.results.winnerKey,
    mvpKey: s.results.mvpKey,
    standings: s.standings.map((r, i) => ({ ...r, placement: i + 1, rating: 0 })),
  };
}

export function onlineMatchView(src: OnlineSource, now = performance.now()): MatchView | null {
  const s = src.matchState;
  if (!s) return null;
  const me = src.localId;
  const elapsed = Math.max(0, src.serverTickNow(now) - s.phaseStartTick);
  const length = phaseLength(s);
  const untimed = s.phase === MatchPhase.InProgress && length === 0;
  let leaderScore = 0;
  let leaderName = '';
  let myScore = 0;
  s.standings.forEach((r, i) => {
    if (i === 0 || r.score > leaderScore) {
      leaderScore = r.score;
      leaderName = playerName(r.name, r.isBot);
    }
    if (r.id === me && !r.left) myScore = r.score;
  });
  const mine = s.lobby.find((p) => p.id === me);
  const humans = s.lobby.filter((p) => !s.standings.find((r) => r.id === p.id && !r.left)?.isBot).length;
  return {
    phase: s.phase as MatchView['phase'],
    number: s.phase === MatchPhase.Countdown ? s.number + 1 : s.number,
    secondsLeft: length > 0 ? Math.max(0, Math.ceil((length - elapsed) / TICK_RATE)) : 0,
    untimed,
    secondsElapsed: untimed ? Math.floor(elapsed / TICK_RATE) : 0,
    killLimit: s.rules.killLimit,
    timeLimit: s.rules.timeLimit,
    countdownTotal: s.rules.countdown,
    mapName: maps[s.mapId]?.name ?? s.mapId,
    localId: me,
    myScore,
    leaderScore,
    leaderName,
    ready: mine?.ready ?? false,
    votes: s.lobby.filter((p) => p.rematch).length,
    humans,
    voted: mine?.rematch ?? false,
    // the results table shows the final standings, which only travel from ENDING on
    results: ENDED.has(s.phase) ? resultsOf(s) : null,
  };
}

export function lobbyView(src: OnlineSource): LobbyView | null {
  const s = src.matchState;
  if (!s) return null;
  const me = src.localId;
  const players = s.lobby.map((p): LobbyPlayer => {
    const row = s.standings.find((r) => r.id === p.id && !r.left);
    return { id: p.id, name: row?.name ?? `Player ${p.id + 1}`, isBot: row?.isBot ?? false, ready: p.ready, host: p.id === s.hostId, you: p.id === me, pingMs: p.pingMs };
  });
  // host first, then join order (ids are slots, roughly join order)
  players.sort((a, b) => Number(b.host) - Number(a.host) || a.id - b.id);
  return {
    code: src.room,
    players,
    isHost: s.hostId === me && me >= 0,
    ready: s.lobby.find((p) => p.id === me)?.ready ?? false,
    minPlayers: s.rules.minPlayers,
    timeLimit: s.rules.timeLimit,
    killLimit: s.rules.killLimit,
    mapId: s.mapId,
    mapName: maps[s.mapId]?.name ?? s.mapId,
    bots: s.rules.bots,
    botLevel: s.rules.botLevel,
  };
}

export function sameLobby(a: LobbyView | null, b: LobbyView | null): boolean {
  if (!a || !b) return a === b;
  if (a.players.length !== b.players.length) return false;
  for (const k of ['code', 'isHost', 'ready', 'minPlayers', 'timeLimit', 'killLimit', 'mapId', 'bots', 'botLevel'] as const) if (a[k] !== b[k]) return false;
  return a.players.every((p, i) => {
    const q = b.players[i]!;
    return p.id === q.id && p.name === q.name && p.isBot === q.isBot && p.ready === q.ready && p.host === q.host && p.you === q.you && p.pingMs === q.pingMs;
  });
}
