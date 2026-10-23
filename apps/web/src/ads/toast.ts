/**
 * The quiet line tap-to-save answers with: "Saved · Deet Studios · we'll show it after the match".
 * One small plate near the top of the play area, no sound, gone in a few seconds. It's an ARIA
 * polite live region (role="status"), present from the start so screen readers announce each change.
 */
import './ads.css';

/** how long a line stays, ms */
export const TOAST_MS = 2600;

export class AdToast {
  readonly el: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement = document.body) {
    const el = document.createElement('div');
    el.className = 'mf-adtoast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    parent.appendChild(el);
    this.el = el;
  }

  show(text: string, ms = TOAST_MS): void {
    this.el.textContent = text;
    this.el.classList.add('is-on');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), ms);
  }

  hide(): void {
    this.el.classList.remove('is-on');
    // emptied after the fade, so the next line is announced as new
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.el.textContent = ''), 400);
  }
}

/** The toast's words for a save. */
export function savedLine(name: string, again: boolean): string {
  return again ? `Already saved · ${name} · it's on your list` : `Saved · ${name} · we'll show it after the match`;
}
