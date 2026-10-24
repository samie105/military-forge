/**
 * The installable app at run time (apps/web/pwa.ts writes the worker): the browser's install prompt,
 * caught early; the session count the install toast's timing reads; the service worker, registered in
 * production builds; and its updates, which take over on Home only (never in a match) and reload there.
 */
import { createStore } from 'zustand/vanilla';
import type { ShellStore } from '../shell/store';
import { counted, isIosSafari, launchedInstalled, loadInstallMemory, saveInstallMemory, type InstallKind, type InstallMemory, type InstallStats } from './install';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** how this browser installs us (null: it can't, or we're installed) */
  kind: InstallKind | null;
  installed: boolean;
  memory: InstallMemory;
  /** the toast showed in this session */
  shown: boolean;
  /** the toast is up now (it stays up when Home is laid out again, e.g. under a tour) */
  toastUp: boolean;
  /** the iPhone guide is open on request (an Install app button), wherever the player is (PwaHost) */
  guide: boolean;
  /** installed a moment ago: the "open it from your home screen" confirmation is up (PwaHost) */
  justInstalled: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;

export const pwaStore = createStore<PwaState>(() => ({ kind: null, installed: false, memory: loadInstallMemory(null), shown: false, toastUp: false, guide: false, justInstalled: false }));

/** The memory with one more of `what`, saved and in the store. */
function count(what: keyof InstallStats, patch: Partial<InstallMemory> = {}): void {
  const m = { ...counted(pwaStore.getState().memory, what), ...patch };
  saveInstallMemory(storage, m);
  pwaStore.setState({ memory: m });
}

/** this session's install was counted already (the prompt's accept, then the browser's appinstalled) */
let acceptCounted = false;

/** Installed: the buttons go, the confirmation shows (once), the memory says so. */
function installedNow(): void {
  if (acceptCounted) return;
  acceptCounted = true;
  count('accepted', { accepted: true });
  pwaStore.setState({ kind: null, guide: false, justInstalled: true });
}

const matches = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;

/** Once, early (main.ts): counts the session, catches the install prompt, registers the worker. */
export function startPwa(store: ShellStore, store0: Pick<Storage, 'getItem' | 'setItem'> | null): void {
  if (typeof window === 'undefined') return;
  storage = store0;
  const memory = loadInstallMemory(storage);
  memory.sessions += 1;
  saveInstallMemory(storage, memory);
  const installed = launchedInstalled(matches, (navigator as Navigator & { standalone?: boolean }).standalone);
  const ios = isIosSafari(navigator.userAgent, navigator.maxTouchPoints, navigator.platform);
  pwaStore.setState({ installed, memory, kind: installed ? null : ios ? 'ios' : null });
  // Android Chrome, Samsung Internet: the browser says it can install us; we ask at our moment instead
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    if (!pwaStore.getState().installed) pwaStore.setState({ kind: 'prompt' });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow();
  });
  if (import.meta.env.PROD && 'serviceWorker' in navigator) registerWorker(store);
}

/** The toast was put on screen (once per session). */
export function markShown(): void {
  if (pwaStore.getState().toastUp) return;
  pwaStore.setState({ shown: true, toastUp: true });
  count('offered');
}

/** The toast was answered (Not now, Got it, Install). */
export function toastDone(): void {
  pwaStore.setState({ toastUp: false });
}

/** An Install app button: the browser's prompt where there is one, the two-step guide on an iPhone. */
export function askInstall(matchesFinished: number): void {
  const kind = pwaStore.getState().kind;
  if (kind === 'prompt') void install(matchesFinished);
  else if (kind === 'ios' && !pwaStore.getState().guide) {
    pwaStore.setState({ guide: true });
    count('offered');
  }
}

/** The guide opened from a button is closed (Got it): as Not now. */
export function closeGuide(matchesFinished: number): void {
  pwaStore.setState({ guide: false });
  notNow(matchesFinished);
}

/** The installed confirmation is done (its button, or its time). */
export function closeInstalled(): void {
  pwaStore.setState({ justInstalled: false });
}

/** "Not now" (or the iPhone guide's "Got it"): it comes back after 3 sessions or another match. */
export function notNow(matchesFinished: number): void {
  count('dismissed', { dismissedAt: pwaStore.getState().memory.sessions, matchesAtDismiss: matchesFinished });
}

/** Install: the browser's own prompt. Accepted: never offered again; dismissed there: as Not now. */
export async function install(matchesFinished: number): Promise<void> {
  const e = deferred;
  if (!e) return;
  deferred = null;
  count('prompted');
  try {
    await e.prompt();
    const choice = await e.userChoice;
    if (choice.outcome === 'accepted') installedNow();
    else {
      notNow(matchesFinished);
      // the prompt can't be shown twice: until the browser offers it again, there's nothing to ask with
      pwaStore.setState({ kind: null });
    }
  } catch {
    notNow(matchesFinished);
  }
}

/** The worker: a new version installs and waits; on a calm Home it takes over and the page reloads there. */
function registerWorker(store: ShellStore): void {
  let registration: ServiceWorkerRegistration | null = null;
  let asked = false;
  const calm = () => {
    const s = store.getState();
    return s.screen.name === 'home' && s.overlay === null && s.route === null;
  };
  const maybeActivate = () => {
    const waiting = registration?.waiting;
    if (!waiting || asked || !calm()) return;
    asked = true;
    waiting.postMessage('activate');
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // only the take-over we asked for reloads (the very first install's claim doesn't)
    if (asked && calm()) location.reload();
  });
  const register = () =>
    void navigator.serviceWorker
      .register('/sw.js')
      .then((r) => {
        registration = r;
        r.addEventListener('updatefound', () => r.installing?.addEventListener('statechange', maybeActivate));
        maybeActivate();
      })
      .catch(() => {
        /* no worker (private mode, an old browser): the game works the same */
      });
  // after the page's own loading (the worker's first fetch shouldn't compete with the game's)
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
  // back on Home: look for a new version, and let a waiting one take over
  let wasHome = calm();
  store.subscribe(() => {
    const home = calm();
    if (home && !wasHome) {
      void registration?.update().catch(() => {});
      maybeActivate();
    }
    wasHome = home;
  });
}
