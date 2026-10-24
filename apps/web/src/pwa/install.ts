/**
 * When to offer installing the game (the owner, 23 Oct: "always show the user a designed toast so
 * users can install the game on their phone"), pure and unit-tested:
 * - only where it can be installed: a caught `beforeinstallprompt` (Android Chrome, Samsung Internet),
 *   or iPhone/iPad Safari (no prompt exists there: a two-step guide instead);
 * - never once installed (launched from the home screen), never after an accepted install;
 * - Android: the first time after the first finished match. iPhone Safari: on the first Home visit (the
 *   owner's iPhone, 24 Oct: Safari's address and tab bars eat a quarter of a landscape screen, and only
 *   a home-screen launch removes them, so the guide can't wait for a match). After "Not now", again
 *   every 3rd session or after another match; never twice in one session.
 * The toast itself shows on Home and Results only (src/pwa/InstallToast.tsx), never in a match.
 */
export const INSTALL_KEY = 'mf.install.v1';
/** "Not now" comes back after this many sessions (or a finished match). */
export const AGAIN_AFTER_SESSIONS = 3;

export type InstallKind = 'prompt' | 'ios';

export interface InstallMemory {
  /** page loads in the app on this device */
  sessions: number;
  /** the session "Not now" was said in (null: never) */
  dismissedAt: number | null;
  /** matches finished when it was said */
  matchesAtDismiss: number;
  /** installed through our toast (the browser's prompt accepted) */
  accepted: boolean;
}

export const freshMemory = (): InstallMemory => ({ sessions: 0, dismissedAt: null, matchesAtDismiss: 0, accepted: false });

export interface OfferContext {
  kind: InstallKind | null;
  installed: boolean;
  /** finished matches on this device (the onboarding's facts) */
  matchesFinished: number;
  /** the toast already showed in this session */
  shownThisSession: boolean;
}

export function shouldOffer(m: InstallMemory, c: OfferContext): boolean {
  if (!c.kind || c.installed || m.accepted || c.shownThisSession) return false;
  if (m.dismissedAt === null) return c.kind === 'ios' || c.matchesFinished >= 1;
  return m.sessions - m.dismissedAt >= AGAIN_AFTER_SESSIONS || c.matchesFinished > m.matchesAtDismiss;
}

/** iPhone or iPad Safari, where Share → Add to Home Screen installs (other iOS browsers can't do it reliably). */
export function isIosSafari(ua: string, maxTouchPoints = 0, platform = ''): boolean {
  const ios = /iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|FBAN|FBAV|Instagram/.test(ua);
}

/** Launched from the home screen (an installed app), or in an iOS home-screen web app. */
export function launchedInstalled(match: (q: string) => boolean, standalone?: boolean): boolean {
  return match('(display-mode: fullscreen)') || match('(display-mode: standalone)') || match('(display-mode: minimal-ui)') || standalone === true;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

export function loadInstallMemory(storage: KeyValue | null): InstallMemory {
  try {
    const v = JSON.parse(storage?.getItem(INSTALL_KEY) ?? 'null') as Partial<InstallMemory> | null;
    const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    return { sessions: num(v?.sessions, 0), dismissedAt: typeof v?.dismissedAt === 'number' ? v.dismissedAt : null, matchesAtDismiss: num(v?.matchesAtDismiss, 0), accepted: v?.accepted === true };
  } catch {
    return freshMemory();
  }
}

export function saveInstallMemory(storage: KeyValue | null, m: InstallMemory): void {
  try {
    storage?.setItem(INSTALL_KEY, JSON.stringify(m));
  } catch {
    /* private mode: it asks again next time, at worst */
  }
}
