import { describe, expect, it } from 'vitest';
import { CmdKind, DecodeError, MsgType, decodeMessage, encodeCmd, encodeMatchState, isUnreliableMessage, type MatchStateMsg } from '../src';

const state = (over: Partial<Omit<MatchStateMsg, 'type'>> = {}): Omit<MatchStateMsg, 'type'> => ({
  phase: 2,
  phaseStartTick: 4_000_000_123,
  number: 3,
  endReason: 0,
  rules: { timeLimit: 300, killLimit: 20, countdown: 5, ending: 10, postgame: 15, minPlayers: 2, onNoRematch: 'lobby' },
  mapId: 'movement-test',
  hostId: 4,
  lobby: [
    { id: 4, ready: true, rematch: false, pingMs: 48 },
    { id: 0, ready: false, rematch: true, pingMs: -1 },
  ],
  standings: [
    { id: 4, key: 7, name: 'Ọlá', isBot: false, left: false, mvp: true, score: 12, kills: 13, deaths: 4, suicides: 1, assists: 2, damageDealt: 1534, damageTaken: 410, headshots: 5, bestStreak: 6 },
    { id: 0, key: 0, name: 'Kemi 🚀', isBot: false, left: true, mvp: false, score: -2, kills: 0, deaths: 9, suicides: 2, assists: 0, damageDealt: 0, damageTaken: 999_999, headshots: 0, bestStreak: 0 },
  ],
  results: null,
  ...over,
});

describe('MATCH_STATE (0x23)', () => {
  it('round-trips phase, timers, rules, host, lobby flags, standings and results', () => {
    const m = state();
    expect(decodeMessage(encodeMatchState(m))).toEqual({ type: MsgType.MatchState, ...m });
    const ended = state({ phase: 3, endReason: 1, results: { number: 3, reason: 1, durationTicks: 21_600, winnerKey: 7, mvpKey: -1 }, hostId: -1 });
    expect(decodeMessage(encodeMatchState(ended))).toEqual({ type: MsgType.MatchState, ...ended });
    const empty = state({ lobby: [], standings: [], rules: { ...state().rules, timeLimit: 0, killLimit: 0, onNoRematch: 'close' } });
    expect(decodeMessage(encodeMatchState(empty))).toEqual({ type: MsgType.MatchState, ...empty });
  });

  it('is reliable, compact, and clamps what does not fit', () => {
    const bytes = encodeMatchState(state());
    expect(isUnreliableMessage(bytes)).toBe(false);
    expect(bytes.length).toBeLessThan(120);
    const big = decodeMessage(encodeMatchState(state({ lobby: [{ id: 1, ready: false, rematch: false, pingMs: 5000 }] }))) as MatchStateMsg;
    expect(big.lobby[0]!.pingMs).toBe(1022);
    // 16 live players + departed ones: at most 63 rows, best first
    const many = Array.from({ length: 70 }, (_, i) => ({ ...state().standings[0]!, key: i, mvp: false }));
    const got = decodeMessage(encodeMatchState(state({ standings: many }))) as MatchStateMsg;
    expect(got.standings).toHaveLength(63);
    expect(got.standings[62]!.key).toBe(62);
  });

  it('lobby commands are plain CMDs', () => {
    expect(decodeMessage(encodeCmd(CmdKind.Ready, '1'))).toEqual({ type: MsgType.Cmd, kind: CmdKind.Ready, payload: '1' });
    const settings = JSON.stringify({ timeLimit: 180, killLimit: 10, mapId: 'movement-test' });
    expect(decodeMessage(encodeCmd(CmdKind.MatchSettings, settings))).toMatchObject({ kind: 8, payload: settings });
    expect(new Set(Object.values(CmdKind)).size).toBe(Object.keys(CmdKind).length);
  });

  it('never throws anything but DecodeError on garbage (fuzz)', () => {
    let s = 7;
    const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const valid = encodeMatchState(state());
    for (let i = 0; i < 5000; i++) {
      // random bytes, and truncated or bit-flipped real messages
      const bytes = i % 2 ? valid.slice(0, Math.floor(rand() * valid.length)) : new Uint8Array(Math.floor(rand() * 96)).map(() => Math.floor(rand() * 256));
      if (i % 4 === 3 && bytes.length > 1) bytes[1 + Math.floor(rand() * (bytes.length - 1))]! ^= 1 << Math.floor(rand() * 8);
      if (bytes.length > 0) bytes[0] = MsgType.MatchState;
      try {
        decodeMessage(bytes);
      } catch (e) {
        expect(e).toBeInstanceOf(DecodeError);
      }
    }
  });
});
