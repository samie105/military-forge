import { DamageSource, MatchPhase, type SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { createShellStore } from '../../src/shell/store';
import { startTourMemory } from '../../src/tour';
import { FACTS_KEY, FactStore, daysBetween, newFacts, reduceFacts, sanitizeFacts } from '../../src/tour/facts';
import { EventLog, LOG_KEY, UPLOAD_ENABLED, funnel, type TourLogEvent } from '../../src/tour/log';
import { MatchTracker, deathCause } from '../../src/tour/track';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
};
const broken = { getItem: () => { throw new Error('private'); }, setItem: () => { throw new Error('private'); }, removeItem: () => { throw new Error('private'); } };

describe('the event log (mf.log.v1)', () => {
  it('keeps every §6.1 event with its fields and time, across a reload', () => {
    const s = memoryStorage();
    let t = 1000;
    const log = new EventLog(s, () => t);
    const events: TourLogEvent[] = [
      { t: 'tour.step', tour: 'first-flight', step: 'run', persona: 'recruit', device: 'keyboard', status: 'done', ms: 4200 },
      { t: 'tour.end', tour: 'first-flight', result: 'finished', ms: 74_000 },
      { t: 'briefing.answer', answer: 'recruit', device: 'touch', changed: false },
      { t: 'promotion', reason: 'first-flight-under-40s' },
      { t: 'help.offered', reason: 'deaths' },
      { t: 'help.accepted', reason: 'deaths' },
      { t: 'hint.shown', hint: 'gas' },
      { t: 'hint.acted', hint: 'gas', secs: 12 },
      { t: 'card.shown', card: 'live-fire-easy', rank: 0, score: 95 },
      { t: 'card.tapped', card: 'live-fire-easy', rank: 0, score: 95 },
      { t: 'card.dismissed', card: 'try-dash', rank: 1, score: 55 },
      { t: 'first.kill', sinceTitle: 140.2, sinceMatch: 21.5 },
      { t: 'match.end', online: false, bots: 'easy', kills: 5, deaths: { gas: 1 }, moves: ['dash'] },
      { t: 'session.start', days: 1 },
    ];
    for (const e of events) {
      t += 10;
      log.record(e);
    }
    const again = new EventLog(s);
    expect(again.entries()).toHaveLength(events.length);
    expect(again.entries()[0]).toEqual({ ...events[0], at: 1010 });
    expect(JSON.parse(s.map.get(LOG_KEY)!)).toHaveLength(events.length);
    expect(UPLOAD_ENABLED).toBe(false); // nothing leaves the device until the owner opts in
  });

  it('stays under 50 KB, dropping the oldest', () => {
    const s = memoryStorage();
    const log = new EventLog(s, () => 0);
    for (let i = 0; i < 2000; i++) log.record({ t: 'hint.shown', hint: `hint-number-${i}-padding-padding` });
    expect(s.map.get(LOG_KEY)!.length).toBeLessThanOrEqual(50_000);
    expect(log.bytes()).toBeLessThanOrEqual(50_000);
    const last = log.entries().at(-1)!;
    expect(last.t === 'hint.shown' && last.hint).toBe('hint-number-1999-padding-padding');
  });

  it('survives private mode: writes fail silently, the session keeps the log', () => {
    const log = new EventLog(broken);
    log.record({ t: 'session.start', days: 0 });
    expect(log.entries()).toHaveLength(1);
    log.clear();
    expect(log.entries()).toHaveLength(0);
  });

  it('reads a per-step funnel with the median time', () => {
    const log = new EventLog(null, () => 0);
    const step = (s: string, status: 'shown' | 'done' | 'skipped', ms = 0) => log.record({ t: 'tour.step', tour: 'first-flight', step: s, persona: 'recruit', device: 'touch', status, ms });
    step('run', 'shown');
    step('run', 'done', 5000);
    step('run', 'shown');
    step('run', 'done', 9000);
    step('fly', 'shown');
    step('fly', 'skipped');
    expect(funnel(log.entries(), 'first-flight')).toEqual([
      { step: 'run', shown: 2, done: 2, skipped: 0, timeout: 0, abandoned: 0, medianMs: 5000 },
      { step: 'fly', shown: 1, done: 0, skipped: 1, timeout: 0, abandoned: 0, medianMs: null },
    ]);
  });
});

