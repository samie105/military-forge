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
}

/** A player in the room right now: lobby flags and the ping their client reports. */
export interface MatchLobbyEntry {
  id: number;
  ready: boolean;
  rematch: boolean;
  /** round-trip time the player's client measured, ms; -1 = not reported yet */
  pingMs: number;
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
}

/** What a host may set in a custom room (docs/07 §5.2): limits in seconds / score, 0 = off. */
export const ROOM_SETTING_LIMITS = {
  timeLimit: { min: 60, max: 1200 },
  killLimit: { min: 5, max: 100 },
} as const;

const MAX_LOBBY = 31;
const MAX_STANDINGS = 63;
const NO_KEY = 0xffff;
const NO_PING = 1023;

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
  return { type: MsgType.MatchState, phase, phaseStartTick, number, endReason, rules, mapId, hostId, lobby, standings, results };
}
