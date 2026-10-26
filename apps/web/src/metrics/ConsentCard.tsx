/**
 * The play-stats choice on Home (docs/16-player-metrics.md §6.2): one quiet card, once, with two
 * buttons of equal weight. Where the default is opt-in it asks; where the owner chose opt-out (never
 * Europe) it says the stats are on and offers Turn off. It never shows over a match, never twice
 * after an answer, and not at all when the browser asks sites not to track it. Settings → Privacy
 * changes the answer any time.
 */
import { useSyncExternalStore } from 'react';
import { Icon } from '../ui/Icon';
import { promptDue, type ConsentState } from './consent';
import { metrics } from './index';
import './consent.css';

const idle: ConsentState = { choice: { analytics: false, at: 0, via: 'settings' }, mode: 'opt-in', ready: false, browserNo: false, segments: false };
const noop = () => () => {};

export function useConsent(): ConsentState {
  const m = metrics();
  return useSyncExternalStore(m ? (fn) => m.consent.subscribe(fn) : noop, () => m?.consent.get() ?? idle, () => idle);
}

/** Whether Home has the card up now (PhoneHome keeps the install toast back meanwhile). */
export function useConsentDue(): boolean {
  return promptDue(useConsent()) !== null;
}

export const PRIVACY_URL = '/privacy.html';

export function ConsentCard({ where }: { where: 'home' | 'phone' }) {
  const s = useConsent();
  const due = promptDue(s);
  const m = metrics();
  if (!due || !m) return null;
  const answer = (yes: boolean) => m.consent.set(yes, due === 'ask' ? 'prompt' : 'notice');
  return (
    <aside className={`mf-consent mf-consent--${where}`} role="dialog" aria-labelledby="mf-consent-title" aria-describedby="mf-consent-line">
      <span className="mf-consent__tile" aria-hidden="true">
        <Icon name="eye" />
      </span>
      <span className="mf-consent__words">
        <span className="mf-consent__eyebrow">{due === 'ask' ? 'Your call' : 'Play stats are on'}</span>
        <b id="mf-consent-title" className="mf-consent__title display">
          {due === 'ask' ? 'Help improve the game?' : 'Helping improve the game'}
        </b>
        <span id="mf-consent-line" className="mf-consent__line">
          {due === 'ask' ? 'Share how you play: sessions, screens, features. Never your name. It fixes what breaks, balances the guns and picks the house ads you see.' : 'We count how you play (never your name) to fix what breaks, balance the guns and pick house ads.'}{' '}
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
              Yes, share
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
