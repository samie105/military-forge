/**
 * What the device knows about this player, for the tour, the hints and Next orders
 * (docs/design/onboarding-research.md §5): kept on the device as `mf.facts.v1` (later synced to the
 * account). `reduceFacts` is pure: every change is a FactEvent, so tests drive it.
 */
import type { DeathCause, Device, Move } from './log';

export const FACTS_KEY = 'mf.facts.v1';
export const DEATH_CAUSES: readonly DeathCause[] = ['gas', 'fall', 'grenade', 'self', 'melee', 'mine', 'gun'];
export const MOVES: readonly Move[] = ['dash', 'grenade', 'take', 'melee', 'swap', 'shield', 'zoom', 'aimed-throw'];

export interface TourFacts {
  /** goal ids ticked, in order */
  done: string[];
  finished: boolean;
  skipped: boolean;
}

export interface CardFacts {
  shown: number;
  /** epoch ms of the last "Not now" (a 7-day cool-down), null = never */
  dismissedAt: number | null;
  /** epoch ms the player acted on it (it retires), null = never */
  actedAt: number | null;
}

export type BotLevel = 'easy' | 'normal' | 'hard';
export const BOT_STEPS: readonly BotLevel[] = ['easy', 'normal', 'hard'];
/** Before Play now's bots followed results (audit 2 P-01) they were Easy for this many finished matches (B-30) */
export const RECRUIT_MATCHES = 3;
/** this many good (or bad) finishes in a row against Play now's level move it a step */
export const BOT_STEP_AFTER = 2;

/**
 * Play now's bots (audit 2 P-01): a level that follows how the player does against it, shown and
 * changeable under Play now. Up a step after BOT_STEP_AFTER top-two finishes in a row, down after as
 * many last places; never mid-match. `pinned`: the player chose it (the rule leaves it alone).
 */
export interface BotFacts {
  level: BotLevel;
  pinned: boolean;
  /** finishes in a row at this level: in the top two (a win in a 2- or 3-player match), and last */
  good: number;
  bad: number;
  /** the last finished match moved the level (Results says so once), null = it didn't */
  moved: { to: BotLevel; why: 'up' | 'down' } | null;
}

/** The last match played (for Next orders' "One more", the Debrief), null = none yet. */
export interface LastMatchFacts {
  at: number;
  online: boolean;
  finished: boolean;
  kills: number;
  deaths: number;
  /** 1-based place among the players there at the end, 0 = unknown (left early, no results) */
  placement: number;
  of: number;
  /** the bots' level, null = no bots */
  bots: BotLevel | null;
  /** people there at the end, you included (0 = unknown) */
  people: number;
}

export interface Facts {
  v: 1;
  firstSeen: number;
  lastSession: number;
  sessions: number;
  devices: Device[];
  lastDevice: Device | null;
  /** the Briefing's answer (null: not asked yet, or skipped) */
  experience: 'recruit' | 'veteran' | null;
  /** behaviour moved a recruit up (recruit hints off) */
  promoted: boolean;
  /** arrived by an invite link at least once */
  invited: boolean;
  tours: Record<string, TourFacts>;
  matches: { local: number; online: number; finished: number; wonInARow: number };
  kills: number;
  deaths: Record<DeathCause, number>;
  /** matches in which each move was used at least once */
  moves: Record<Move, number>;
  /** screens visited: 'locker', 'creator', 'armory', 'settings:<tab>', 'layout-editor' */
  screens: string[];
  rooms: { created: number; joined: number; local: number };
  /** the creator was saved (not just skipped) */
  soldierSaved: boolean;
  touch: { missedTaps: number; hops: number };
  cards: Record<string, CardFacts>;
  bots: BotFacts;
  last: LastMatchFacts | null;
}

