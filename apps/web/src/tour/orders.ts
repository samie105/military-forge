/**
 * "Next orders" (docs/design/onboarding-research.md §5): the one most useful next thing on Home, plus at
 * most two more, each saying why. `recommend` is pure and deterministic: the device's facts (tour/facts.ts)
 * and a little about this device now in, ranked cards out. No server. The Field manual (§5) is the
 * six-item checklist beside it. The words are here, in one table, like tour/copy.ts.
 */
import { MOVES, type Facts } from './facts';
import { FIRST_FLIGHT } from './flight';
import type { Move } from './log';

/** What a card does when taken (the shell runs it). */
export type CardAction =
  | { kind: 'flight' }
  | { kind: 'train'; bots: 'easy' | 'normal' | 'hard' }
  | { kind: 'create' }
  | { kind: 'join' }
  | { kind: 'local' }
  | { kind: 'creator' }
  | { kind: 'settings'; tab: 'controller' | 'audio' | 'touch' };

export interface Card {
  id: string;
  title: string;
  /** one line: what it is */
  line: string;
  /** why it's offered, from the facts */
  reason: string;
  /** the button's words */
  cta: string;
  action: CardAction;
  score: number;
}

/** What `recommend` knows about this device now (not facts: they can change between sessions). */
export interface OrdersContext {
  /** no API: room cards are hidden */
  offline: boolean;
  /** a touch screen with the touch controls (phone cards) */
  touch: boolean;
  /** a controller has been used here */
  pad: boolean;
  /** the touch drill ("Learn every control") was finished */
  drillDone: boolean;
}

type Def = Omit<Card, 'score' | 'reason'> & {
  base: number;
  /** eligible: the reason (and 1–1.5 for how strongly), or null */
  when: (f: Facts, c: OrdersContext) => { reason: string; relevance?: number } | null;
};

const DAY_MS = 86_400_000;
export const COOL_DOWN_MS = 7 * DAY_MS;
export const MAX_CARDS = 3;

const played = (f: Facts) => f.matches.local + f.matches.online;
const MOVE_WORDS: Partial<Record<Move, [title: string, line: string]>> = {
  dash: ['Try dashing', 'A dash dodges fire. It costs fuel.'],
  grenade: ['Try a grenade', 'Tap to throw, hold to aim the arc.'],
  take: ['Take a gun', 'Walk over a gun and take it.'],
};

