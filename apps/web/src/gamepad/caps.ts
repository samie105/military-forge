/** Shared DOM keycaps: use the same vector buttons as the React menus. */
import { currentDevice, currentPadFamily } from './device';
import { isPadCode, padGlyphSvg, padSpoken } from './glyphs';

export function drawButtonCap(el: HTMLElement, code: string | undefined, fallback: string): void {
  const pad = isPadCode(code);
  el.classList.toggle('kbd--pad', pad);
  if (pad) {
    el.dataset.padCode = code;
    el.innerHTML = padGlyphSvg(code, currentPadFamily());
    el.setAttribute('aria-label', padSpoken(code, currentPadFamily(), { dualSense: currentDevice().dualSense }));
  } else {
    delete el.dataset.padCode;
    el.removeAttribute('aria-label');
    el.textContent = fallback;
  }
}
