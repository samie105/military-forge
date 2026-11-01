/**
 * The play-stats choice on Home (docs/16-player-metrics.md §6.2): one quiet card, once, with two
 * buttons of equal weight. Where the default is opt-in it asks; where the owner chose opt-out (never
 * Europe) it says the stats are on and offers Turn off. It never shows over a match, never twice
 * after an answer, and not at all when the browser asks sites not to track it. Settings → Privacy
 * changes the answer any time.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Icon } from '../ui/Icon';
import { focusFree, homeAsk, useHomeStopsRunning, type HomeAsk } from '../tour/homeQueue';
import { consentAskable, promptDue, type ConsentState } from './consent';
import { metrics } from './index';
import { ADS_LIVE } from '../ads/live';
import { useTourFacts } from '../tour/live';
import './consent.css';

const idle: ConsentState = { choice: { analytics: false, at: 0, via: 'settings' }, mode: 'opt-in', ready: false, browserNo: false, segments: false };
const noop = () => () => {};

export function useConsent(): ConsentState {
  const m = metrics();
  return useSyncExternalStore(m ? (fn) => m.consent.subscribe(fn) : noop, () => m?.consent.get() ?? idle, () => idle);
}

/** Whether the question is due (Home's queue, tour/homeQueue.ts, puts it before the Home stops and Next orders). */
export function useConsentDue(): boolean {
  const facts = useTourFacts();
  return promptDue(useConsent()) !== null && consentAskable(facts ? facts.matches.finished : null);
}

/**
 * The card's words (the owner's, 26 Oct). While the billboard ads are off (ads/live.ts), the clause about
 * the ads goes: it would be a reason to say no, and not quite true.
 */
export function consentLine(due: 'ask' | 'tell', adsLive = ADS_LIVE): string {
  if (due === 'ask') return adsLive ? 'We use how you play to improve the game and to pick the ads you see. Never your name. You can change this in Settings.' : 'We use how you play to improve the game. Never your name. You can change this in Settings.';
  return adsLive ? 'We count how you play (never your name) to fix what breaks, balance the guns and pick house ads.' : 'We count how you play (never your name) to fix what breaks and balance the guns.';
}

/**
 * What Home is asking now (tour/homeQueue.ts): this question, the Home stops, or nothing. Next orders and the
 * phone's install toast wait while it's anything.
 */
export function useHomeAsk(): HomeAsk {
  return homeAsk(useConsentDue() && metrics() !== null, useHomeStopsRunning());
}

export const PRIVACY_URL = '/privacy.html';

export function ConsentCard({ where }: { where: 'home' | 'phone' }) {
  const s = useConsent();
  const asked = useConsentDue();
  const due = asked ? promptDue(s) : null;
  const m = metrics();
  // one thing at a time on Home (audit 31 Oct, D-01): a Home stops pass already running goes first
  const showing = useHomeAsk() === 'consent';
  const card = useRef<HTMLElement>(null);
  // the question takes the focus as it appears (it came last in the tab order: D-01), unless the player is on something
  useEffect(() => {
    if (showing && focusFree()) card.current?.focus({ preventScroll: true });
  }, [showing]);
  if (!due || !m || !showing) return null;
  const answer = (yes: boolean) => m.consent.set(yes, due === 'ask' ? 'prompt' : 'notice');
  return (
    <aside ref={card} tabIndex={-1} className={`mf-consent mf-consent--${where}`} role="dialog" aria-labelledby="mf-consent-title" aria-describedby="mf-consent-line">
      <span className="mf-consent__tile" aria-hidden="true">
        <Icon name="eye" />
      </span>
      <span className="mf-consent__words">
        <span className="mf-consent__eyebrow">{due === 'ask' ? 'Your call' : 'Play data is on'}</span>
        <b id="mf-consent-title" className="mf-consent__title display">
          {due === 'ask' ? 'Can we use your play data?' : 'Helping improve the game'}
        </b>
        <span id="mf-consent-line" className="mf-consent__line">
          {consentLine(due)}{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noopener" className="mf-consent__link">
            Privacy
          </a>
        </span>
      </span>
      <span className="mf-consent__buttons">
        {due === 'ask' ? (
          <>
            <button type="button" className="mf-consent__btn m-p8" onClick={() => answer(false)}>
              No thanks
            </button>
            <button type="button" className="mf-consent__btn m-p8" onClick={() => answer(true)}>
              Yes, that's fine
            </button>
          </>
        ) : (
          <>
            <button type="button" className="mf-consent__btn m-p8" onClick={() => answer(false)}>
              Turn off
            </button>
            <button type="button" className="mf-consent__btn m-p8" onClick={() => answer(true)}>
              OK
            </button>
          </>
        )}
      </span>
    </aside>
  );
}