describe('the facts (mf.facts.v1)', () => {
  it('reduces every kind of fact, purely', () => {
    let f = newFacts(0);
    const before = f;
    f = reduceFacts(f, { k: 'session', at: 50 });
    f = reduceFacts(f, { k: 'device', device: 'touch' });
    f = reduceFacts(f, { k: 'device', device: 'pad' });
    f = reduceFacts(f, { k: 'answer', experience: 'recruit' });
    f = reduceFacts(f, { k: 'tour', tour: 'first-flight', step: 'run' });
    f = reduceFacts(f, { k: 'tour', tour: 'first-flight', step: 'run' });
    f = reduceFacts(f, { k: 'tour', tour: 'first-flight', step: 'fly', finished: true });
    f = reduceFacts(f, { k: 'match', online: false, finished: true, won: true, kills: 3, deaths: { gas: 2, gun: 1 }, moves: ['dash', 'dash', 'grenade'] });
    f = reduceFacts(f, { k: 'match', online: true, finished: false, kills: 1, deaths: {}, moves: [] });
    f = reduceFacts(f, { k: 'screen', screen: 'locker' });
    f = reduceFacts(f, { k: 'screen', screen: 'locker' });
    f = reduceFacts(f, { k: 'room', how: 'created' });
    f = reduceFacts(f, { k: 'soldier-saved' });
    f = reduceFacts(f, { k: 'touch', missedTaps: 4, hops: 2 });
    f = reduceFacts(f, { k: 'card', card: 'try-dash', what: 'shown', at: 60 });
    f = reduceFacts(f, { k: 'card', card: 'try-dash', what: 'dismissed', at: 70 });
    f = reduceFacts(f, { k: 'promoted' });
    f = reduceFacts(f, { k: 'invited' });
    expect(before).toEqual(newFacts(0));
    expect(f).toMatchObject({
      sessions: 1,
      lastSession: 50,
      devices: ['touch', 'pad'],
      lastDevice: 'pad',
      experience: 'recruit',
      promoted: true,
      invited: true,
      tours: { 'first-flight': { done: ['run', 'fly'], finished: true, skipped: false } },
      matches: { local: 1, online: 1, finished: 1, wonInARow: 1 },
      kills: 4,
      screens: ['locker'],
      rooms: { created: 1, joined: 0, local: 0 },
      soldierSaved: true,
      touch: { missedTaps: 4, hops: 2 },
      cards: { 'try-dash': { shown: 1, dismissedAt: 70, actedAt: null } },
    });
    expect(f.deaths).toMatchObject({ gas: 2, gun: 1, fall: 0 });
    expect(f.moves).toMatchObject({ dash: 1, grenade: 1, take: 0 });
    expect(reduceFacts(f, { k: 'tour', tour: 'first-flight', reset: true }).tours['first-flight']).toEqual({ done: [], finished: false, skipped: false });
  });

  it('sanitises whatever was saved, and survives private mode', () => {
    expect(sanitizeFacts({ v: 2 }, 5)).toEqual(newFacts(5));
    const odd = sanitizeFacts({ v: 1, kills: 'many', devices: ['touch', 'toaster'], deaths: { gas: 3, lava: 9 } }, 5);
    expect(odd.kills).toBe(0);
    expect(odd.devices).toEqual(['touch']);
    expect(odd.deaths.gas).toBe(3);
    expect('lava' in odd.deaths).toBe(false);
    const s = memoryStorage();
    new FactStore(s, () => 1).apply({ k: 'answer', experience: 'veteran' });
    expect(new FactStore(s).get().experience).toBe('veteran');
    expect(JSON.parse(s.map.get(FACTS_KEY)!).v).toBe(1);
    expect(new FactStore(broken).apply({ k: 'promoted' }).promoted).toBe(true);
    expect(daysBetween(0, 86_400_000 * 7.5)).toBe(7);
  });
});

