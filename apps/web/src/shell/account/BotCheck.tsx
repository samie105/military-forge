/**
 * The bot check on "Save your account" and "Forgot password?" (apps/api auth/botCheck.ts):
 * Cloudflare Turnstile's widget, shown only when the build has VITE_TURNSTILE_SITEKEY (set it
 * together with the API's TURNSTILE_SECRET). Without it nothing loads and the forms send no token.
 *
 * Cloudflare's script loads on the first form that needs it, never with the game. Each token is
 * single use: after a refused answer the form bumps `round` and the widget starts over.
 */
import { useEffect, useRef, useState } from 'react';

const SITEKEY = (import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined)?.trim() || null;
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** The forms ask for a token only when the build has a site key. */
export const botCheckOn = SITEKEY !== null;

interface Turnstile {
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

function loadTurnstile(): Promise<Turnstile> {
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

/** The widget; `onToken` gets each token (null when it expires or fails). */
export function BotCheck({ action, round, onToken }: { action: 'save' | 'forgot'; round: number; onToken: (token: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const report = useRef(onToken);
  report.current = onToken;

  useEffect(() => {
    if (!SITEKEY) return;
    let gone = false;
    loadTurnstile().then(
      (t) => {
        if (gone || !box.current) return;
        widget.current = t.render(box.current, {
          sitekey: SITEKEY,
          action,
          theme: 'dark',
          size: 'flexible',
          callback: (token: string) => report.current(token),
          'expired-callback': () => report.current(null),
          'error-callback': () => report.current(null),
        });
      },
      () => !gone && setFailed(true),
    );
    return () => {
      gone = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [action]);

  // a refused or used token: a fresh check
  useEffect(() => {
    if (round === 0 || !widget.current) return;
    report.current(null);
    window.turnstile?.reset(widget.current);
  }, [round]);

  if (!SITEKEY) return null;
  return (
    <div className="acct-bot">
      <div ref={box} />
      {failed && <p className="acct-note">Couldn't load the check that you're not a bot. Check the connection, then open this form again.</p>}
    </div>
  );
}
