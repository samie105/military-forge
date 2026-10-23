import { describe, expect, it } from 'vitest';
import { debrief } from '../../src/tour/debrief';
import { newFacts, reduceFacts } from '../../src/tour/facts';
import { HOME_IDLE_MS, HOME_STOPS, STOPS, homeStopsDue, homeStopsWanted } from '../../src/tour/homeStops';
import type { MatchSummary } from '../../src/tour/track';

const f0 = newFacts(0);
const m = (over: Partial<MatchSummary>): MatchSummary => ({ online: false, bots: 'easy', kills: 0, deaths: {}, moves: [], firstKillAt: null, ...over });

describe('the Debrief', () => {
  it('what was done: kills and the moves used', () => {
    expect(debrief(m({ kills: 6, moves: ['dash', 'grenade', 'dash'] }), f0, null).done).toBe('6 kills · dash, grenades');
    expect(debrief(m({ kills: 1 }), f0, null).done).toBe('1 kill');
  });

  it('one thing to try, most pressing first, never blaming', () => {
    expect(debrief(m({ kills: 1, deaths: { gun: 9 } }), f0, null).tryNext).toMatch(/^Easier start\?/);
    expect(debrief(m({ kills: 3, deaths: { gas: 2 } }), f0, null).tryNext).toMatch(/^Gas: the middle kills/);
    expect(debrief(m({ kills: 3, deaths: { self: 1, grenade: 1 } }), f0, null).tryNext).toMatch(/^Hold to aim/);
    expect(debrief(m({ kills: 3 }), f0, null).tryNext).toBe("You didn't dash: dashes dodge fire.");
    expect(debrief(m({ kills: 3, moves: ['dash'] }), f0, null).tryNext).toMatch(/^No grenades/);
    expect(debrief(m({ kills: 3, moves: ['dash', 'grenade', 'take'] }), f0, null).tryNext).toBeNull();
    for (const d of [debrief(m({ deaths: { gas: 5 } }), f0, null)]) expect(d.tryNext).not.toMatch(/you keep|!/i);
  });

  it('the third line is the top Next orders card', () => {
    const card = { id: 'create-room', title: 'Play with friends', line: '', reason: '1 match solo so far', cta: 'Create room', action: { kind: 'create' as const }, score: 70 };
    expect(debrief(m({ kills: 2 }), f0, card).next).toEqual({ title: 'Play with friends', reason: '1 match solo so far' });
  });
});

describe('Home stops', () => {
  it('three stops; due after a match or for a veteran, once', () => {
    expect(STOPS.map((s) => s.id)).toEqual(['create', 'join', 'locker']);
    expect(homeStopsWanted(f0)).toBe(false);
    expect(homeStopsWanted(reduceFacts(f0, { k: 'answer', experience: 'veteran' }))).toBe(true);
    const played = reduceFacts(f0, { k: 'match', online: false, finished: true, kills: 1, deaths: {}, moves: [] });
    expect(homeStopsWanted(played)).toBe(true);
    expect(homeStopsWanted(reduceFacts(played, { k: 'tour', tour: HOME_STOPS, skipped: true }))).toBe(false);
  });

  it('never on the Home a match just ended into; only after Home sat idle (P1-5)', () => {
    expect(homeStopsDue(true, 0, 60_000)).toBe(false);
    expect(homeStopsDue(false, 1000, 1000 + HOME_IDLE_MS - 1)).toBe(false);
    expect(homeStopsDue(false, 1000, 1000 + HOME_IDLE_MS)).toBe(true);
  });
});