describe('one match, counted', () => {
  it('names a death by its source or the player\'s own doing', () => {
    expect(deathCause({ victim: 1, killer: 2, source: DamageSource.Gas })).toBe('gas');
    expect(deathCause({ victim: 1, killer: 1, source: DamageSource.World })).toBe('fall');
    expect(deathCause({ victim: 1, killer: 1, source: DamageSource.Grenade })).toBe('self');
    expect(deathCause({ victim: 1, killer: 2, source: DamageSource.Grenade })).toBe('grenade');
    expect(deathCause({ victim: 1, killer: 2, source: DamageSource.Mine })).toBe('mine');
    expect(deathCause({ victim: 1, killer: 2, source: DamageSource.Melee })).toBe('melee');
    expect(deathCause({ victim: 1, killer: 2, source: 3 })).toBe('gun');
  });

  it("counts the local player's kills, deaths and moves, and the first kill once", () => {
    let t = 0;
    const m = new MatchTracker(() => t);
    const firsts: number[] = [];
    m.onFirstKill = (s) => firsts.push(s);
    m.onEvents([{ type: 'dash', player: 0, x: 0, y: 0, dir: 0 }], 0); // before begin: ignored
    m.begin(false, 'easy');
    t = 12_000;
    const ev: SimEvent[] = [
      { type: 'dash', player: 0, x: 0, y: 0, dir: 0 },
      { type: 'dash', player: 3, x: 0, y: 0, dir: 0 },
      { type: 'throw', owner: 0, grenade: 0 },
      { type: 'death', victim: 2, killer: 0, source: 3 },
      { type: 'death', victim: 3, killer: 0, source: DamageSource.Grenade },
      { type: 'death', victim: 0, killer: 2, source: DamageSource.Gas },
      { type: 'hit', attacker: 0, target: 2, damage: 30, zone: 0, source: DamageSource.Melee },
    ];
    m.onEvents(ev, 0);
    m.used('swap');
    expect(firsts).toEqual([12]);
    expect(m.end()).toEqual({ online: false, bots: 'easy', kills: 2, deaths: { gas: 1 }, moves: ['dash', 'grenade', 'melee', 'swap'], firstKillAt: 12 });
    expect(m.end()).toBeNull();
  });
});

describe('the memory, fed by the shell', () => {
  it('records a session, a match from GO to the end, rooms and screens', () => {
    const s = memoryStorage();
    const store = createShellStore({ screen: { name: 'training' } });
    let clock = 0;
    const mem = startTourMemory({ store, storage: s, now: () => 1_000, clock: () => clock });
    expect(mem.log.entries()[0]).toMatchObject({ t: 'session.start', days: 0 });
    const match = (phase: MatchPhase) => ({ phase, localId: 0, results: null }) as never;
    store.setState({ match: match(MatchPhase.Countdown) });
    store.setState({ match: match(MatchPhase.InProgress) });
    clock = 30_000;
    mem.onEvents([{ type: 'death', victim: 1, killer: 0, source: 3 }], 0);
    store.setState({ match: match(MatchPhase.Ending) });
    const kinds = mem.log.entries().map((e) => e.t);
    expect(kinds).toEqual(['session.start', 'first.kill', 'match.end']);
    expect(mem.facts.get()).toMatchObject({ kills: 1, matches: { local: 1, finished: 1 } });
    // the next first kill isn't "first" any more
    store.setState({ match: match(MatchPhase.InProgress) });
    mem.onEvents([{ type: 'death', victim: 1, killer: 0, source: 3 }], 0);
    store.setState({ match: null, screen: { name: 'home' } });
    expect(mem.log.entries().filter((e) => e.t === 'first.kill')).toHaveLength(1);
    expect(mem.facts.get().matches).toMatchObject({ local: 2, finished: 1 });
    // a room made through the API's finding step; a route; a Settings tab
    store.setState({ screen: { name: 'finding', code: null, creating: true } });
    store.setState({ screen: { name: 'room', code: 'KMTXRB' } });
    store.setState({ route: { id: 'locker', title: 'Locker', mount: () => {} } });
    store.setState({ overlay: 'settings', settingsTab: 'audio' });
    expect(mem.facts.get()).toMatchObject({ rooms: { created: 1 }, screens: ['locker', 'settings:audio'] });
    mem.setDevice('pad');
    expect(mem.facts.get().lastDevice).toBe('pad');
    mem.dispose();
  });
});
