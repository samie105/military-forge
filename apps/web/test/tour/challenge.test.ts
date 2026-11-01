/** Play now's bots that follow how the player does, and the honest pull back in after a bad loss (audit 2 P-01, P-03, P-17). */
import { describe, expect, it } from 'vitest';
import { debrief } from '../../src/tour/debrief';
import { FACTS_KEY, newFacts, playNowBotLevel, reduceFacts, sanitizeFacts, type BotLevel, type FactEvent, type Facts } from '../../src/tour/facts';
import { recommend, type OrdersContext } from '../../src/tour/orders';
import type { MatchSummary } from '../../src/tour/track';

const NOW = 1_800_000_000_000;
const ctx: OrdersContext = { offline: false, touch: false, pad: false, drillDone: false };
const facts = (...events: FactEvent[]): Facts => events.reduce(reduceFacts, newFacts(NOW));
/** a finished match against 3 bots at `bots`, placed `placement` of 4 */
const vsBots = (placement: number, bots: BotLevel = 'easy', kills = 2, at = NOW, people = 1): FactEvent => ({ k: 'match', online: true, finished: true, won: placement === 1, kills, deaths: { gun: 3 }, moves: [], placement, of: 4, people, bots, at });

describe("Play now's bots (P-01)", () => {
  it('start Easy; two top-two finishes step up, two last places step down, said once', () => {
    expect(newFacts(NOW).bots.level).toBe('easy');
    const one = facts(vsBots(2));
    expect(one.bots).toMatchObject({ level: 'easy', good: 1, moved: null });
    const two = reduceFacts(one, vsBots(1));
    expect(two.bots).toMatchObject({ level: 'normal', good: 0, moved: { to: 'normal', why: 'up' } });
    const next = reduceFacts(two, vsBots(4, 'normal'));
    expect(next.bots).toMatchObject({ level: 'normal', bad: 1, moved: null }); // said once
    expect(reduceFacts(next, vsBots(4, 'normal')).bots).toMatchObject({ level: 'easy', moved: { to: 'easy', why: 'down' } });
  });

  it('only finished matches against bots at that level count; a middle place breaks both runs', () => {
    expect(facts(vsBots(1, 'hard'), vsBots(1, 'hard')).bots.level).toBe('easy');
    expect(facts(vsBots(1), { ...vsBots(1), finished: false } as FactEvent).bots.good).toBe(1);
    expect(facts(vsBots(1), vsBots(3), vsBots(1)).bots).toMatchObject({ level: 'easy', good: 1 });
    expect(facts(vsBots(1), { ...vsBots(1), bots: null } as FactEvent).bots.good).toBe(1);
    // the top and the bottom: Hard stays Hard, Easy stays Easy
    expect(facts({ k: 'bots', level: 'hard' }, { k: 'bots', level: 'auto' }, vsBots(1, 'hard'), vsBots(1, 'hard')).bots.level).toBe('hard');
    expect(facts(vsBots(4), vsBots(4)).bots.level).toBe('easy');
  });

  it("the player's pick pins it (the rule leaves it alone); Auto gives it back", () => {
    const pinned = facts({ k: 'bots', level: 'normal' }, vsBots(1, 'normal'), vsBots(1, 'normal'));
    expect(pinned.bots).toMatchObject({ level: 'normal', pinned: true, moved: null });
    const auto = facts({ k: 'bots', level: 'normal' }, { k: 'bots', level: 'auto' }, vsBots(1, 'normal'), vsBots(1, 'normal'));
    expect(auto.bots).toMatchObject({ level: 'hard', pinned: false });
  });

  it('facts saved before it keep the level they were on: Easy under 3 finished matches, Normal after (B-30)', () => {
    expect(sanitizeFacts({ v: 1, matches: { finished: 2 } }, NOW).bots.level).toBe('easy');
    expect(sanitizeFacts({ v: 1, matches: { finished: 3 } }, NOW).bots.level).toBe('normal');
    expect(sanitizeFacts({ v: 1, matches: { finished: 9 }, bots: { level: 'hard', pinned: true } }, NOW).bots).toMatchObject({ level: 'hard', pinned: true });
    const saved = new Map([[FACTS_KEY, JSON.stringify(facts(vsBots(1), vsBots(1)))]]);
    expect(playNowBotLevel({ getItem: (k) => saved.get(k) ?? null })).toBe('normal');
    expect(playNowBotLevel(null)).toBe('easy');
  });
});

