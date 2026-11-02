/**
 * The words around a name (NameEntry.tsx, PhoneNameEntry.tsx, the controller's cooldown answer), pure
 * so the tests read them: the next change as a plain date ("8 Nov", never "11/8/2026": UX-07), and the
 * status lines as whole sentences (C-35: "Someone already has that name Try one of these:").
 */

/** A date as the game writes it: "8 Nov" (and the year when it isn't this year's: "3 Jan 2027"). */
export function plainDate(when: string | number | Date, now: number = Date.now()): string {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return 'soon';
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** A line as a sentence: its full stop added when it has none. */
export function sentence(line: string): string {
  const t = line.trim();
  return !t || /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** A refused name's line, and the way on when there are names to pick from. */
export function refusedLine(reason: string, suggestions: boolean): string {
  return suggestions ? `${sentence(reason)} Try one of these.` : sentence(reason);
}
