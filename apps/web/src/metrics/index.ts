/**
 * Play stats on this device (docs/16-player-metrics.md): the consent, the sender, and what it
 * watches. main.ts starts it once (app pages only); the rest of the app reports through
 * `metricsFeature` / `metricsError`, which do nothing until it runs.
 *
 * What it sends, by the vocabulary (@military-forge/shared analytics.ts):
 * - with a yes: the session (device class, input, graphics tier, installed, arrival, time zone
 *   offset), active time, where the session ended, the first-run funnel, features used, local and
 *   training matches, the input changing;
 * - always (anonymous, no ids; not under Global Privacy Control): errors, and ad delivery (views,
 *   saves, visits after the match), which never carry the player's id.
 */
import { FEATURES, type ErrorKind, type Feature, type FormFactor, type InputKind, type PerfTier, type ScreenName } from '@military-forge/shared';
import { MatchPhase } from '@military-forge/sim';
import { savedAds } from '../ads/saved';
import { pwaStore } from '../pwa';
import { drawnBoards, setAdContext, type AdContext } from '../render3d/ads';
import type { Api } from '../shell/api';
import type { ShellState, ShellStore } from '../shell/store';
import { daysBetween } from '../tour/facts';
import type { TourMemory } from '../tour';
import { AdViewCounter, CHECK_MS } from './adViews';
import { MetricsClient, type Untimed } from './client';
import { Consent, analyticsOn } from './consent';
import { setMetricsSink } from './hooks';

export { Consent, analyticsOn, anonymousOn, browserSaysNo, promptDue, type ConsentState } from './consent';
export { MetricsClient } from './client';

/** Foreground time is reported at least this often. */
export const ACTIVE_EVERY_MS = 5 * 60_000;
/** Script errors sent per page load at most. */
export const MAX_SCRIPT_ERRORS = 5;

export interface Metrics {
  readonly client: MetricsClient;
  readonly consent: Consent;
  feature(f: Feature): void;
  error(e: ErrorKind, where: string): void;
  /** Delete my data: the API's copy, then this device's (the event log, the ad counts, the choice) */
  deleteMyData(): Promise<void>;
  /** …and the player itself (DELETE /me); the page reloads after */
  deletePlayer(): Promise<void>;
}

let running: Metrics | null = null;

/** The running play stats, or null (the debug client, tests). */
export function metrics(): Metrics | null {
  return running;
}

export { metricsError, metricsFeature } from './hooks';

export function formFactor(w: number, h: number): FormFactor {
  const short = Math.min(w, h);
  return short < 500 ? 'phone' : short < 900 ? 'tablet' : 'desktop';
}

const placeId = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32) || 'app';

/** The screen a session is on, in the vocabulary's words. */
export function screenOf(s: Pick<ShellState, 'screen' | 'route' | 'overlay' | 'title' | 'match'>, landing: boolean): ScreenName {
  if (s.title === 'on' || s.title === 'pressed') return 'title';
  if (s.route) return 'route';
  if (s.overlay === 'settings') return 'settings';
  switch (s.screen.name) {
    case 'boot':
      return landing ? 'landing' : 'title';
    // the 18+ step is part of enlisting (the vocabulary has no word of its own for it)
    case 'name':
    case 'age':
      return 'name';
    case 'home':
      return 'home';
    case 'finding':
      return 'finding';
    case 'training':
      return 'training';
    case 'error':
      return 'error';
    case 'room': {
      const p = s.match?.phase;
      if (p === MatchPhase.InProgress || p === MatchPhase.Countdown) return 'match';
      if (p === MatchPhase.Ending || p === MatchPhase.Postgame) return 'results';
      return 'lobby';
    }
  }
}

export interface MetricsOptions {
  store: ShellStore;
  api: Api | null;
  memory: TourMemory | null;
  storage: (Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>) | null;
  /** the graphics tier in force (main.ts: Auto's pick or the player's) */
  tier: () => PerfTier;
  input: () => InputKind;
  build: string;
  /** installed app (display-mode standalone) */
  installed: boolean;
}

