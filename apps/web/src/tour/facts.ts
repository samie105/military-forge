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
}

export type FactEvent =
  | { k: 'session'; at: number }
  | { k: 'device'; device: Device }
  | { k: 'answer'; experience: 'recruit' | 'veteran' | null }
  | { k: 'promoted' }
  | { k: 'invited' }
  | { k: 'tour'; tour: string; step?: string; finished?: boolean; skipped?: boolean; reset?: boolean }
  | { k: 'match'; online: boolean; finished: boolean; won?: boolean; kills: number; deaths: Partial<Record<DeathCause, number>>; moves: readonly Move[] }
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
  };
}

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
  };
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
      };
    }
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
