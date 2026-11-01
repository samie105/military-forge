/**
 * Option groups (role="radiogroup": the lobby's time limit, bots and maps, Settings' segmented
 * controls, the Locker's swatches) are one tab stop each, as the Settings tabs are (UX audit 1, D-10:
 * a keyboard player tabbed 38 times from the lobby's Leave to Ready). The chosen option (else the
 * first) takes Tab; the arrow keys move along the group and choose, as radio buttons do; Home and End
 * go to its ends. A controller moves between the options as before (gamepad/menus.ts: every option
 * stays a button), so nothing changes for it.
 *
 * Nothing to wire per screen: the tab stops are set just before a Tab press moves focus (and when focus
 * enters a group), so options drawn by React, by a route's own HTML or later are all covered.
 */

const GROUP = '[role="radiogroup"]';
const OPTION = '[role="radio"]';

const enabled = (o: HTMLElement) => !(o as HTMLButtonElement).disabled && o.getAttribute('aria-disabled') !== 'true' && !o.closest('[hidden], [inert]');

/** The group's own options (not a nested group's), in order. */
export function groupOptions(group: Element): HTMLElement[] {
  return Array.from(group.querySelectorAll<HTMLElement>(OPTION)).filter((o) => o.closest(GROUP) === group);
}

/** Which option of a group takes Tab (pure): the focused one, the chosen one, else the first that can be chosen; −1 for none. */
export function tabStop(options: readonly { checked: boolean; enabled: boolean; focused: boolean }[]): number {
  const focused = options.findIndex((o) => o.focused && o.enabled);
  if (focused >= 0) return focused;
  const checked = options.findIndex((o) => o.checked && o.enabled);
  return checked >= 0 ? checked : options.findIndex((o) => o.enabled);
}

/** The option an arrow, Home or End lands on (pure): wrapping round, over the ones that can be chosen; −1: not a move. */
export function roveTo(enabledFlags: readonly boolean[], from: number, key: string): number {
  const n = enabledFlags.length;
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (key === 'Home' || key === 'End') {
    const order = key === 'Home' ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    return order.find((i) => enabledFlags[i]) ?? -1;
  }
  if (!step || n === 0) return -1;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    if (enabledFlags[i]) return i;
  }
  return -1;
}

/** One group: its tab stop on the option `tabStop` picks, the others out of the Tab order. */
export function rove(group: Element, active: Element | null = document.activeElement): void {
  const options = groupOptions(group);
  const stop = tabStop(options.map((o) => ({ checked: o.getAttribute('aria-checked') === 'true', enabled: enabled(o), focused: o === active })));
  options.forEach((o, i) => {
    const want = i === stop ? '0' : '-1';
    if (o.getAttribute('tabindex') !== want) o.setAttribute('tabindex', want);
  });
}

let started = false;

/** Once, at boot (main.ts). */
export function startRovingGroups(doc: Document = document): void {
  if (started || typeof doc.addEventListener !== 'function') return;
  started = true;
  doc.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Tab') {
        // before the browser picks the next stop
        for (const g of doc.querySelectorAll(GROUP)) rove(g);
        return;
      }
      const option = (e.target as Element | null)?.closest?.(OPTION) as HTMLElement | null;
      const group = option?.closest(GROUP);
      if (!option || !group || e.altKey || e.ctrlKey || e.metaKey) return;
      const options = groupOptions(group);
      const to = roveTo(options.map(enabled), options.indexOf(option), e.key);
      if (to < 0) return;
      e.preventDefault();
      const next = options[to]!;
      // choosing follows the arrows (a radio group); the option keeps focus (its click may hand focus back: blurAfter)
      if (next.getAttribute('aria-checked') !== 'true') next.click();
      next.focus({ preventScroll: false });
      rove(group, next);
    },
    true,
  );
  doc.addEventListener('focusin', (e) => {
    const group = (e.target as Element | null)?.closest?.(GROUP);
    if (group) rove(group, e.target as Element);
  });
}
