/** Presence beats (presence.ts): the room, and whether its match is on (audit C-27: a host in the lobby isn't "In a match"). */
import { MatchPhase } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { PresenceBeat, matchOn, type PresenceApi } from './presence';

function setup() {
  const beats: [string | null, boolean | undefined][] = [];
  const api: PresenceApi = {
    me: { id: 'u_me' },
    onSignIn: () => () => {},
    beatPresence: async (room, playing) => void beats.push([room, playing]),
    clearPresence: async () => {},
  };
  const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: () => {} };
  const win = { addEventListener: () => {} };
  const state = { room: null as string | null, phase: MatchPhase.Waiting as number };
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());
  const beat = new PresenceBeat(api, () => state.room, doc, win, 60_000, {
    playing: () => matchOn(state.phase),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  return { beats, state, changed, beat };
}

describe('presence', () => {
  it('a match is on from the countdown to the scoreboard; the lobby and the rematch vote are not', () => {
    expect([MatchPhase.Waiting, MatchPhase.Countdown, MatchPhase.InProgress, MatchPhase.Ending, MatchPhase.Postgame].map(matchOn)).toEqual([false, true, true, true, false]);
    expect(matchOn(null)).toBe(false);
  });

  it('beats with the room and whether its match is on, again at once when that changes, and only then', () => {
    const { beats, state, changed, beat } = setup();
    expect(beats).toEqual([[null, undefined]]);
    state.room = 'KMTXRA';
    beat.update();
    expect(beats.at(-1)).toEqual(['KMTXRA', false]);
    changed();
    expect(beats).toHaveLength(2);
    state.phase = MatchPhase.Countdown;
    changed();
    expect(beats.at(-1)).toEqual(['KMTXRA', true]);
    state.phase = MatchPhase.InProgress;
    changed();
    expect(beats).toHaveLength(3);
    state.phase = MatchPhase.Postgame;
    changed();
    expect(beats.at(-1)).toEqual(['KMTXRA', false]);
  });
});
