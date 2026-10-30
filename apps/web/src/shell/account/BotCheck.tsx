/**
 * The bot check's widget (apps/api auth/botCheck.ts): Cloudflare Turnstile on "Save your account",
 * "Forgot password?", "Sign in" once the server asks for it (after a few wrong passwords) and Send a
 * report (diag/SendReport.tsx). Shown only when the build has VITE_TURNSTILE_SITEKEY (set it together
 * with the API's TURNSTILE_SECRET). Without it nothing loads and the forms send no token. The game's
 * automatic reports get theirs without a widget (turnstile.ts quietToken).
 *
 * Cloudflare's script loads on the first form that needs it, never with the game. Each token is
 * single use: after each try the form bumps `round` and the widget starts over.
 */
import { useEffect, useRef, useState } from 'react';
import { SITEKEY, loadTurnstile, type BotCheckAction } from './turnstile';

export { botCheckOn } from './turnstile';

/** The widget; `onToken` gets each token (null when it expires or fails). */
export function BotCheck({ action, round, onToken }: { action: BotCheckAction; round: number; onToken: (token: string | null) => void }) {
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