/** The catalogue (§5), most important first. */
export const CARDS: readonly Def[] = [
  {
    id: 'finish-flight',
    title: 'Finish First flight',
    line: 'Five orders in the range, about 90 s.',
    cta: 'Resume',
    action: { kind: 'flight' },
    base: 100,
    when: (f) => {
      const t = f.tours[FIRST_FLIGHT];
      return t && !t.finished && !t.skipped && t.done.length > 0 ? { reason: `${t.done.length} of 5 done` } : null;
    },
  },
  {
    id: 'live-fire-easy',
    title: 'Live fire',
    line: 'A first match against 3 Easy bots.',
    cta: 'Live fire',
    action: { kind: 'train', bots: 'easy' },
    base: 95,
    when: (f) => (f.experience === 'recruit' && f.tours[FIRST_FLIGHT]?.finished && played(f) < 1 ? { reason: 'First flight done' } : null),
  },
  {
    id: 'live-fire-normal',
    title: 'Live fire',
    line: 'A match against 3 Normal bots.',
    cta: 'Fight',
    action: { kind: 'train', bots: 'normal' },
    base: 90,
    when: (f) => ((f.experience === 'veteran' || f.promoted) && played(f) < 3 ? { reason: f.promoted ? 'You flew the range fast' : 'You know shooters' } : null),
  },
  {
    id: 'flight-replay',
    title: 'First flight',
    line: 'Five orders in the range, about 90 s.',
    cta: 'Fly it',
    action: { kind: 'flight' },
    base: 30,
    // a veteran (or a skip) who never flew: offered low, never pushed
    when: (f) => (!f.tours[FIRST_FLIGHT]?.finished && !f.tours[FIRST_FLIGHT]?.done.length ? { reason: 'Never flown it' } : null),
  },
  {
    id: 'create-room',
    title: 'Play with friends',
    line: 'Make a room and share the code.',
    cta: 'Create room',
    action: { kind: 'create' },
    base: 70,
    when: (f, c) => (!c.offline && played(f) >= 1 && f.rooms.created + f.rooms.joined === 0 ? { reason: `${played(f)} ${played(f) === 1 ? 'match' : 'matches'} solo so far` } : null),
  },
  {
    id: 'join-code',
    title: 'Join with a code',
    line: 'A friend has a room. Their code gets you in.',
    cta: 'Join',
    action: { kind: 'join' },
    base: 40,
    when: (f, c) => (!c.offline && f.invited && f.rooms.joined === 0 ? { reason: 'You came by an invite' } : null),
  },
  {
    id: 'customise',
    title: 'Your soldier',
    line: 'Body, kit and colours. Change it any time.',
    cta: 'Customise',
    action: { kind: 'creator' },
    base: 60,
    when: (f) => (!f.soldierSaved ? { reason: 'Still the standard issue' } : null),
  },
  ...(['dash', 'grenade', 'take'] as const).map(
    (m): Def => ({
      id: `try-${m}`,
      title: MOVE_WORDS[m]![0],
      line: MOVE_WORDS[m]![1],
      cta: 'Practise',
      action: { kind: 'train', bots: 'normal' },
      base: 55,
      when: (f) => (played(f) >= 2 && f.moves[m] === 0 ? { reason: `Not once in ${played(f)} matches` } : null),
    }),
  ),
  {
    id: 'claw',
    title: 'Bigger buttons?',
    line: 'Try the Claw layout, or move the buttons.',
    cta: 'Touch settings',
    action: { kind: 'settings', tab: 'touch' },
    base: 65,
    when: (f, c) => {
      if (!c.touch) return null;
      const strength = Math.max(f.touch.missedTaps / 6, f.touch.hops / 60);
      return strength >= 1 ? { reason: f.touch.missedTaps >= 6 ? 'Some taps missed their buttons' : 'Your right thumb hops a lot', relevance: Math.min(1.5, 1 + (strength - 1) / 2) } : null;
    },
  },
  {
    id: 'pad-preset',
    title: 'Tune your controller',
    line: 'Standard, Bumper Jet or Southpaw.',
    cta: 'Controller',
    action: { kind: 'settings', tab: 'controller' },
    base: 50,
    when: (f, c) => (c.pad && !f.screens.includes('settings:controller') ? { reason: 'You play with a controller' } : null),
  },
  {
    id: 'learn-controls',
    title: 'Learn every control',
    line: 'The full touch drill, one control at a time.',
    cta: 'Touch settings',
    action: { kind: 'settings', tab: 'touch' },
    base: 35,
    when: (f, c) => (c.touch && played(f) >= 3 && !c.drillDone ? { reason: 'Swaps, shields and more' } : null),
  },
  {
    id: 'headphones',
    title: 'Headphones mode',
    line: 'Hear where the shots come from.',
    cta: 'Sound',
    action: { kind: 'settings', tab: 'audio' },
    base: 20,
    when: (f) => (played(f) >= 3 && !f.screens.includes('settings:audio') ? { reason: 'Sound settings never opened' } : null),
  },
  {
    id: 'harder-bots',
    title: 'Harder bots',
    line: 'Hard bots aim better and use cover.',
    cta: 'Fight',
    action: { kind: 'train', bots: 'hard' },
    base: 60,
    when: (f) => (f.matches.wonInARow >= 2 ? { reason: `${f.matches.wonInARow} wins in a row` } : null),
  },
  {
    id: 'host-local',
    title: 'Host on Wi-Fi',
    line: 'A room on this device. Works without internet.',
    cta: 'Local room',
    action: { kind: 'local' },
    base: 25,
    when: (f, c) => (c.offline || f.rooms.created >= 2 ? { reason: c.offline ? "The game server can't be reached" : 'You host often' } : null),
  },
];

/** Shown 3+ times without being taken: it fades down the list (§5 novelty). */
export function novelty(shown: number): number {
  return shown >= 6 ? 0.3 : shown >= 3 ? 0.6 : 1;
}

/** The cards for Home, best first: the first is the primary (volt), then up to two more. */
export function recommend(f: Facts, c: OrdersContext, now: number): Card[] {
  const out: Card[] = [];
  for (const d of CARDS) {
    const seen = f.cards[d.id];
    if (seen?.actedAt != null) continue; // taken: retired
    if (seen?.dismissedAt != null && now - seen.dismissedAt < COOL_DOWN_MS) continue; // Not now: 7 days
    const hit = d.when(f, c);
    if (!hit) continue;
    const score = d.base * Math.min(1.5, Math.max(1, hit.relevance ?? 1)) * novelty(seen?.shown ?? 0);
    out.push({ id: d.id, title: d.title, line: d.line, cta: d.cta, action: d.action, reason: hit.reason, score });
  }
  // a stable sort: equal scores keep the catalogue's order
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_CARDS);
}

// ---- the Field manual

export interface ManualItem {
  id: string;
  label: string;
  done: boolean;
  optional?: boolean;
}

/** The six items (§5), from the facts. `everyControl`: the touch drill finished, or every move used. */
export function fieldManual(f: Facts, everyControl: boolean): ManualItem[] {
  return [
    { id: 'flight', label: 'First flight', done: !!f.tours[FIRST_FLIGHT]?.finished },
    { id: 'kill', label: 'First kill', done: f.kills > 0 },
    { id: 'match', label: 'First match finished', done: f.matches.finished > 0 },
    { id: 'soldier', label: 'Your soldier saved', done: f.soldierSaved },
    { id: 'friend', label: 'Played with a friend', done: f.rooms.created + f.rooms.joined + f.rooms.local > 0 },
    { id: 'controls', label: 'Every control', done: everyControl || MOVES.every((m) => f.moves[m] > 0), optional: true },
  ];
}
