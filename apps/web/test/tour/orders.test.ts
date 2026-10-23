import { describe, expect, it } from 'vitest';
import { newFacts, reduceFacts, type FactEvent, type Facts } from '../../src/tour/facts';
import { FIRST_FLIGHT } from '../../src/tour/flight';
import { COOL_DOWN_MS, MAX_CARDS, fieldManual, novelty, recommend, type OrdersContext } from '../../src/tour/orders';

const NOW = 1_800_000_000_000;
const ctx: OrdersContext = { offline: false, touch: false, pad: false, drillDone: false };
const facts = (...events: FactEvent[]): Facts => events.reduce(reduceFacts, newFacts(NOW));
const match = (n = 1, moves: ('dash' | 'grenade' | 'take')[] = []): FactEvent[] => Array.from({ length: n }, () => ({ k: 'match', online: false, finished: true, kills: 1, deaths: {}, moves }));
const ids = (f: Facts, c = ctx, now = NOW) => recommend(f, c, now).map((x) => x.id);

describe('Next orders: recommend()', () => {
  it('a recruit part-way through First flight: Finish First flight on top', () => {
    const f = facts({ k: 'answer', experience: 'recruit' }, { k: 'tour', tour: FIRST_FLIGHT, step: 'run' });
    expect(ids(f)[0]).toBe('finish-flight');
    expect(recommend(f, ctx, NOW)[0]!.reason).toBe('1 of 5 done');
  });

  it('a recruit who flew: Live fire vs Easy bots; after a match, Play with friends', () => {
    const f = facts({ k: 'answer', experience: 'recruit' }, { k: 'tour', tour: FIRST_FLIGHT, finished: true });
    expect(ids(f)[0]).toBe('live-fire-easy');
    expect(recommend(f, ctx, NOW)[0]!.action).toEqual({ kind: 'train', bots: 'easy' });
    const g = facts({ k: 'answer', experience: 'recruit' }, { k: 'tour', tour: FIRST_FLIGHT, finished: true }, ...match(1));
    expect(ids(g)).not.toContain('live-fire-easy');
    expect(ids(g)[0]).toBe('create-room');
  });

  it('a veteran: Live fire vs Normal bots on top, First flight offered low', () => {
    const f = facts({ k: 'answer', experience: 'veteran' });
    expect(ids(f)[0]).toBe('live-fire-normal');
    expect(ids(f)).toContain('customise');
    expect(ids(facts({ k: 'answer', experience: 'veteran' }, { k: 'soldier-saved' }))).toContain('flight-replay');
  });

  it('at most three, best first; deterministic', () => {
    const f = facts({ k: 'answer', experience: 'veteran' }, ...match(3));
    const r = recommend(f, { ...ctx, pad: true }, NOW);
    expect(r.length).toBe(MAX_CARDS);
    expect(r.map((c) => c.score)).toEqual([...r.map((c) => c.score)].sort((a, b) => b - a));
    expect(recommend(f, { ...ctx, pad: true }, NOW)).toEqual(r);
  });

  it('Not now rests a card 7 days; taking one retires it', () => {
    const f = facts({ k: 'answer', experience: 'veteran' }, { k: 'card', card: 'live-fire-normal', what: 'dismissed', at: NOW });
    expect(ids(f)).not.toContain('live-fire-normal');
    expect(ids(f, ctx, NOW + COOL_DOWN_MS + 1)).toContain('live-fire-normal');
    const g = facts({ k: 'answer', experience: 'veteran' }, { k: 'card', card: 'live-fire-normal', what: 'acted', at: NOW });
    expect(ids(g, ctx, NOW + 30 * COOL_DOWN_MS)).not.toContain('live-fire-normal');
  });

  it('novelty: a card shown 3+ times without a tap sinks', () => {
    expect([novelty(0), novelty(3), novelty(6)]).toEqual([1, 0.6, 0.3]);
    const shown: FactEvent[] = Array.from({ length: 6 }, () => ({ k: 'card', card: 'live-fire-normal', what: 'shown', at: NOW }));
    const f = facts({ k: 'answer', experience: 'veteran' }, ...shown);
    expect(ids(f)[0]).not.toBe('live-fire-normal');
  });

  it('hard gates: offline hides the room cards and offers a local room; no pad, no controller card; touch cards on touch only', () => {
    const f = facts({ k: 'invited' }, ...match(2));
    expect(ids(f)).toContain('create-room');
    const off = ids(f, { ...ctx, offline: true });
    expect(off).not.toContain('create-room');
    expect(off).not.toContain('join-code');
    const quiet = facts({ k: 'soldier-saved' }, ...match(2, ['dash', 'grenade', 'take']));
    expect(ids(quiet, { ...ctx, offline: true })).toContain('host-local');
    expect(ids(quiet)).not.toContain('host-local');
    const taps = facts(...match(1), { k: 'touch', missedTaps: 12 });
    expect(ids(taps)).not.toContain('claw');
    const claw = recommend(taps, { ...ctx, touch: true }, NOW).find((c) => c.id === 'claw');
    expect(claw?.score).toBe(65 * 1.5); // twice the threshold: relevance 1.5
  });

  it('a move never used in 2+ matches; two wins in a row: harder bots', () => {
    const f = facts({ k: 'soldier-saved' }, { k: 'room', how: 'created' }, ...match(2, ['grenade', 'take']));
    expect(ids(f)).toContain('try-dash');
    expect(ids(f)).not.toContain('try-grenade');
    const w: FactEvent[] = [1, 2].map(() => ({ k: 'match', online: false, finished: true, won: true, kills: 5, deaths: {}, moves: ['dash', 'grenade', 'take'] }));
    expect(ids(facts({ k: 'soldier-saved' }, { k: 'room', how: 'created' }, ...w))[0]).toBe('harder-bots');
  });
});

describe('the Field manual', () => {
  it('six items from the facts; Every control is optional', () => {
    expect(fieldManual(newFacts(NOW), false).map((m) => m.done)).toEqual([false, false, false, false, false, false]);
    const f = facts({ k: 'tour', tour: FIRST_FLIGHT, finished: true }, ...match(1), { k: 'soldier-saved' }, { k: 'room', how: 'joined' });
    const m = fieldManual(f, true);
    expect(m.map((x) => x.done)).toEqual([true, true, true, true, true, true]);
    expect(m.find((x) => x.id === 'controls')?.optional).toBe(true);
  });
});
