/**
 * One thing at a time on Home (UX audit 31 Oct, D-01 + A-26): the first visit stacked the play-data
 * question, the Home stops' coach mark and Next orders on top of each other. They queue now: the
 * question first (it's asked once and answered in a tap), then the stops (main.ts starts them only
 * once it's answered), then Next orders, which keep the column's usual card until both are done.
 * A pass already running when the question becomes due (the API's answer came late) finishes first.
 * Whichever is showing takes the focus (ConsentCard, homeStops.ts).
 */
import { useSyncExternalStore } from 'react';

/** What Home is asking now: the play-data question, the Home stops, or nothing (Next orders may show). */
export type HomeAsk = 'consent' | 'stops' | null;

/** Pure: the stops once started run to their end; else the question while it's due. */
export function homeAsk(consentDue: boolean, stopsRunning: boolean): HomeAsk {
  if (stopsRunning) return 'stops';
  return consentDue ? 'consent' : null;
}

let running = false;
const listeners = new Set<() => void>();

/** homeStops.ts: the pass started (true) or ended (false). */
export function setHomeStopsRunning(on: boolean): void {
  if (on === running) return;
  running = on;
  listeners.forEach((fn) => fn());
}

export function homeStopsRunning(): boolean {
  return running;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The Home stops are on screen now (React). */
export function useHomeStopsRunning(): boolean {
  return useSyncExternalStore(subscribe, homeStopsRunning, homeStopsRunning);
}

/** Focus goes to what's asking only when the player isn't already on something else (a tab, a field). */
export function focusFree(within?: Element | null): boolean {
  if (typeof document === 'undefined') return false;
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement || (!!within && within.contains(a));
}
