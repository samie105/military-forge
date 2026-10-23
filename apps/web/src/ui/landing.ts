/**
 * The landing (index.html; docs/seo.md): real HTML at `/` for search engines and link previews, drawn
 * as the title screen's first frame. public/boot.js runs it until the app is up; this is the app's half:
 *
 *   releaseLanding()       the app has its first screen: the landing stays in the page (search engines
 *                          read the rendered page) but under the game, inert (no focus, no screen
 *                          reader), and nothing of it animates
 *   aboutOpen()            the About sheet is open (it owns the keyboard and the pointer then)
 *   landingOwns(target)    an event on the sheet, or on a way into it: the title screen leaves it alone
 *   onPlay(fn)             Play now, pressed before the title was ready or on the sheet
 */

/** The landing's parts that sit under the app once it's up (the About sheet stays reachable). */
const UNDER_APP = ['land-hero', 'land-foot'] as const;

export function releaseLanding(doc: Document = document): void {
  doc.documentElement.classList.add('mf-app');
  for (const id of UNDER_APP) doc.getElementById(id)?.setAttribute('inert', '');
}

export function aboutOpen(doc: Document = document): boolean {
  return doc.documentElement.classList.contains('mf-about-open');
}

/** True for an event the landing handles: anything while the sheet is open, or on a link into it. */
export function landingOwns(target: EventTarget | null, doc: Document = document): boolean {
  if (aboutOpen(doc)) return true;
  const el = target as Element | null;
  return typeof el?.closest === 'function' && el.closest('#about, a[href="#about"], a[href="#play"]') !== null;
}

/**
 * Calls `fn` once Play now is pressed: now, if it was pressed before the app was ready (boot.js
 * remembers it on <html data-play>), else on the next press. Returns the unsubscribe.
 */
export function onPlay(fn: () => void, win: Window = window): () => void {
  const root = win.document.documentElement;
  const take = () => {
    if (root.getAttribute('data-play') !== '1') return;
    root.removeAttribute('data-play');
    fn();
  };
  take();
  win.addEventListener('mf:play', take);
  return () => win.removeEventListener('mf:play', take);
}
