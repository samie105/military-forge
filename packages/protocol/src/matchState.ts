/**
 * MATCH_STATE (0x23, reliable, server → client): a room's match lifecycle (docs/06 §5.2,
 * packages/sim match.ts) for the lobby, countdown, scoreboard and results screens.
 *
 * Sent to everyone when something visible changes (phase, ready flags, a kill, host settings, a
 * join or leave), every 2 s for the damage and ping columns, and to each client right after its
 * WELCOME. Timers are not counted down on the wire: `phaseStartTick` + the rules give every
 * deadline, and clients apply the same input freeze to their prediction (docs/06 §5.2: frozen
 * outside WAITING and IN_PROGRESS).
 *
 * Client → server lobby commands travel as CMDs (CmdKind.Ready … Leave in messages.ts).
 */
import { BitReader, BitWriter, DecodeError } from './bitstream';
import { MsgType, pid, unPid } from './wire';

/** Host settings that travel with every MATCH_STATE (MatchRules from packages/sim). */
export interface MatchRulesWire {
  /** seconds of play, 0 = no time limit */
  timeLimit: number;
  /** score that ends the match, 0 = none */
  killLimit: number;
  countdown: number;
  ending: number;
  postgame: number;
  minPlayers: number;
  onNoRematch: 'close' | 'lobby';
  /** the room's bots (v17): the players bots fill it up to, 0 = no bots (the host's room setting) */
  bots: number;
  /** their level (v17) */
  botLevel: BotLevelWire;
}

/** Bot levels on the wire (packages/bots BOT_LEVELS ids), by index. */
export const BOT_LEVELS_WIRE = ['easy', 'normal', 'hard'] as const;
export type BotLevelWire = (typeof BOT_LEVELS_WIRE)[number];

/** A player in the room right now: lobby flags and the ping their client reports. */
export interface MatchLobbyEntry {
  id: number;
  ready: boolean;
  rematch: boolean;
  /** round-trip time the player's client measured, ms; -1 = not reported yet */
  pingMs: number;
  /** v21 team modes: the player's team (0-based), −1 = none (a free-for-all, or an older server) */
  team?: number;
}

/** One scoreboard row (sim MatchStanding without placement, which is the list order, and rating). */
export interface MatchStandingWire {
  id: number;
  key: number;
  name: string;
  isBot: boolean;
  left: boolean;
  mvp: boolean;
  score: number;
  kills: number;
  deaths: number;
  suicides: number;
  assists: number;
  damageDealt: number;
  damageTaken: number;
  headshots: number;
  bestStreak: number;
  /** v21 team modes: the player's team, −1 = none */
  team?: number;
}

/** The last finished match (from ENDING until the next GO). Keys, not slot ids: 1st place may have left. */
export interface MatchResultsWire {
  number: number;
  reason: number;
  durationTicks: number;
  winnerKey: number;
  mvpKey: number;
}

export interface MatchStateMsg {
  type: typeof MsgType.MatchState;
  /** sim MatchPhase: 0 WAITING … 5 CLOSED */
  phase: number;
  /** the first server tick of the current phase: deadlines are phaseStartTick + the phase's length */
  phaseStartTick: number;
  /** sim Match.number: 1 from the first GO */
  number: number;
  /** sim MatchEndReason of the match that just ended (0 otherwise) */
  endReason: number;
  rules: MatchRulesWire;
  mapId: string;
  /** player id of the room's host (settings, start, back to lobby), -1 = nobody */
  hostId: number;
  lobby: MatchLobbyEntry[];
  /** best first: the live standings, or the final results' from ENDING on */
  standings: MatchStandingWire[];
  results: MatchResultsWire | null;
  /** v21: 0 = free-for-all, else 2–4 teams (MATCH_STATE's teams section; 0 from an older server) */
  teams?: number;
  /** v21: each team's score (team kills), empty in a free-for-all */
  teamScores?: number[];
  /** v21: the last match's winning team, −1 = none (no results, a draw, a free-for-all) */
  winnerTeam?: number;
}

/** What a host may set in a custom room (docs/07 §5.2): limits in seconds / score, 0 = off. */
export const ROOM_SETTING_LIMITS = {
  timeLimit: { min: 60, max: 1200 },
  killLimit: { min: 5, max: 100 },
} as const;

/** The bot fills a host may pick (players the room is kept at, 0 = no bots). */
export const ROOM_BOT_CHOICES = [0, 4, 8] as const;
/** The most a room's bot fill can say on the wire (u5). */
export const MAX_BOT_FILL = 31;

const MAX_LOBBY = 31;
const MAX_STANDINGS = 63;
const NO_KEY = 0xffff;
const NO_PING = 1023;
/** v21: a team on the wire (u3); 7 = none */
const NO_TEAM = 7;
const MAX_TEAMS_WIRE = 4;
const teamOut = (t: number | undefined) => (t === undefined || t < 0 || t >= MAX_TEAMS_WIRE ? NO_TEAM : t);
const teamIn = (t: number) => (t === NO_TEAM ? -1 : t);

const w = new BitWriter(1024);

