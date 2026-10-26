/**
 * The player's choice about play stats (docs/16-player-metrics.md §6.2), kept on this device as
 * `mf.consent.v1`.
 *
 * - **Essential match stats** are always on: the game server counts what happens in a match (kills,
 *   guns, how long it ran, who left) to run and balance the game. Nothing here changes that.
 * - **"Help improve the game and personalise house ads"** (sessions, the first-run funnel, features
 *   used, and the segments the house ads may weight on) needs a yes. Where the API says the default
 *   is opt-out (a country the owner chose, never Europe), it's on until turned off, and Home says so
 *   once. A browser's Global Privacy Control or Do Not Track counts as a no until the player turns it
 *   on themselves in Settings, and then also stops the anonymous error and ad counts.
 */
import { createStore } from 'zustand/vanilla';

export const CONSENT_KEY = 'mf.consent.v1';

export interface ConsentChoice {
  analytics: boolean;
  /** epoch ms */
  at: number;
  /** where it was made: Home's card, Settings, or the opt-out default acknowledged */
  via: 'prompt' | 'settings' | 'notice';
}

export interface ConsentState {
  /** the player's own choice, null = not made yet */
  choice: ConsentChoice | null;
  /** what the API says for this country ('opt-in' until it answers) */
  mode: 'opt-in' | 'opt-out';
  /** the API answered (until then nothing is asked and nothing but anonymous counts is sent) */
  ready: boolean;
  /** Global Privacy Control or Do Not Track is on */
  browserNo: boolean;
  /** the API lets the house ads weight on segments */
  segments: boolean;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The browser asks sites not to track it (Global Privacy Control, or the older Do Not Track). */
export function browserSaysNo(nav: Partial<Navigator> & { globalPrivacyControl?: boolean } = typeof navigator === 'undefined' ? {} : navigator): boolean {
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1';
}

export function readChoice(storage: Pick<Storage, 'getItem'> | null): ConsentChoice | null {
  try {
    const v = JSON.parse(storage?.getItem(CONSENT_KEY) ?? 'null') as Partial<ConsentChoice> | null;
    if (!v || typeof v.analytics !== 'boolean' || typeof v.at !== 'number') return null;
    return { analytics: v.analytics, at: v.at, via: v.via === 'settings' || v.via === 'notice' ? v.via : 'prompt' };
  } catch {
    return null;
  }
}

/** Whether play stats beyond the essential ones may be sent now. */
export function analyticsOn(s: ConsentState): boolean {
  if (s.choice) return s.choice.analytics;
  return s.ready && !s.browserNo && s.mode === 'opt-out';
}

/** Home should ask (opt-in, no answer yet), or tell (opt-out, not acknowledged yet). */
export function promptDue(s: ConsentState): 'ask' | 'tell' | null {
  if (s.choice || !s.ready || s.browserNo) return null;
  return s.mode === 'opt-in' ? 'ask' : 'tell';
}

/** Anonymous counts (errors, ad delivery) may go: everyone but a browser saying no (unless the player said yes). */
export function anonymousOn(s: ConsentState): boolean {
  return s.choice?.analytics === true || !s.browserNo;
}

export class Consent {
  readonly store;

  constructor(
    private readonly storage: KeyValue | null,
    browserNo = browserSaysNo(),
    private readonly now: () => number = Date.now,
  ) {
    this.store = createStore<ConsentState>(() => ({ choice: readChoice(storage), mode: 'opt-in', ready: false, browserNo, segments: false }));
  }

  get(): ConsentState {
    return this.store.getState();
  }

  /** The API's answer for this country. */
  configure(mode: 'opt-in' | 'opt-out', segments: boolean): void {
    this.store.setState({ mode, segments, ready: true });
  }

  set(analytics: boolean, via: ConsentChoice['via']): void {
    const choice: ConsentChoice = { analytics, at: this.now(), via };
    try {
      this.storage?.setItem(CONSENT_KEY, JSON.stringify(choice));
    } catch {
      /* blocked storage: the choice holds for this visit */
    }
    this.store.setState({ choice });
  }

  /** Delete my data: the choice is forgotten too (it becomes a no until asked again). */
  reset(): void {
    try {
      this.storage?.removeItem(CONSENT_KEY);
    } catch {
      /* fine */
    }
    this.store.setState({ choice: { analytics: false, at: this.now(), via: 'settings' } });
  }

  subscribe(fn: (s: ConsentState, prev: ConsentState) => void): () => void {
    return this.store.subscribe(fn);
  }
}