export type FactEvent =
  | { k: 'session'; at: number }
  | { k: 'device'; device: Device }
  | { k: 'answer'; experience: 'recruit' | 'veteran' | null }
  | { k: 'promoted' }
  | { k: 'invited' }
  | { k: 'tour'; tour: string; step?: string; finished?: boolean; skipped?: boolean; reset?: boolean }
  | { k: 'match'; online: boolean; finished: boolean; won?: boolean; kills: number; deaths: Partial<Record<DeathCause, number>>; moves: readonly Move[]; placement?: number; of?: number; people?: number; bots?: BotLevel | null; at?: number }
  /** Home's "Bots: … · Change": a level pins it, 'auto' gives it back to the rule */
  | { k: 'bots'; level: BotLevel | 'auto' }
  | { k: 'screen'; screen: string }
  | { k: 'room'; how: 'created' | 'joined' | 'local' }
  | { k: 'soldier-saved' }
  | { k: 'touch'; missedTaps?: number; hops?: number }
  | { k: 'card'; card: string; what: 'shown' | 'dismissed' | 'acted'; at: number };

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export function newFacts(now: number): Facts {
  return {
    v: 1,
    firstSeen: now,
    lastSession: now,
    sessions: 0,
    devices: [],
    lastDevice: null,
    experience: null,
    promoted: false,
    invited: false,
    tours: {},
    matches: { local: 0, online: 0, finished: 0, wonInARow: 0 },
    kills: 0,
    deaths: zero(DEATH_CAUSES),
    moves: zero(MOVES),
    screens: [],
    rooms: { created: 0, joined: 0, local: 0 },
    soldierSaved: false,
    touch: { missedTaps: 0, hops: 0 },
    cards: {},
    bots: { level: 'easy', pinned: false, good: 0, bad: 0, moved: null },
    last: null,
  };
}

const isLevel = (x: unknown): x is BotLevel => x === 'easy' || x === 'normal' || x === 'hard';

/** Saved facts (any shape) → valid facts: unknown fields dropped, missing ones defaulted. */
export function sanitizeFacts(value: unknown, now: number): Facts {
  const base = newFacts(now);
  if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) return base;
  const v = value as Partial<Facts>;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const counts = <K extends string>(src: unknown, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, num((src as Record<string, unknown> | undefined)?.[k], 0)])) as Record<K, number>;
  return {
    ...base,
    firstSeen: num(v.firstSeen, now),
    lastSession: num(v.lastSession, now),
    sessions: num(v.sessions, 0),
    devices: Array.isArray(v.devices) ? v.devices.filter((d): d is Device => d === 'touch' || d === 'keyboard' || d === 'pad') : [],
    lastDevice: v.lastDevice === 'touch' || v.lastDevice === 'keyboard' || v.lastDevice === 'pad' ? v.lastDevice : null,
    experience: v.experience === 'recruit' || v.experience === 'veteran' ? v.experience : null,
    promoted: v.promoted === true,
    invited: v.invited === true,
    tours: typeof v.tours === 'object' && v.tours ? Object.fromEntries(Object.entries(v.tours).map(([id, t]) => [id, { done: Array.isArray(t?.done) ? t.done.filter((s) => typeof s === 'string') : [], finished: t?.finished === true, skipped: t?.skipped === true }])) : {},
    matches: { local: num(v.matches?.local, 0), online: num(v.matches?.online, 0), finished: num(v.matches?.finished, 0), wonInARow: num(v.matches?.wonInARow, 0) },
    kills: num(v.kills, 0),
    deaths: counts(v.deaths, DEATH_CAUSES),
    moves: counts(v.moves, MOVES),
    screens: Array.isArray(v.screens) ? v.screens.filter((s) => typeof s === 'string') : [],
    rooms: { created: num(v.rooms?.created, 0), joined: num(v.rooms?.joined, 0), local: num(v.rooms?.local, 0) },
    soldierSaved: v.soldierSaved === true,
    touch: { missedTaps: num(v.touch?.missedTaps, 0), hops: num(v.touch?.hops, 0) },
    cards: typeof v.cards === 'object' && v.cards ? Object.fromEntries(Object.entries(v.cards).map(([id, c]) => [id, { shown: num(c?.shown, 0), dismissedAt: typeof c?.dismissedAt === 'number' ? c.dismissedAt : null, actedAt: typeof c?.actedAt === 'number' ? c.actedAt : null }])) : {},
    bots: sanitizeBots(v.bots, num(v.matches?.finished, 0)),
    last: sanitizeLast(v.last),
  };
}

