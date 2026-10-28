/**
 * The kit's screens are drawn at 1920×1080 (the phone HUD at 812×375). The app scales them to the
 * window with CSS zoom and stretches them to its shape, so a screen always fills the window:
 *
 *   --fit, --fit-w, --fit-h        menus and game overlays: zoom = min(w/1920, h/1080), and the
 *                                  window's size in design pixels (≥ 1920×1080 on one side); in
 *                                  small windows the zoom stays at 0.8 or more while the screens
 *                                  keep at least 1600×900 design pixels to reflow in (menuFit)
 *   --hud-fit, --hud-w, --hud-h    the desktop HUD: the same, kept between 0.75 and 1.5 so its text
 *                                  stays readable in small windows (it anchors to the corners)
 *   --phone-fit, --phone-w, ...    the phone HUD: min(w/812, h/375)
 *
 * Set on <html> once and on every resize, with two classes for the menus' smaller boxes (app.css
 * reflows the wide screens in them): html.mf-narrow under 1800 design pixels wide, html.mf-short
 * under the design's full 1080 high (SHORT_H). The short reflow must start the moment a screen loses
 * any of its 1080: a 1280×800 laptop is 1600×1000 at the 0.8 floor, and with the old 1000 line it got
 * neither its full height nor the reflow, so Home, the Armory, the lobby, the creator and the results
 * ran off the bottom (audit 28 Oct). On an upright phone the page is turned (landscape.ts) and the window's size is
 * the turned box's.
 */
import { applyLandscape, viewport } from './landscape';

export const DESIGN_W = 1920;
export const DESIGN_H = 1080;
export const PHONE_W = 812;
export const PHONE_H = 375;
export const HUD_MIN_FIT = 0.75;
export const HUD_MAX_FIT = 1.5;
/** menus zoom no lower than this where the window leaves them MENU_MIN_W × MENU_MIN_H to lay out in */
export const MENU_MIN_FIT = 0.8;
export const MENU_MIN_W = 1600;
export const MENU_MIN_H = 900;
/** below this many design pixels high the menus take their short layouts (html.mf-short) */
export const SHORT_H = DESIGN_H;
/** below this many design pixels wide, their narrow ones (html.mf-narrow) */
export const NARROW_W = 1800;

/** The menus' reflow classes for a fit: narrow under NARROW_W, short under SHORT_H (rounding slack: 0.5 px). */
export function menuShape(f: Fit): { narrow: boolean; short: boolean } {
  return { narrow: f.w < NARROW_W, short: f.h < SHORT_H - 0.5 };
}

export interface Fit {
  fit: number;
  w: number;
  h: number;
}

/** The zoom that fits a design of `dw`×`dh` into `vw`×`vh`, clamped, and the window in design pixels. */
export function fitTo(vw: number, vh: number, dw: number, dh: number, min = 0, max = Infinity): Fit {
  const fit = Math.min(max, Math.max(min, Math.min(vw / dw, vh / dh))) || 1;
  return { fit, w: vw / fit, h: vh / fit };
}

/**
 * The menus' fit: min(w/1920, h/1080), but on a small laptop (1280×720, 1366×768) no lower than
 * 0.8 as long as the screens keep 1600×900 design pixels, so the kit's 14 px floor stays readable
 * (11.2 px, not 9.3) and the screens reflow into the narrower box. Phones get the most zoom that
 * still leaves 1600×900.
 */
export function menuFit(vw: number, vh: number): Fit {
  const base = Math.min(vw / DESIGN_W, vh / DESIGN_H);
  const floor = Math.min(MENU_MIN_FIT, vw / MENU_MIN_W, vh / MENU_MIN_H);
  const fit = Math.max(base, floor) || 1;
  return { fit, w: vw / fit, h: vh / fit };
}

let started = false;

function apply(root: HTMLElement): void {
  // the page's own size: a phone held upright lays out sideways (landscape.ts)
  applyLandscape(root);
  const { w: vw, h: vh } = viewport();
  const set = (name: 'fit' | 'hud' | 'phone', f: Fit) => {
    const fit = name === 'fit' ? '--fit' : `--${name}-fit`;
    root.style.setProperty(fit, f.fit.toFixed(4));
    root.style.setProperty(`--${name}-w`, `${f.w.toFixed(1)}px`);
    root.style.setProperty(`--${name}-h`, `${f.h.toFixed(1)}px`);
  };
  const menus = menuFit(vw, vh);
  set('fit', menus);
  const shape = menuShape(menus);
  root.classList.toggle('mf-narrow', shape.narrow);
  root.classList.toggle('mf-short', shape.short);
  set('hud', fitTo(vw, vh, DESIGN_W, DESIGN_H, HUD_MIN_FIT, HUD_MAX_FIT));
  set('phone', fitTo(vw, vh, PHONE_W, PHONE_H));
}

/** Keeps the fit variables up to date (idempotent). */
export function startFitting(root: HTMLElement = document.documentElement): void {
  if (started) return;
  started = true;
  apply(root);
  window.addEventListener('resize', () => apply(root));
}
