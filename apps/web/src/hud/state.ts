/**
 * The kit's state wiring (docs/design/military-forge-ui.html, "WIRING MARKERS"): the HUD root carries
 * data-active-state="token token…"; an element with data-state="a b+c" shows while token a is
 * active, or tokens b and c both are. CSS reads the tokens too ([data-active-state~="low-hp"]).
 * Elements are touched only when the token set changes.
 */
export function stateMatches(spec: string, tokens: ReadonlySet<string>): boolean {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .some((alt) => alt.split('+').every((t) => tokens.has(t)));
}

interface StateItem {
  /** HTML or SVG (the reticle's markers): shown and hidden through the hidden attribute */
  el: Element;
  spec: string;
  shown: boolean | null;
}

export class StateTokens {
  private readonly items: StateItem[] = [];
  private last: string | null = null;

  constructor(private readonly root: HTMLElement) {
    for (const el of root.querySelectorAll('[data-state]')) this.items.push({ el, spec: el.getAttribute('data-state')!, shown: null });
  }

  /** The active tokens (any order); a no-op when they're the same as last time. */
  set(tokens: readonly string[]): void {
    const sorted = [...new Set(tokens)].sort();
    const key = sorted.join(' ');
    if (key === this.last) return;
    this.last = key;
    this.root.dataset.activeState = key || 'default';
    const set = new Set(sorted);
    for (const item of this.items) {
      const shown = stateMatches(item.spec, set);
      if (shown === item.shown) continue;
      item.shown = shown;
      item.el.toggleAttribute('hidden', !shown);
    }
  }

  /** the tokens now, space-separated (tests) */
  get active(): string {
    return this.last ?? '';
  }
}