/**
 * Saved before Play now's bots followed results (no `bots`): the level they were already playing, Easy
 * under RECRUIT_MATCHES finished matches and Normal after (B-30), so nobody's bots change overnight.
 */
function sanitizeBots(value: unknown, finished: number): BotFacts {
  const b = (typeof value === 'object' && value !== null ? value : null) as Partial<BotFacts> | null;
  const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0);
  if (!b || !isLevel(b.level)) return { level: finished >= RECRUIT_MATCHES ? 'normal' : 'easy', pinned: false, good: 0, bad: 0, moved: null };
  const moved = b.moved && isLevel(b.moved.to) && (b.moved.why === 'up' || b.moved.why === 'down') ? { to: b.moved.to, why: b.moved.why } : null;
  return { level: b.level, pinned: b.pinned === true, good: count(b.good), bad: count(b.bad), moved };
}

function sanitizeLast(value: unknown): LastMatchFacts | null {
  if (typeof value !== 'object' || value === null) return null;
  const l = value as Partial<LastMatchFacts>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { at: n(l.at), online: l.online === true, finished: l.finished === true, kills: n(l.kills), deaths: n(l.deaths), placement: n(l.placement), of: n(l.of), bots: isLevel(l.bots) ? l.bots : null, people: n(l.people) };
}

/** A good finish against bots: a win, or the top two where there were 4 or more. */
export const goodFinish = (placement: number, of: number): boolean => placement === 1 || (of >= 4 && placement === 2);
/** Last of two or more (a draw at the bottom counts as last). */
export const lastPlace = (placement: number, of: number): boolean => of >= 2 && placement === of;

/**
 * Play now's level after one more match (pure): only a finished match against bots at that level
 * counts; two good finishes in a row step it up, two last places down. A pinned level never moves.
 */
export function stepBots(b: BotFacts, e: Extract<FactEvent, { k: 'match' }>): BotFacts {
  const counted = e.finished && !!e.bots && e.bots === b.level && (e.placement ?? 0) > 0 && (e.of ?? 0) >= 2;
  if (!counted) return b.moved ? { ...b, moved: null } : b;
  const good = goodFinish(e.placement!, e.of!) ? b.good + 1 : 0;
  const bad = lastPlace(e.placement!, e.of!) ? b.bad + 1 : 0;
  if (b.pinned) return { ...b, good: 0, bad: 0, moved: null };
  const at = BOT_STEPS.indexOf(b.level);
  if (good >= BOT_STEP_AFTER && at < BOT_STEPS.length - 1) return { level: BOT_STEPS[at + 1]!, pinned: false, good: 0, bad: 0, moved: { to: BOT_STEPS[at + 1]!, why: 'up' } };
  if (bad >= BOT_STEP_AFTER && at > 0) return { level: BOT_STEPS[at - 1]!, pinned: false, good: 0, bad: 0, moved: { to: BOT_STEPS[at - 1]!, why: 'down' } };
  return { ...b, good, bad, moved: null };
}

