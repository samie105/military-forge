/**
 * One thing at a time on Home (UX audit 31 Oct, D-01 + A-26): the first visit stacked the play-data
 * question, the Home stops' coach mark and Next orders on top of each other. They queue now: the
 * question first (it's asked once and answered in a tap), then the stops (main.ts starts them only
 * once it's answered), then Next orders, which keep the column's usual card until both are done.
 * A pass already running when the question becomes due (the API's answer came late) finishes first.
 * Whichever is showing takes the focus (ConsentCard, homeStops.ts). "Keep this name?" and the install
 * toast queue the same way (homeTurn below), and the stops never start over an open panel.
 */
import { useSyncExternalStore } from 'react';

/** What Home is asking now: the play-data question, the Home stops, or nothing (Next orders may show). */
export type HomeAsk = 'consent' | 'stops' | null;

/** Pure: the stops once started run to their end; else the question while it's due. */
export function homeAsk(consentDue: boolean, stopsRunning: boolean): HomeAsk {
  if (stopsRunning) return 'stops';
  return consentDue ? 'consent' : null;
}

/**
 * Whose turn it is on Home (UX atlas 1 Nov, UX-06 / UX-14): one ask at a time, in this order. A Home
 * stops pass already running finishes first; then the play-data question; then "Keep this name?";
 * then the install toast (phones). The Home stops are the last in line: they start only when nobody
 * else has the turn and nothing is open over Home (stopsMayStart).
 */
export type HomeTurn = 'stops' | 'consent' | 'name' | 'install' | null;

export interface HomeTurnInput {
  /** the play-data question is due (metrics/ConsentCard.tsx) */
  consentDue: boolean;
  /** a Home stops pass is on screen */
  stopsRunning: boolean;
  /** "Keep this name?" is due (KeepName.tsx: a generated callsign, online) */
  nameDue: boolean;
  /** the install toast is up (pwa/InstallToast.tsx) */
  installUp: boolean;
}

/** Pure: who has the turn now. */
export function homeTurn(i: HomeTurnInput): HomeTurn {
  if (i.stopsRunning) return 'stops';
  if (i.consentDue) return 'consent';
  if (i.nameDue) return 'name';
  if (i.installUp) return 'install';
  return null;
}

/**
 * The Home stops may start: nobody else has the turn and no layer is open over Home (the Friends
 * panel, the Lobby feed, an overlay, a route: shell/history.ts's open layers). A coach mark never
 * appears dimmed behind a panel (UX-06 b).
 */
export function stopsMayStart(i: HomeTurnInput, layersOpen: number): boolean {
  return !i.stopsRunning && homeTurn(i) === null && layersOpen === 0;
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