export function startMetrics(o: MetricsOptions): Metrics {
  const consent = new Consent(o.storage);
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  })();
  const client = new MetricsClient({ consent, token: () => o.api?.currentToken() ?? null, waitForToken: o.api !== null, build: o.build, ...(tz ? { tz } : {}) });
  const track = (e: Untimed) => client.track(e);

  // the country's consent default and the segments flag (the API's answer; opt-in until it comes)
  void fetch(`/api/analytics/config?tz=${encodeURIComponent(tz ?? '')}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<{ consent?: string; segments?: boolean }>) : null))
    .then((c) => consent.configure(c?.consent === 'opt-out' ? 'opt-out' : 'opt-in', c?.segments === true))
    .catch(() => consent.configure('opt-in', false));

  // ---- the session
  const facts = o.memory?.facts.get();
  const n = facts?.sessions ?? 1;
  const path = location.pathname;
  const invited = path.startsWith('/r/');
  const landing = path === '/' || path === '/index.html';
  track({
    k: 'session.start',
    n,
    days: facts ? daysBetween(facts.firstSeen, Date.now()) : 0,
    input: o.input(),
    form: formFactor(screen.width || innerWidth, screen.height || innerHeight),
    tier: o.tier(),
    installed: o.installed,
    arrival: invited ? 'invite' : o.installed ? 'app' : 'direct',
    tzo: -new Date().getTimezoneOffset(),
  });
  // the first-run funnel: each step once, in the first session (the second session is a step of its own)
  const stepped = new Set<string>();
  const step = (s: 'landing' | 'title' | 'name' | 'home' | 'first-match' | 'second-session') => {
    if (stepped.has(s)) return;
    stepped.add(s);
    track({ k: 'funnel', step: s });
  };
  if (n === 2) step('second-session');
  if (n === 1 && landing) step('landing');
  const used = new Set<Feature>();
  const feature = (f: Feature) => {
    if (used.has(f) || !FEATURES.includes(f)) return;
    used.add(f);
    track({ k: 'feature', f });
  };
  if (invited) feature('invite-opened');
  let scriptErrors = 0;
  const error = (e: ErrorKind, where: string) => {
    if (e === 'script' && ++scriptErrors > MAX_SCRIPT_ERRORS) return;
    track({ k: 'error', e, where: placeId(where) });
  };

  // ---- active time: foreground seconds, sent when the page hides and every 5 minutes
  let shownAt = document.visibilityState === 'visible' ? performance.now() : -1;
  const reportActive = () => {
    if (shownAt < 0) return;
    const s = Math.round((performance.now() - shownAt) / 1000);
    shownAt = document.visibilityState === 'visible' ? performance.now() : -1;
    if (s > 0) track({ k: 'session.active', s });
  };
  setInterval(() => {
    if (shownAt >= 0 && performance.now() - shownAt >= ACTIVE_EVERY_MS) reportActive();
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      reportActive();
      flushAds();
      void client.flush(true);
    } else if (shownAt < 0) shownAt = performance.now();
  });
  window.addEventListener('pagehide', () => {
    reportActive();
    flushAds();
    track({ k: 'session.end', last: screenOf(o.store.getState(), landing) });
    void client.flush(true);
  });

  // ---- the shell: the funnel, features, matches seen only here, failed connections
  let localMatch: { mode: 'local' | 'training'; since: number } | null = null;
  const onState = (s: ShellState, prev: ShellState) => {
    if (n === 1) {
      if (s.title === 'on') step('title');
      if (s.screen.name === 'name' || s.overlay === 'name') step('name');
      if (s.screen.name === 'home') step('home');
    }
    if (s.route && s.route !== prev.route) {
      const id = s.route.id;
      if (id === 'locker' || id === 'armory' || id === 'creator') feature(id);
    }
    if (s.overlay === 'settings' && prev.overlay !== 'settings') feature('settings');
    if (s.spectating && !prev.spectating) feature('spectate');
    if (s.screen.name === 'room' && prev.screen.name !== 'room') {
      if (s.screen.local) feature('local-room');
      else if (prev.screen.name === 'finding') feature(prev.screen.creating ? 'room-created' : 'room-joined');
    }
    if (s.connection?.state === 'failed' && prev.connection?.state !== 'failed') error('connect-failed', s.screen.name === 'room' && s.screen.local ? 'local-room' : 'room');
    // a match begins: the first ever on this device is a funnel step; local rooms and training are timed here
    const phase = s.match?.phase;
    if (phase === MatchPhase.InProgress && prev.match?.phase !== MatchPhase.InProgress) {
      const f = o.memory?.facts.get();
      if (f && f.matches.local + f.matches.online === 0) step('first-match');
      const local = s.screen.name === 'training' ? 'training' : s.screen.name === 'room' && s.screen.local ? 'local' : null;
      localMatch = local ? { mode: local, since: performance.now() } : null;
    }
    if (phase !== prev.match?.phase && phase !== MatchPhase.InProgress && prev.match?.phase === MatchPhase.InProgress) flushAds();
  };
  o.store.subscribe(onState);
  onState(o.store.getState(), { ...o.store.getState(), route: null, overlay: null, title: 'off', screen: { name: 'boot' }, match: null, spectating: false, connection: null });

  // the tour's memory: a local or training match ended (its kills and deaths), tours finished or skipped
  let lastFacts = o.memory?.facts.get() ?? null;
  o.memory?.facts.subscribe((f) => {
    const was = lastFacts;
    lastFacts = f;
    if (!was) return;
    if (f.matches.local > was.matches.local && localMatch) {
      const sum = o.memory!.lastMatch;
      const finished = f.matches.finished > was.matches.finished;
      track({
        k: 'match.client',
        mode: localMatch.mode,
        finished,
        won: f.matches.wonInARow > was.matches.wonInARow,
        kills: sum?.kills ?? 0,
        deaths: sum ? Object.values(sum.deaths).reduce((a, b) => a + (b ?? 0), 0) : 0,
        s: Math.round((performance.now() - localMatch.since) / 1000),
        bots: localMatch.mode === 'training' || (sum?.bots ?? null) !== null,
      });
      localMatch = null;
    }
    for (const [id, t] of Object.entries(f.tours)) {
      const before = was.tours[id];
      if (t.finished && !before?.finished) feature('tour-finished');
      if (t.skipped && !before?.skipped) feature('tour-skipped');
      if (before && before.done.length > 0 && t.done.length === 0) feature('tour-replayed');
    }
    if (f.soldierSaved && !was.soldierSaved) feature('outfit-saved');
  });

  // ---- errors: script errors, a code chunk gone (a new version replaced it), the 3D view lost
  window.addEventListener('error', () => error('script', screenOf(o.store.getState(), landing)));
  window.addEventListener('vite:preloadError', () => error('chunk-missing', o.store.getState().route?.id ?? screenOf(o.store.getState(), landing)));
  window.addEventListener('webglcontextlost', () => error('webgl-lost', screenOf(o.store.getState(), landing)), { capture: true });

  // ---- the input changing mid-session (a pad picked up)
  let input = o.input();
  const inputTimer = setInterval(() => {
    const now = o.input();
    if (now !== input) {
      input = now;
      track({ k: 'input', input: now });
    }
  }, 5_000);
  void inputTimer;

  // ---- billboard ads: views (per creative per match), saves and visits (tap-to-save)
  const views = new AdViewCounter();
  setInterval(() => {
    const b = drawnBoards();
    if (!b) return;
    const s = o.store.getState();
    const canView = document.visibilityState === 'visible' && document.hasFocus() && s.match?.phase === MatchPhase.InProgress && !document.querySelector('#shell .screen--menu, #shell .mf-fit--modal');
    views.check(b.inView(), canView);
  }, CHECK_MS);
  function flushAds(): void {
    for (const v of views.drain()) track(v);
  }
  const queue = savedAds();
  let counts = queue.counts();
  let list = queue.list();
  queue.subscribe(() => {
    const next = queue.counts();
    const adv = (c: string) => [...queue.list(), ...list].find((a) => a.creative === c)?.advertiser || 'house';
    for (const [c, k] of Object.entries(next.saves)) for (let i = counts.saves[c] ?? 0; i < k; i++) track({ k: 'ad.save', c, adv: adv(c) });
    for (const [c, k] of Object.entries(next.visits)) for (let i = counts.visits[c] ?? 0; i < k; i++) track({ k: 'ad.visit', c, adv: adv(c) });
    counts = next;
    list = queue.list();
  });

  // the house ads' context (docs/16 §7): only with the API's flag on and the player's yes; asked once
  // the player is signed in, again after a yes, and dropped on a no
  let asked = false;
  const segments = () => {
    const s = consent.get();
    if (!s.segments || !analyticsOn(s)) {
      setAdContext(null);
      asked = false;
      return;
    }
    if (asked || !o.api?.currentToken()) return;
    asked = true;
    void o.api
      .segments()
      .then((seg) => setAdContext(seg ? (seg as unknown as AdContext) : null))
      .catch(() => (asked = false));
  };
  consent.subscribe(segments);
  o.store.subscribe((s, prev) => {
    if (s.screen.name === 'home' && prev.screen.name !== 'home') segments();
  });

  // the install prompt (src/pwa): offered, accepted, put off
  let installs = pwaStore.getState().memory.stats;
  pwaStore.subscribe((p) => {
    const st = p.memory.stats;
    if (st.offered > installs.offered) feature('install-offered');
    if (st.accepted > installs.accepted) feature('install-accepted');
    if (st.dismissed > installs.dismissed) feature('install-dismissed');
    installs = st;
  });

  client.start();

  running = {
    client,
    consent,
    feature,
    error,
    async deleteMyData() {
      client.clear();
      setAdContext(null);
      if (o.api) await o.api.deletePlayStats();
      // this device's records: the onboarding event log, the ad counts, the choice itself (the tour's
      // facts stay: they never leave the device and keep the tour from starting over)
      for (const key of ['mf.log.v1', 'mf.ads.stats.v1']) {
        try {
          o.storage?.removeItem(key);
        } catch {
          /* fine */
        }
      }
      o.memory?.log.clear();
      consent.reset();
    },
    async deletePlayer() {
      client.clear();
      await o.api?.deleteAccount();
    },
  };
  setMetricsSink(running);
  if (import.meta.env.DEV) Object.assign(window, { __metrics: running });
  return running;
}
