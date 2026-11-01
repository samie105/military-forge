/**
 * The turn-your-phone card: on an upright phone the page plays turned onto its side (ui/landscape.ts), so
 * the first screen there asks, once, in a card that reads upright (the game itself never asks again: it
 * just plays sideways). The title shows it first (UX audit 31 Oct, A-25: the first screen a phone user
 * saw was sideways with no word); the name screen shows it if the title didn't (a room link skips the title).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';

/** The upright-phone card was seen (once a phone). */
export const TURN_TIP_KEY = 'mf.phone.turnTip.v1';

export function turnTipSeen(): boolean {
  try {
    return localStorage.getItem(TURN_TIP_KEY) === 'seen';
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
/** this page's own answer (private mode keeps nothing: the card still asks once per page) */
let seenHere = false;

export function markTurnTipSeen(): void {
  seenHere = true;
  try {
    localStorage.setItem(TURN_TIP_KEY, 'seen');
  } catch {
    /* private mode: it shows again next time */
  }
  listeners.forEach((fn) => fn());
}

const seenNow = () => seenHere || turnTipSeen();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Whether the card was seen, live: the title's answer reaches the name screen already drawn under it. */
export function useTurnTipSeen(): boolean {
  return useSyncExternalStore(subscribe, seenNow, seenNow);
}

/** `line`: why this screen reads better sideways. Its button takes the focus. */
export function TurnTip({ line, onDone }: { line: string; onDone: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus({ preventScroll: true }), []);
  return (
    <div className="pm-turn" role="dialog" aria-label="Turn your phone sideways">
      <div className="pm-turn__card plate">
        <Icon name="rotate" />
        <b className="display">Turn your phone sideways</b>
        <p>{line}</p>
        <button ref={button} type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(onDone)}>
          Keep it upright
        </button>
      </div>
    </div>
  );
}
