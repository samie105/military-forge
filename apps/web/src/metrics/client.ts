/**
 * The play-stats sender (docs/16-player-metrics.md §3.1): events wait in memory and go to the API in
 * batches of at most MAX_BATCH_EVENTS, every FLUSH_MS or once FLUSH_AT are waiting, with `fetch`
 * (keepalive, the access token when there is one); when the page hides or closes, what's left goes
 * with `navigator.sendBeacon` (no token: the API knows the session id from an earlier batch).
 *
 * - The session id is random per page load and lives in memory only: no cookie, nothing stored.
 * - Without a yes, only the anonymous kinds go (errors, ad delivery), with no session id at all.
 * - Before the player has answered, the other kinds wait (at most PENDING_MAX) and go if they say yes;
 *   a no drops them.
 * - Heavy things are counted on the device and sent as one event: an ad's viewable time is one
 *   `ad.view` per creative per match, active time one `session.active` per 5 minutes.
 */
import { ANALYTICS_VERSION, ANONYMOUS_KINDS, MAX_BATCH_EVENTS, type ClientBatch, type ClientEvent } from '@military-forge/shared';
import { analyticsOn, anonymousOn, type Consent } from './consent';

export const FLUSH_MS = 30_000;
export const FLUSH_AT = 25;
export const PENDING_MAX = 100;
export const QUEUE_MAX = 400;
export const BATCH_URL = '/api/analytics/batch';

/** Distributes over ClientEvent's union: each kind without its own `t`. */
export type Untimed<E = ClientEvent> = E extends ClientEvent ? Omit<E, 't'> : never;

export interface Transport {
  /** a normal batch: fetch with keepalive (and the token, when signed in) */
  post(url: string, body: string, token: string | null): Promise<void>;
  /** the page is going: sendBeacon */
  beacon(url: string, body: string): boolean;
}

export const browserTransport: Transport = {
  async post(url, body, token) {
    await fetch(url, { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  },
  beacon(url, body) {
    try {
      return typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      return false;
    }
  },
};

/** 24 random URL-safe characters. */
export function newSessionId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_');
}

export interface MetricsClientOptions {
  consent: Consent;
  /** the access token if one is live (Api.currentToken) */
  token?: () => string | null;
  /**
   * With a yes, hold the normal sends until there is a token (a page load restores the session a
   * moment after it starts; a first visit has none until the name is picked), so the events are the
   * player's and Delete my data finds them. The page closing sends them anyway.
   */
  waitForToken?: boolean;
  transport?: Transport;
  build?: string;
  tz?: string;
  now?: () => number;
}

export class MetricsClient {
  readonly sid = newSessionId();
  private queue: ClientEvent[] = [];
  private pending: ClientEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(private readonly o: MetricsClientOptions) {
    this.transport = o.transport ?? browserTransport;
    this.now = o.now ?? Date.now;
    this.unsubscribe = o.consent.subscribe((s, prev) => {
      const on = analyticsOn(s);
      if (on && !analyticsOn(prev)) {
        // a yes: what waited goes
        this.queue.push(...this.pending);
        this.pending = [];
        void this.flush();
      } else if (!on && (s.choice !== null || s.browserNo)) {
        // a no (or a browser saying no): nothing personal waits or goes
        this.pending = [];
        this.queue = this.queue.filter((e) => ANONYMOUS_KINDS.has(e.k) && anonymousOn(s));
      }
    });
  }

  /** Records an event now (`t` is set here). */
  track(e: Untimed): void {
    const event = { ...e, t: this.now() } as ClientEvent;
    const s = this.o.consent.get();
    if (ANONYMOUS_KINDS.has(event.k)) {
      if (anonymousOn(s)) this.push(event);
      return;
    }
    if (analyticsOn(s)) this.push(event);
    else if (!s.choice && !s.browserNo && this.pending.length < PENDING_MAX) this.pending.push(event); // not answered yet
  }

  private push(e: ClientEvent): void {
    if (this.queue.length >= QUEUE_MAX) this.queue.shift();
    this.queue.push(e);
    if (this.queue.length >= FLUSH_AT) void this.flush();
  }

  /** Waiting events, for tests and ?tourlog. */
  waiting(): { queue: readonly ClientEvent[]; pending: readonly ClientEvent[] } {
    return { queue: this.queue, pending: this.pending };
  }

  private body(events: ClientEvent[]): string {
    const yes = analyticsOn(this.o.consent.get());
    const batch: ClientBatch = { v: ANALYTICS_VERSION, consent: yes ? 'analytics' : 'none', sid: yes ? this.sid : null, build: this.o.build ?? 'dev', events, ...(this.o.tz ? { tz: this.o.tz } : {}) };
    return JSON.stringify(batch);
  }

  /** Sends what's waiting. `final`: the page is hiding or closing (sendBeacon). */
  async flush(final = false): Promise<void> {
    if (!this.queue.length || (this.sending && !final)) return;
    if (!final && this.o.waitForToken && analyticsOn(this.o.consent.get()) && !this.o.token?.() && this.queue.length < QUEUE_MAX / 2) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const events = this.queue.splice(0, MAX_BATCH_EVENTS);
        const body = this.body(events);
        if (final) {
          if (!this.transport.beacon(BATCH_URL, body)) await this.transport.post(BATCH_URL, body, null).catch(() => {});
        } else {
          try {
            await this.transport.post(BATCH_URL, body, analyticsOn(this.o.consent.get()) ? (this.o.token?.() ?? null) : null);
          } catch {
            // offline: back in line for the next try (the oldest go first if it grows too long)
            this.queue.unshift(...events);
            this.queue.splice(0, Math.max(0, this.queue.length - QUEUE_MAX));
            break;
          }
        }
      }
    } finally {
      this.sending = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe();
  }

  /** Delete my data: nothing that waits goes. */
  clear(): void {
    this.queue = [];
    this.pending = [];
  }
}