describe('after a bad loss (P-03)', () => {
  it('"One more, Easy bots" leads after a 0-kill match or last place against bots; it comes back after the next one', () => {
    const lost = facts(vsBots(4, 'normal', 0));
    const top = recommend(lost, ctx, NOW)[0]!;
    expect(top).toMatchObject({ id: 'again-easy', title: 'One more, Easy bots', cta: 'Play again', action: { kind: 'again', bots: 'easy' }, reason: 'No kills last match' });
    expect(recommend(facts(vsBots(4, 'normal', 3)), ctx, NOW)[0]!.reason).toBe('4th of 4 last match');
    expect(recommend(facts(vsBots(2, 'normal', 3)), ctx, NOW).map((c) => c.id)).not.toContain('again-easy');
    // with a friend in the room: they aren't left for easier bots
    expect(recommend(facts(vsBots(4, 'normal', 0, NOW, 2)), ctx, NOW).map((c) => c.id)).not.toContain('again-easy');
    const taken = reduceFacts(lost, { k: 'card', card: 'again-easy', what: 'acted', at: NOW + 1 });
    expect(recommend(taken, ctx, NOW).map((c) => c.id)).not.toContain('again-easy');
    const lostAgain = reduceFacts(taken, vsBots(4, 'easy', 0, NOW + 60_000));
    expect(recommend(lostAgain, ctx, NOW + 60_000)[0]!.id).toBe('again-easy');
  });

  it('Play with friends waits for a first kill: a recruit who has not scored is not sent to organise a room', () => {
    expect(recommend(facts(vsBots(3, 'easy', 0)), ctx, NOW).map((c) => c.id)).not.toContain('create-room');
    expect(recommend(facts({ ...vsBots(3, 'easy', 1), online: false } as FactEvent), ctx, NOW).map((c) => c.id)).toContain('create-room');
  });
});

describe('the Debrief speaks to the input in hand (P-03, P-17)', () => {
  const m = (over: Partial<MatchSummary>): MatchSummary => ({ online: true, bots: 'normal', kills: 0, deaths: {}, moves: [], firstKillAt: null, ...over });
  it('no kill and 3+ deaths: the easier start, with its button', () => {
    const f = newFacts(NOW);
    const d = debrief(m({ deaths: { gun: 3 } }), f, null);
    expect(d.easier).toBe(true);
    expect(d.tryNext).toBe('Easier start? Try Easy bots. Fire in bursts: the first shots land.');
    expect(debrief(m({ deaths: { gun: 3 } }), f, null, 'sticks').tryNext).toBe('Easier start? Easy bots, or turn aim assist up.');
    expect(debrief(m({ deaths: { gun: 2 } }), f, null).easier).toBe(false);
    expect(debrief(m({ kills: 2, deaths: { gun: 5 } }), f, null).easier).toBe(false);
  });

  it('against Easy bots already: one more go, and the aiming tip (a mouse is never told about aim assist)', () => {
    expect(debrief(m({ bots: 'easy', deaths: { gun: 4 } }), newFacts(NOW), null).tryNext).toBe('One more go? Fire in bursts: the first shots land.');
    expect(debrief(m({ bots: 'easy', deaths: { gun: 4 } }), newFacts(NOW), null, 'sticks').tryNext).toBe('One more go? Turn aim assist up.');
  });
});
