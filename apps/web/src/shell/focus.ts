/**
 * Keyboard focus at the hand-off from the menus to play. The game reads its keys from the whole
 * window, but while one of the shell's controls has focus, Space and the arrows are that control's
 * (input.ts menusHaveKeys: Space presses a focused button on its release). So when play starts the
 * shell lets go of the keyboard: nothing in #shell keeps focus over a running match.
 */

/** Blurs the focused element when it is one of the shell's (#shell); true when it did. */
export function releaseShellFocus(doc: Pick<Document, 'activeElement'> | undefined = globalThis.document): boolean {
  const el = doc?.activeElement as (Element & { blur?(): void }) | null | undefined;
  if (!el || typeof el.closest !== 'function' || el.closest('#shell') === null || typeof el.blur !== 'function') return false;
  el.blur();
  return true;
}
