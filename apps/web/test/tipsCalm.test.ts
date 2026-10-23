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
