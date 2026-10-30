/**
 * Cloudflare Turnstile, the bot check (apps/api auth/botCheck.ts): its script, loaded on first use,
 * never with the game, and only when the build has VITE_TURNSTILE_SITEKEY (set it together with the
 * API's TURNSTILE_SECRET). Without it nothing loads and nothing asks for a token.
 *
 * The widget the forms show is BotCheck.tsx. `quietToken` is for the game's automatic problem
 * reports (diag/report.ts): a token got without showing anything, or none.
 */

export const SITEKEY = (import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined)?.trim() || null;
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** The bot check is asked for only when the build has a site key. */
export const botCheckOn = SITEKEY !== null;

/** Where a token is used: the widget's `action`, which the API matches (auth/botCheck.ts BotCheckAction). */
export type BotCheckAction = 'save' | 'forgot' | 'login' | 'report';

export interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

export function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile')));
    script.onerror = () => {
      loading = null; // a later form tries again
      script.remove();
      reject(new Error('turnstile did not load'));
    };
    document.head.append(script);
  });
  return loading;
}

/** How long an automatic report waits for its quiet token before it gives up. */
export const QUIET_TOKEN_WAIT_MS = 10_000;

/**
 * A token without showing anything: the widget in an off-screen box, `appearance: 'interaction-only'`,
 * so it passes only when Cloudflare needs no click. null when the bot check is off, the script
 * doesn't load, Cloudflare wants a click, or nothing comes within `waitMs`.
 */
export function quietToken(action: BotCheckAction, waitMs = QUIET_TOKEN_WAIT_MS): Promise<string | null> {
  if (!SITEKEY || typeof document === 'undefined') return Promise.resolve(null);
  const sitekey = SITEKEY;
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:fixed;left:-10000px;top:0;width:300px;height:65px;overflow:hidden;pointer-events:none';
    document.body.append(box);
    let id: string | null = null;
    let done = false;
    const finish = (token: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // after Turnstile's own callback has returned
      setTimeout(() => {
        try {
          if (id) window.turnstile?.remove(id);
        } catch {
          /* gone already */
        }
        box.remove();
      }, 0);
      resolve(token);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    loadTurnstile().then(
      (t) => {
        if (done) return;
        try {
          id = t.render(box, {
            sitekey,
            action,
            appearance: 'interaction-only',
            callback: (token: string) => finish(token),
            'error-callback': () => finish(null),
            'expired-callback': () => finish(null),
            'unsupported-callback': () => finish(null),
            'before-interactive-callback': () => finish(null),
          });
        } catch {
          finish(null);
        }
      },
      () => finish(null),
    );
  });
}
