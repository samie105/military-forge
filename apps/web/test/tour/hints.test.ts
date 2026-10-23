import { describe, expect, it } from 'vitest';
import { newFacts, reduceFacts, type Facts } from '../../src/tour/facts';
import { DAMAGE_QUIET_S, HINTS, HintEngine, SPAWN_QUIET_S, TOUCH_HINTS, loadHintMemory, saveHintMemory } from '../../src/tour/hints';

const played = (n: number, moves: ('dash' | 'grenade')[] = []): Facts => {
  let f = newFacts(0);
  for (let i = 0; i < n; i++) f = reduceFacts(f, { k: 'match', online: false, finished: true, kills: 1, deaths: {}, moves });
  return f;
};

describe('the hints engine (§3.6 rules)', () => {
  it('gas after two gas deaths in one match, not one; never in the first 5 s of a life', () => {
    const e = new HintEngine();
    e.matchStart(newFacts(0));
    e.spawn(0);
    e.death('gas');
    e.spawn(10);
    expect(e.next(30)).toBeNull();
    e.death('gas');
    e.spawn(40);
    expect(e.next(40 + SPAWN_QUIET_S - 0.1)).toBeNull();
    expect(e.next(40 + SPAWN_QUIET_S)?.id).toBe('gas');
  });

  it('one per life; none within 3 s of damage; none in the countdown', () => {
    const e = new HintEngine();
    e.matchStart(played(2));
    e.spawn(0);
    e.damage(9);
    expect(e.next(9 + DAMAGE_QUIET_S - 0.1)).toBeNull();
    expect(e.next(9 + DAMAGE_QUIET_S)?.id).toBe('dash');
    expect(e.next(60)).toBeNull(); // grenade waits for the next life
    e.death('gun');
    e.spawn(70);
    e.setCountdown(true);
    expect(e.next(80)).toBeNull();
    e.setCountdown(false);
    expect(e.next(80)?.id).toBe('grenade');
  });

  it('a move never used across 2 matches is offered; using it withdraws the offer', () => {
    const e = new HintEngine();
    e.matchStart(played(2, ['dash']));
    e.spawn(0);
    expect(e.next(10)?.id).toBe('grenade');
    const g = new HintEngine();
    g.matchStart(played(2));
    g.used('dash');
    g.spawn(0);
    expect(g.next(10)?.id).toBe('grenade');
    expect(new HintEngine().next(10)).toBeNull();
  });

  it('own grenade at once; fuel after the second fall', () => {
    const e = new HintEngine();
    e.matchStart(newFacts(0));
    e.spawn(0);
    e.death('self');
    e.spawn(10);
    expect(e.next(20)?.id).toBe('own-grenade');
    e.fuelOut();
    e.death('gun');
    e.spawn(30);
    expect(e.next(40)).toBeNull();
    e.fuelOut();
    expect(e.next(40)?.id).toBe('fuel');
  });

  it('each hint at most its Max, across sessions; "Don\'t show tips" stops them all', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    for (let s = 0; s < 3; s++) {
      const e = new HintEngine(loadHintMemory(storage));
      e.matchStart(newFacts(0));
      e.spawn(0);
      e.death('self');
      e.spawn(10);
      const h = e.next(20);
      expect(h?.id ?? null).toBe(s < HINTS['own-grenade'].max ? 'own-grenade' : null);
      saveHintMemory(storage, e.memory);
    }
    const off = new HintEngine({ counts: {}, off: true });
    off.matchStart(played(2));
    off.spawn(0);
    expect(off.next(20)).toBeNull();
  });

  it('the copy: titles 1–3 words, bodies ≤ 12, no blame, no exclamation marks', () => {
    for (const h of Object.values(HINTS)) {
      expect(h.title.split(' ').length).toBeLessThanOrEqual(3);
      expect(h.body.split(' ').length).toBeLessThanOrEqual(12);
      expect(`${h.title} ${h.body}`).not.toMatch(/!|you keep|again/i);
    }
  });

  it('the touch gesture hints follow the same rules: one per life, quiet after a spawn, each once, the event ones first', () => {
    const e = new HintEngine();
    e.matchStart(newFacts(0));
    e.offer(['dash-swipe', 'swap-radial']);
    e.spawn(0);
    expect(e.next(1)).toBeNull(); // the spawn's quiet
    expect(e.next(SPAWN_QUIET_S + 0.1)?.id).toBe('dash-swipe');
    expect(e.next(SPAWN_QUIET_S + 30)).toBeNull(); // one per life
    e.death('gun');
    e.spawn(100);
    expect(e.next(100 + SPAWN_QUIET_S + 0.1)?.id).toBe('swap-radial'); // dash-swipe was shown once: done
    // an event-driven hint waits in front of the offered ones
    e.death('self');
    e.spawn(200);
    e.offer(['take']);
    expect(e.next(200 + SPAWN_QUIET_S + 0.1)?.id).toBe('own-grenade');
    e.death('gun');
    e.spawn(300);
    expect(e.next(300 + SPAWN_QUIET_S + 0.1)?.id).toBe('take');
  });

  it('a gesture the player already uses is never taught; none offered, none shown; off is off', () => {
    const e = new HintEngine();
    e.used('grenade-types');
    e.offer(['grenade-types']);
    e.spawn(0);
    expect(e.next(SPAWN_QUIET_S + 1)).toBeNull();
    e.offer([]);
    expect(e.next(SPAWN_QUIET_S + 2)).toBeNull();
    const off = new HintEngine({ counts: {}, off: true });
    off.offer(['take']);
    off.spawn(0);
    expect(off.next(SPAWN_QUIET_S + 1)).toBeNull();
    // every touch hint has its control and shows once
    for (const id of TOUCH_HINTS) expect([HINTS[id].control !== undefined, HINTS[id].max]).toEqual([true, 1]);
  });
});
