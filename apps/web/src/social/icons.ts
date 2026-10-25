/**
 * The social screens' own icons, in the kit's line style (24×24, stroke = currentColor), as a small
 * sprite of their own so ui/sprite.ts stays the design kit's. Use them like any kit icon:
 * <Icon name="sx-mic" /> → #icon-sx-mic.
 */
const SYMBOLS: Record<string, string> = {
  friends: '<circle cx="9" cy="8" r="3.6"/><path d="M2 20.5c.8-3.8 3.4-5.8 7-5.8s6.2 2 7 5.8"/><path d="M15.5 4.6a3.6 3.6 0 0 1 0 6.8M18 14.9c2.3.7 3.6 2.6 4 5.6"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M8.5 21.5h7"/>',
  'mic-off': '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M8.5 21.5h7M3.5 3.5l17 17"/>',
  vol: '<path d="M3.5 9h4L13 4.5v15L7.5 15h-4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  'vol-x': '<path d="M3.5 9h4L13 4.5v15L7.5 15h-4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  flag: '<path d="M5 21.5V3.5M5 4h12l-2.5 4.5L17 13H5"/>',
  dots: '<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
  'user-check': '<circle cx="9" cy="8" r="4"/><path d="M1.5 21c.8-4 3.6-6 7.5-6s6.7 2 7.5 6M15.5 10l2.5 2.5 4.5-5"/>',
  // the radio (voice/Radio.tsx): on air (talking), and the comms sheet's "Hold to talk"
  onair: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a6.5 6.5 0 0 1-6.5 6.5h-1A6.5 6.5 0 0 1 7 18.4L4.6 14.6a1.5 1.5 0 0 1 2.5-1.7L8 14"/>',
  hourglass: '<path d="M6 2.5h12M6 21.5h12M7.5 2.5c0 5 9 5 9 9.5s-9 4.5-9 9.5M16.5 2.5c0 5-9 5-9 9.5s9 4.5 9 9.5"/>',
};

const ID = 'mf-social-sprite';

/** Puts the social icons on the page (once). */
export function mountSocialSprite(doc: Document = document): void {
  if (doc.getElementById(ID)) return;
  const wrap = doc.createElement('div');
  wrap.id = ID;
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">${Object.entries(SYMBOLS)
    .map(([name, body]) => `<symbol id="icon-sx-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('')}</svg>`;
  doc.body.appendChild(wrap);
}

export const SOCIAL_ICONS = Object.keys(SYMBOLS).map((n) => `sx-${n}`);
