/**
 * Send a report (Settings and the pause menu; the owner, 24 Oct: "check the logs if you're logging
 * anything"): one tap opens what will be sent (WHAT_IS_SENT) and an optional note, a second sends it.
 * The id that comes back is the one to quote. The note is how a player reaches us until there is a
 * support email (privacy.html and terms.html point here for data requests, player reports and appeals:
 * the legal review, 29 Oct). With the bot check on (the build has VITE_TURNSTILE_SITEKEY), its widget
 * sits above Send, and Send waits for it; each token is used once. ReportSentNote: the line under a
 * failed connection's alert once the automatic report has gone.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BotCheck, botCheckOn } from '../shell/account/BotCheck';
import { Icon } from '../ui/Icon';
import { MAX_NOTE, WHAT_IS_SENT, reportStore, sendReport } from './report';
import './report.css';

type Stage = { s: 'idle' } | { s: 'confirm' } | { s: 'sending' } | { s: 'sent'; id: string } | { s: 'failed'; why: 'offline' | 'busy' | 'error' };

const FAILED: Record<'offline' | 'busy' | 'error', string> = {
  offline: 'It didn’t go: no connection to the server. Try again once you’re online.',
  busy: 'Several reports went from here already. Try again in a few minutes.',
  error: 'It didn’t go. Try again.',
};

/** `context`: where it's sent from ("settings", "pause"), so the owner knows what the player was doing. */
export function SendReport({ context, className = '' }: { context: string; className?: string }) {
  const [stage, setStage] = useState<Stage>({ s: 'idle' });
  const [note, setNote] = useState('');
  // the bot check's token, and its round (each token is good for one send)
  const [bot, setBot] = useState<string | null>(null);
  const [botRound, setBotRound] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // opened at the foot of a short panel (the phone's pause menu): it scrolls into view
  useEffect(() => {
    if (stage.s !== 'idle') box.current?.scrollIntoView?.({ block: 'nearest' });
  }, [stage.s]);
  const send = async () => {
    setStage({ s: 'sending' });
    const r = await sendReport('manual', context, note, bot ?? undefined);
    if (bot) {
      setBot(null);
      setBotRound((n) => n + 1);
    }
    if (r.ok) setNote('');
    setStage(r.ok ? { s: 'sent', id: r.id } : { s: 'failed', why: r.why });
  };
  if (stage.s === 'idle')
    return (
      <button type="button" className={`btn btn--ghost btn--sm m-p8 mf-report-btn ${className}`.trim()} onClick={() => setStage({ s: 'confirm' })}>
        <Icon name="send" />
        Send a report
      </button>
    );
  return (
    <div ref={box} className={`mf-report ${className}`.trim()} role="group" aria-label="Send a report">
      {stage.s === 'sent' ? (
        <p className="mf-report__done" role="status">
          <Icon name="ok" size="sm" />
          Sent. Report <b className="num">{stage.id}</b>: quote it if you tell us what went wrong.
        </p>
      ) : (
        <>
          <p className="mf-report__what">
            <b>Sends:</b> {WHAT_IS_SENT}
          </p>
          <label className="mf-report__note">
            <span>Note (optional)</span>
            <textarea
              value={note}
              maxLength={MAX_NOTE}
              rows={2}
              placeholder="What went wrong, a player to report, or a request about your data. Add your in-game name."
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <BotCheck action="report" round={botRound} onToken={setBot} />
          {stage.s === 'failed' && (
            <p className="mf-report__bad" role="alert">
              <Icon name="bad" size="sm" />
              {FAILED[stage.why]}
            </p>
          )}
          <span className="mf-report__acts">
            <button type="button" className="btn btn--volt btn--sm m-p8" disabled={stage.s === 'sending' || (botCheckOn && !bot)} onClick={() => void send()}>
              <Icon name="send" />
              {stage.s === 'sending' ? 'Sending…' : stage.s === 'failed' ? 'Try again' : 'Send'}
            </button>
            <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={() => setStage({ s: 'idle' })}>
              Cancel
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/** Under a failed connection's alert: the automatic report went (with its id), or nothing. */
export function ReportSentNote() {
  const last = useSyncExternalStore(reportStore.subscribe, () => reportStore.getState().last, () => null);
  if (!last || last.reason !== 'auto' || Date.now() - last.at > 5 * 60_000) return null;
  return (
    <p className="conn__body mf-report__auto">
      <Icon name="send" size="sm" />A report of what happened went to us (<span className="num">{last.id}</span>), so we can fix it.
    </p>
  );
}