/** One change to the facts (pure: a new object, the old one untouched). */
export function reduceFacts(f: Facts, e: FactEvent): Facts {
  switch (e.k) {
    case 'session':
      return { ...f, sessions: f.sessions + 1, lastSession: e.at };
    case 'device':
      return { ...f, lastDevice: e.device, devices: f.devices.includes(e.device) ? f.devices : [...f.devices, e.device] };
    case 'answer':
      return { ...f, experience: e.experience };
    case 'promoted':
      return { ...f, promoted: true };
    case 'invited':
      return { ...f, invited: true };
    case 'tour': {
      const was = f.tours[e.tour] ?? { done: [], finished: false, skipped: false };
      const t: TourFacts = e.reset
        ? { done: [], finished: false, skipped: false }
        : {
            done: e.step && !was.done.includes(e.step) ? [...was.done, e.step] : was.done,
            finished: was.finished || e.finished === true,
            skipped: was.skipped || e.skipped === true,
          };
      return { ...f, tours: { ...f.tours, [e.tour]: t } };
    }
    case 'match': {
      const deaths = { ...f.deaths };
      for (const c of DEATH_CAUSES) deaths[c] += e.deaths[c] ?? 0;
      const moves = { ...f.moves };
      for (const m of new Set(e.moves)) moves[m] += 1;
      return {
        ...f,
        kills: f.kills + e.kills,
        deaths,
        moves,
        matches: {
          local: f.matches.local + (e.online ? 0 : 1),
          online: f.matches.online + (e.online ? 1 : 0),
          finished: f.matches.finished + (e.finished ? 1 : 0),
          wonInARow: e.won ? f.matches.wonInARow + 1 : e.finished ? 0 : f.matches.wonInARow,
        },
        bots: stepBots(f.bots, e),
        last: {
          at: e.at ?? 0,
          online: e.online,
          finished: e.finished,
          kills: e.kills,
          deaths: DEATH_CAUSES.reduce((n, c) => n + (e.deaths[c] ?? 0), 0),
          placement: e.placement ?? 0,
          of: e.of ?? 0,
          bots: e.bots ?? null,
          people: e.people ?? 0,
        },
      };
    }
    case 'bots':
      return { ...f, bots: e.level === 'auto' ? { ...f.bots, pinned: false, good: 0, bad: 0, moved: null } : { level: e.level, pinned: true, good: 0, bad: 0, moved: null } };
    case 'screen':
      return f.screens.includes(e.screen) ? f : { ...f, screens: [...f.screens, e.screen] };
    case 'room':
      return { ...f, rooms: { ...f.rooms, [e.how]: f.rooms[e.how] + 1 } };
    case 'soldier-saved':
      return f.soldierSaved ? f : { ...f, soldierSaved: true };
    case 'touch':
      return { ...f, touch: { missedTaps: f.touch.missedTaps + (e.missedTaps ?? 0), hops: f.touch.hops + (e.hops ?? 0) } };
    case 'card': {
      const was = f.cards[e.card] ?? { shown: 0, dismissedAt: null, actedAt: null };
      const c: CardFacts = e.what === 'shown' ? { ...was, shown: was.shown + 1 } : e.what === 'dismissed' ? { ...was, dismissedAt: e.at } : { ...was, actedAt: e.at };
      return { ...f, cards: { ...f.cards, [e.card]: c } };
    }
  }
}

/** Days between two epoch times, rounded down (for D1/D7 and the 14-day refresher). */
export function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

/** The JSON saved under `key`, or null (none, unreadable, or storage blocked). */
function readJson(storage: Pick<Storage, 'getItem'> | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Matches finished on this device (any kind: training, Live fire, online), 0 when storage is blocked. */
export function finishedMatches(storage: Pick<Storage, 'getItem'> | null): number {
  return sanitizeFacts(readJson(storage, FACTS_KEY), 0).matches.finished;
}

/** Play now's bot level on this device (audit 2 P-01): the facts' own, Easy when storage is blocked. */
export function playNowBotLevel(storage: Pick<Storage, 'getItem'> | null): BotLevel {
  return sanitizeFacts(readJson(storage, FACTS_KEY), 0).bots.level;
}

/** The facts, kept on the device; failing storage keeps them for the session. */
export class FactStore {
  private facts: Facts;
  private readonly listeners = new Set<(f: Facts) => void>();

  constructor(
    private readonly storage: KeyValue | null,
    now: () => number = Date.now,
  ) {
    this.facts = sanitizeFacts(readJson(storage, FACTS_KEY), now());
  }

  get(): Facts {
    return this.facts;
  }

  apply(e: FactEvent): Facts {
    const next = reduceFacts(this.facts, e);
    if (next === this.facts) return next;
    this.facts = next;
    try {
      this.storage?.setItem(FACTS_KEY, JSON.stringify(next));
    } catch {
      /* private mode or full */
    }
    for (const fn of this.listeners) fn(next);
    return next;
  }

  subscribe(fn: (f: Facts) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
