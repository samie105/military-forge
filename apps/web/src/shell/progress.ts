/**
 * The player's level, visible (audit 2 P-04, the first slice of audit C-04): the API already gives XP
 * for every online match (packages/shared progression.ts, the one rule) and serves it at
 * GET /players/me/profile; this keeps the last answer for Home's chip, the nameplate, the ID card,
 * Results and the Last match card. One request per Home visit and per match end, never more than one
 * at a time. Levels are a number and a bar: nothing unlocks, nothing is bought.
 *
 * Before the first answer, the session's own `me` (level and XP at sign-in) stands in. Training and
 * local rooms earn nothing: Results says so in words.
 */
import { levelForXp, levelProgress, xpForMatch } from '@military-forge/shared';
import { useSyncExternalStore } from 'react';
import type { Api, PlayerProfile } from './api';

export interface Level {
  level: number;
  xp: number;
  xpIntoLevel: number;
  /** 0 at the top level */
  xpForNextLevel: number;
}

export function levelOf(xp: number): Level {
  return { xp, ...levelProgress(xp) };
}

/** The bar's fill, 0–1 (full at the top level). */
export function levelFill(l: Pick<Level, 'xpIntoLevel' | 'xpForNextLevel'>): number {
  return l.xpForNextLevel > 0 ? Math.max(0, Math.min(1, l.xpIntoLevel / l.xpForNextLevel)) : 1;
}

/**
 * What one online match gave: the server's rule on the player's standing (it records the same), the
 * level before and after, and whether it went up.
 */
export function matchGain(before: number, standing: { kills: number; assists: number; placement: number; left?: boolean }): { gain: number; before: Level; after: Level; levelUp: boolean } {
  const gain = xpForMatch({ kills: standing.kills, assists: standing.assists, placement: standing.placement, left: standing.left === true });
  const after = levelOf(before + gain);
  return { gain, before: levelOf(before), after, levelUp: levelForXp(before + gain) > levelForXp(before) };
}

type Listener = () => void;

export class ProgressCache {
  private profile: PlayerProfile | null = null;
  /** whose profile it is (a different player signed in: it starts over) */
  private owner: string | null = null;
  private loading: Promise<PlayerProfile | null> | null = null;
  private readonly listeners = new Set<Listener>();
  private snapshot: { profile: PlayerProfile | null; level: Level | null } = { profile: null, level: null };

  constructor(private readonly api: Pick<Api, 'me' | 'profileMe'> & Partial<Pick<Api, 'onSignIn'>>) {
    // a player signed in (a new guest, a restored session): their level shows at once
    api.onSignIn?.(() => this.changed());
  }

  /** The last profile the API gave for the signed-in player, or null. */
  get(): PlayerProfile | null {
    return this.owner && this.owner === this.api.me?.id ? this.profile : null;
  }

  /** The level now: the profile's, else the session's own (sign-in), else null (offline, no player). */
  level(): Level | null {
    const p = this.get();
    if (p) return levelOf(p.xp);
    const me = this.api.me;
    return me ? levelOf(me.xp ?? 0) : null;
  }

  /** Asks the API again (one request at a time); null when it can't be reached. */
  load(): Promise<PlayerProfile | null> {
    const me = this.api.me;
    if (!me) return Promise.resolve(null);
    if (this.loading) return this.loading;
    this.loading = this.api
      .profileMe()
      .then(
        (p) => {
          if (this.api.me?.id !== me.id) return null;
          this.owner = me.id;
          this.profile = p;
          this.changed();
          return p;
        },
        () => null,
      )
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A stable value for React (a new object only when something changed). */
  view(): { profile: PlayerProfile | null; level: Level | null } {
    const profile = this.get();
    const level = this.level();
    const s = this.snapshot;
    if (s.profile === profile && s.level?.xp === level?.xp && (s.level === null) === (level === null)) return s;
    this.snapshot = { profile, level };
    return this.snapshot;
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

const caches = new WeakMap<object, ProgressCache>();

/** The one cache per Api (the shell's). */
export function progressOf(api: Pick<Api, 'me' | 'profileMe'> & Partial<Pick<Api, 'onSignIn'>>): ProgressCache {
  let c = caches.get(api);
  if (!c) {
    c = new ProgressCache(api);
    caches.set(api, c);
  }
  return c;
}

const none = { profile: null, level: null };
const noop = () => () => {};

/** The level and profile, live (null without a player). */
export function useProgress(cache: ProgressCache | null): { profile: PlayerProfile | null; level: Level | null } {
  return useSyncExternalStore(cache ? (fn) => cache.subscribe(fn) : noop, () => cache?.view() ?? none, () => cache?.view() ?? none);
}