export function encodeMatchState(m: Omit<MatchStateMsg, 'type'>): Uint8Array {
  const r = m.rules;
  w.reset()
    .u8(MsgType.MatchState)
    .unsigned(m.phase, 3)
    .u32(m.phaseStartTick)
    .u16(m.number)
    .unsigned(m.endReason, 2)
    .unsigned(r.timeLimit, 12)
    .unsigned(r.killLimit, 8)
    .unsigned(r.countdown, 5)
    .unsigned(r.ending, 6)
    .unsigned(r.postgame, 7)
    .unsigned(r.minPlayers, 5)
    .bool(r.onNoRematch === 'lobby')
    .unsigned(Math.max(0, Math.min(MAX_BOT_FILL, r.bots)), 5)
    .unsigned(Math.max(0, BOT_LEVELS_WIRE.indexOf(r.botLevel)), 2)
    .string(m.mapId)
    .unsigned(pid(m.hostId), 5);
  const lobby = m.lobby.slice(0, MAX_LOBBY);
  w.unsigned(lobby.length, 5);
  for (const e of lobby) w.unsigned(pid(e.id), 5).bool(e.ready).bool(e.rematch).unsigned(e.pingMs < 0 ? NO_PING : Math.min(NO_PING - 1, e.pingMs), 10);
  const standings = m.standings.slice(0, MAX_STANDINGS);
  w.unsigned(standings.length, 6);
  for (const s of standings) {
    w.unsigned(pid(s.id), 5)
      .unsigned(s.key < 0 ? NO_KEY : Math.min(NO_KEY - 1, s.key), 16)
      .string(s.name)
      .bool(s.isBot)
      .bool(s.left)
      .bool(s.mvp)
      .signed(s.score, 12)
      .unsigned(s.kills, 12)
      .unsigned(s.deaths, 12)
      .unsigned(s.suicides, 12)
      .unsigned(s.assists, 12)
      .unsigned(s.damageDealt, 20)
      .unsigned(s.damageTaken, 20)
      .unsigned(s.headshots, 12)
      .unsigned(s.bestStreak, 8);
  }
  const res = m.results;
  w.bool(res !== null);
  if (res) {
    w.u16(res.number)
      .unsigned(res.reason, 2)
      .u32(res.durationTicks)
      .unsigned(res.winnerKey < 0 ? NO_KEY : res.winnerKey, 16)
      .unsigned(res.mvpKey < 0 ? NO_KEY : res.mvpKey, 16);
  }
  // v21: the teams section (always written; v17–v20 decoders stop before it)
  const teams = Math.max(0, Math.min(MAX_TEAMS_WIRE, m.teams ?? 0));
  w.u8(teams);
  if (teams > 0) {
    for (let t = 0; t < teams; t++) w.signed(Math.max(-2047, Math.min(2047, m.teamScores?.[t] ?? 0)), 12);
    for (const e of lobby) w.unsigned(teamOut(e.team), 3);
    for (const st of standings) w.unsigned(teamOut(st.team), 3);
    w.unsigned(teamOut(m.winnerTeam), 3);
  }
  return w.finish().slice();
}

const key = (k: number) => (k === NO_KEY ? -1 : k);

/** Reads a MATCH_STATE body (after the type byte). Throws DecodeError on anything malformed. */
export function decodeMatchStateBody(r: BitReader): MatchStateMsg {
  const phase = r.bits(3);
  if (phase > 5) throw new DecodeError(`unknown match phase ${phase}`);
  const phaseStartTick = r.u32();
  const number = r.u16();
  const endReason = r.bits(2);
  const rules: MatchRulesWire = {
    timeLimit: r.bits(12),
    killLimit: r.bits(8),
    countdown: r.bits(5),
    ending: r.bits(6),
    postgame: r.bits(7),
    minPlayers: r.bits(5),
    onNoRematch: r.bool() ? 'lobby' : 'close',
    bots: r.bits(5),
    botLevel: BOT_LEVELS_WIRE[r.bits(2)] ?? 'normal',
  };
  const mapId = r.string();
  const hostId = unPid(r.bits(5));
  const lobby: MatchLobbyEntry[] = [];
  for (let i = r.bits(5); i > 0; i--) {
    const id = unPid(r.bits(5));
    const ready = r.bool();
    const rematch = r.bool();
    const ping = r.bits(10);
    lobby.push({ id, ready, rematch, pingMs: ping === NO_PING ? -1 : ping });
  }
  const standings: MatchStandingWire[] = [];
  for (let i = r.bits(6); i > 0; i--) {
    standings.push({
      id: unPid(r.bits(5)),
      key: key(r.bits(16)),
      name: r.string(),
      isBot: r.bool(),
      left: r.bool(),
      mvp: r.bool(),
      score: r.signed(12),
      kills: r.bits(12),
      deaths: r.bits(12),
      suicides: r.bits(12),
      assists: r.bits(12),
      damageDealt: r.bits(20),
      damageTaken: r.bits(20),
      headshots: r.bits(12),
      bestStreak: r.bits(8),
    });
  }
  let results: MatchResultsWire | null = null;
  if (r.bool()) {
    results = { number: r.u16(), reason: r.bits(2), durationTicks: r.u32(), winnerKey: key(r.bits(16)), mvpKey: key(r.bits(16)) };
  }
  // v21's teams section; a MATCH_STATE from an older server ends here (its padding is < 8 bits)
  let teams = 0;
  const teamScores: number[] = [];
  let winnerTeam = -1;
  for (const e of lobby) e.team = -1;
  for (const st of standings) st.team = -1;
  if (r.remainingBits >= 8) {
    teams = r.u8();
    if (teams > MAX_TEAMS_WIRE || teams === 1) throw new DecodeError(`bad team count ${teams}`);
    if (teams > 0) {
      for (let t = 0; t < teams; t++) teamScores.push(r.signed(12));
      for (const e of lobby) e.team = teamIn(r.bits(3));
      for (const st of standings) st.team = teamIn(r.bits(3));
      winnerTeam = teamIn(r.bits(3));
    }
  }
  return { type: MsgType.MatchState, phase, phaseStartTick, number, endReason, rules, mapId, hostId, lobby, standings, results, teams, teamScores, winnerTeam };
}
