/**
 * Phones always play in landscape, whichever way they're held (the owner: "on mobile the view is
 * automatic landscape, they don't have a choice").
 *
 *  1. On a touch phone the first tap asks for full screen, then for a landscape lock
 *     (screen.orientation.lock: Android Chrome); every refusal is caught.
 *  2. Where the lock isn't possible (iPhone Safari, a refused lock) and the phone is upright, the
 *     whole page turns 90° clockwise: <html class="mf-rotated">, and <body> becomes a landscape box
 *     (--app-w × --app-h) turned onto the portrait screen (index.html's style). There's no "turn your
 *     phone" screen: it just works sideways.
 *
 * While the page is turned, the browser's own numbers are the portrait screen's: innerWidth and
 * innerHeight, a pointer's clientX/clientY and getBoundingClientRect(). Layout sizes (clientWidth,
 * offsetWidth) and CSS are already the landscape box's. Code that mixes the two goes through this
 * module: viewport() for the window's size, logicalPoint() for a pointer, logicalRect() for a box.
 *
 * The turn: translateX(W) rotate(90deg) about the top left, W = the screen's width. A point (x, y) in
 * the landscape box lands on the screen at (W − y, x); so a screen point (sx, sy) is (sy, W − sx).
 * The landscape box's top is the screen's right edge: the phone is held with its top to the left.
 */

/** A phone held sideways (the phone menus' and HUD's query; shell/screens/phone/layout.tsx). */
export const LANDSCAPE_PHONE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)';
/** A phone held upright: no wider than 500 px, a finger for a pointer. Tablets (768 px up) never turn. */
export const UPRIGHT_PHONE_QUERY = '(orientation: portrait) and (max-width: 500px) and (pointer: coarse)';

export interface Point {
  x: number;
  y: number;
}
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
type RectLike = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;

import './landscape.css';

const matches = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;

/** The page is turned onto an upright phone right now. */
export function isRotated(): boolean {
  return matches(UPRIGHT_PHONE_QUERY);
}

/** A phone, held either way: the phone layouts apply (rotated or not). */
export function isPhoneShape(): boolean {
  return matches(LANDSCAPE_PHONE_QUERY) || matches(UPRIGHT_PHONE_QUERY);
}

/** The window's size as the page lays out in it: landscape when turned. */
export function viewport(rotated = isRotated(), w = innerWidth, h = innerHeight): { w: number; h: number } {
  return rotated ? { w: h, h: w } : { w, h };
}

/** A screen point (clientX, clientY) in the page's own coordinates. `screenW`: innerWidth. */
export function toLogical(x: number, y: number, rotated: boolean, screenW: number): Point {
  return rotated ? { x: y, y: screenW - x } : { x, y };
}

/** The other way: where a point of the page lands on the screen. */
export function toScreen(x: number, y: number, rotated: boolean, screenW: number): Point {
  return rotated ? { x: screenW - y, y: x } : { x, y };
}

/** A screen movement (a drag's dx, dy) in the page's own axes. */
export function vecToLogical(dx: number, dy: number, rotated: boolean): Point {
  return rotated ? { x: dy, y: 0 - dx } : { x: dx, y: dy }; // (0 − dx: no −0)
}

/** A screen box (getBoundingClientRect: exact for a quarter turn) as the page's box. */
export function rectToLogical(r: RectLike, rotated: boolean, screenW: number): Box {
  if (!rotated) return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height };
  const top = screenW - (r.left + r.width);
  return { left: r.top, top, right: r.top + r.height, bottom: top + r.width, width: r.height, height: r.width };
}

/** A pointer event's place in the page's coordinates. */
export function logicalPoint(e: { clientX: number; clientY: number }): Point {
  return toLogical(e.clientX, e.clientY, isRotated(), innerWidth);
}

/** An element's box in the page's coordinates (the turned page's getBoundingClientRect). */
export function logicalRect(el: Element): Box {
  return rectToLogical(el.getBoundingClientRect(), isRotated(), innerWidth);
}

// ---- the page's state: the class, the box's size, full screen and the lock ----

/** <html> classes: mf-rotated (turned now), mf-phone (a phone layout either way: the CSS's phone switch). */
export function applyLandscape(root: HTMLElement = document.documentElement): void {
  const rotated = isRotated();
  root.classList.toggle('mf-rotated', rotated);
  root.classList.toggle('mf-phone', rotated || matches(LANDSCAPE_PHONE_QUERY));
  // the turned body's size: the screen's, swapped (index.html)
  root.style.setProperty('--app-w', `${innerHeight}px`);
  root.style.setProperty('--app-h', `${innerWidth}px`);
}

interface LockableOrientation {
  lock?: (o: string) => Promise<void>;
}

/** Launched from the home screen as an installed app in full screen: no browser bars to hide. */
export function installedFullscreen(): boolean {
  return matches('(display-mode: fullscreen)') || matches('(display-mode: standalone)') || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Full screen, then the landscape lock; whatever is refused is fine (the page turns instead). */
export async function enterLandscape(doc: Document = document): Promise<void> {
  const el = doc.documentElement as HTMLElement & { requestFullscreen?: HTMLElement['requestFullscreen'] };
  try {
    if (!doc.fullscreenElement && typeof el.requestFullscreen === 'function') await el.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    /* refused or unsupported (iPhone Safari): the lock may still work, and the turn always does */
  }
  try {
    const o = (typeof screen !== 'undefined' ? screen.orientation : undefined) as LockableOrientation | undefined;
    if (typeof o?.lock === 'function') await o.lock('landscape');
  } catch {
    /* no lock here: the page turns instead (mf-rotated) */
  }
}

const listeners = new Set<() => void>();
let started = false;

/** Called when the page turns or straightens (after the classes changed). Returns an unsubscribe. */
export function onLandscapeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Keeps the classes and the box's size current, and arms the first tap. main.ts calls it before the
 * fit, the HUD and the touch controls start, so their resize handlers see the turned box.
 */
export function startLandscape(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const update = () => {
    const was = document.documentElement.classList.contains('mf-rotated');
    applyLandscape();
    if (was !== document.documentElement.classList.contains('mf-rotated')) for (const fn of listeners) fn();
  };
  update();
  window.addEventListener('resize', update);
  for (const q of [UPRIGHT_PHONE_QUERY, LANDSCAPE_PHONE_QUERY]) matchMedia(q).addEventListener?.('change', update);
  // a tap on a phone (Play, Join, Continue, a dial): full screen and the lock need a user's gesture. Not
  // once only: full screen lost (a swipe from an edge, the keyboard, another page such as the Armory),
  // the next tap takes it back, so the browser's bars don't come back to stay (the owner, 23 Oct)
  let askedAt = -Infinity;
  const tap = () => {
    if (!isPhoneShape() || document.fullscreenElement || installedFullscreen()) return;
    // at most once a second (a refusal, or a browser without it, shouldn't be asked on every tap)
    const now = performance.now();
    if (now - askedAt < 1000) return;
    askedAt = now;
    void enterLandscape();
  };
  window.addEventListener('pointerup', tap, true);
}
