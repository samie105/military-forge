/**
 * The device's own event log for problem reports (report.ts; the owner, 24 Oct: "check the logs if
 * you're logging anything"). A local room runs between the players' phones and the box never sees
 * it, so what happened there is only known on the phone: each step and error of a local room, the
 * WebRTC states, the transport's connects, drops and reconnects, and the last script errors.
 *
 * In memory only, the last MAX_EVENTS lines, each a kind and one short line (no game data, nothing
 * personal: room codes, states, error messages and timings). It leaves the device only in a report.
 */

/** the newest this many events are kept */
export const MAX_EVENTS = 300;
/** the newest this many script errors are kept */
export const MAX_ERRORS = 20;
/** one line is cut to this */
export const MAX_LINE = 240;

export interface DiagEvent {
  /** ms since the page loaded */
  t: number;
  /** what it's about: lan, rtc, net, room, ui… */
  k: string;
  m: string;
}

const events: DiagEvent[] = [];
const errors: string[] = [];
const started = typeof performance !== 'undefined' ? performance.now() : 0;
const clock = () => (typeof performance !== 'undefined' ? Math.round(performance.now() - started) : 0);

/** Notes one event (`kind`: a short word; `line`: what happened, one line). */
export function diag(kind: string, line: string): void {
  events.push({ t: clock(), k: kind.slice(0, 24), m: line.slice(0, MAX_LINE) });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** Notes a script error (window error, an unhandled rejection, or a caught one worth keeping). */
export function diagError(what: unknown): void {
  const e = what as { message?: string; stack?: string } | null;
  const text = (e?.stack ?? e?.message ?? String(what)).split('\n').slice(0, 4).join(' | ');
  errors.push(`${clock()} ${text}`.slice(0, 400));
  if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
  diag('error', e?.message ?? String(what));
}

export const diagEvents = (): readonly DiagEvent[] => events;
export const diagErrors = (): readonly string[] => errors;

/** For tests: starts over. */
export function clearDiag(): void {
  events.length = 0;
  errors.length = 0;
}

let hooked = false;
/** Once, early (main.ts): script errors and unhandled rejections go in the log. */
export function hookDiagErrors(): void {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  window.addEventListener('error', (e) => diagError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => diagError(e.reason));
  diag('page', `loaded ${location.pathname}${location.search ? ' (with a query)' : ''}`);
  document.addEventListener('visibilitychange', () => diag('page', document.visibilityState));
  window.addEventListener('online', () => diag('net', 'the browser says online'));
  window.addEventListener('offline', () => diag('net', 'the browser says offline'));
}
