/**
 * The reconnect's schedule (onlineMode.ts): a dropped connection tries again after 250 ms, doubling
 * to 2 s, until the room's reconnect window runs out. The banner and the lost card count the tries
 * against it ("Try 3 of 32", docs/design/pen-diff.md N3).
 */

/** The wait before try `n + 1` (n tries made). */
export function reconnectDelay(n: number): number {
  return Math.min(2000, 250 * 2 ** n);
}

/** The tries a window of `windowMs` holds at that schedule, when each fails at once: the most there can be. */
export function reconnectTries(windowMs: number): number {
  let t = 0;
  let n = 0;
  while (t + reconnectDelay(n) <= windowMs) {
    t += reconnectDelay(n);
    n++;
  }
  return Math.max(1, n);
}

/** How long a dropped player keeps trying (the room's reconnect grace, as onlineMode.ts waits it out). */
export const RECONNECT_WINDOW_MS = 60_000;
