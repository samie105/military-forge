import { MatchPhase } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { tipsCalm } from '../src/shell/controller';
import { createShellStore, type ShellState } from '../src/shell/store';
import type { MatchView } from '../src/shell/matchView';

const state = (over: Partial<ShellState>): ShellState => ({ ...createShellStore().getState(), title: 'off', ...over });
const match = (phase: number) => ({ phase }) as unknown as MatchView;

describe('no card over a running match (mobile audit P0-3)', () => {
  it('Home and a room\'s lobby or warm-up are calm', () => {
    expect(tipsCalm(state({ screen: { name: 'home' } }))).toBe(true);
    expect(tipsCalm(state({ screen: { name: 'room', code: 'ABCDEF' }, match: null }))).toBe(true);
    expect(tipsCalm(state({ screen: { name: 'room', code: 'ABCDEF' }, match: match(MatchPhase.Waiting) }))).toBe(true);
  });

  it('the countdown, the clock, training, First flight and any open overlay are not', () => {
    for (const phase of [MatchPhase.Countdown, MatchPhase.InProgress, MatchPhase.Ending]) expect(tipsCalm(state({ screen: { name: 'room', code: 'ABCDEF' }, match: match(phase) }))).toBe(false);
    expect(tipsCalm(state({ screen: { name: 'training' }, match: match(MatchPhase.InProgress) }))).toBe(false);
    expect(tipsCalm(state({ screen: { name: 'training', tour: 'first-flight' }, match: null }))).toBe(false);
    expect(tipsCalm(state({ screen: { name: 'home' }, overlay: 'menu' }))).toBe(false);
    expect(tipsCalm(state({ screen: { name: 'home' }, title: 'on' }))).toBe(false);
    expect(tipsCalm(state({ screen: { name: 'home' }, tips: true }))).toBe(false);
  });
});

describe('the match ends under the menu (mobile audit P1-2)', () => {
  it('from the countdown or play to the end counts; anything else does not', async () => {
    const { matchEnded } = await import('../src/shell/controller');
    const at = (phase: number) => state({ screen: { name: 'room', code: 'ABCDEF' }, match: match(phase) });
    expect(matchEnded(at(MatchPhase.InProgress), at(MatchPhase.Ending))).toBe(true);
    expect(matchEnded(at(MatchPhase.Countdown), at(MatchPhase.Postgame))).toBe(true);
    expect(matchEnded(at(MatchPhase.InProgress), at(MatchPhase.InProgress))).toBe(false);
    expect(matchEnded(at(MatchPhase.Waiting), at(MatchPhase.Countdown))).toBe(false);
    expect(matchEnded(at(MatchPhase.Ending), at(MatchPhase.Postgame))).toBe(false);
  });
});

describe('Play now (mobile audit P1-6)', () => {
  it("its room starts when it's ours, in the lobby, and full enough (bots count)", async () => {
    const { quickStartReady } = await import('../src/shell/controller');
    const lobby = (isHost: boolean, players: number, minPlayers = 2) => ({ isHost, minPlayers, players: Array.from({ length: players }, (_, i) => ({ id: i })) }) as unknown as ShellState['lobby'];
    const room = (over: Partial<ShellState>) => state({ screen: { name: 'room', code: 'ABCDEF' }, match: match(MatchPhase.Waiting), ...over });
    expect(quickStartReady(room({ lobby: lobby(true, 4) }))).toBe(true);
    expect(quickStartReady(room({ lobby: lobby(true, 1) }))).toBe(false);
    expect(quickStartReady(room({ lobby: lobby(false, 4) }))).toBe(false);
    expect(quickStartReady(room({ lobby: lobby(true, 4), match: match(MatchPhase.Countdown) }))).toBe(false);
    expect(quickStartReady(state({ screen: { name: 'home' }, lobby: lobby(true, 4) }))).toBe(false);
  });
});

