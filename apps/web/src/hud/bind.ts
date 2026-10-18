/**
 * Binds the HUD's markup to its values by attribute, so the look (template.ts + hud.css) can be
 * swapped without touching the logic (hud.ts, model.ts):
 *
 *   data-bind="key"              the element's text
 *   data-bind-state="key"        its data-state: space-separated words, for CSS ([data-state~="low"])
 *   data-bind-var="--name: key"  a CSS custom property, e.g. a bar's --fill: 0.72 (several: "a; b")
 *   data-bind-show="key"         hidden while the value is ''
 *
 * Keys follow the UI brief's data names (player.hp, player.shield.state, weapons.0.mag…). Every
 * write is cached: an element is touched only when its value changes, so a frame costs a few dozen
 * string compares.
 */
export type HudValues = Readonly<Record<string, string>>;

interface Binding {
  key: string;
  last: string | null;
  write(value: string): void;
}

export class Binder {
  private readonly bindings: Binding[] = [];

  constructor(root: HTMLElement) {
    const all = (attr: string) => [...(root.matches(`[${attr}]`) ? [root] : []), ...root.querySelectorAll<HTMLElement>(`[${attr}]`)];
    const add = (key: string, write: (v: string) => void) => this.bindings.push({ key: key.trim(), last: null, write });
    for (const el of all('data-bind')) add(el.dataset.bind!, (v) => (el.textContent = v));
    for (const el of all('data-bind-state')) add(el.dataset.bindState!, (v) => (el.dataset.state = v));
    for (const el of all('data-bind-show')) add(el.dataset.bindShow!, (v) => (el.hidden = v === ''));
    for (const el of all('data-bind-var')) {
      for (const pair of el.dataset.bindVar!.split(';')) {
        const i = pair.indexOf(':');
        if (i < 0) continue;
        const name = pair.slice(0, i).trim();
        add(pair.slice(i + 1), (v) => el.style.setProperty(name, v));
      }
    }
  }

  /** every key the markup binds (tests check each one gets a value) */
  get keys(): string[] {
    return [...new Set(this.bindings.map((b) => b.key))];
  }

  update(values: HudValues): void {
    for (const b of this.bindings) {
      const v = values[b.key];
      if (v === undefined || v === b.last) continue;
      b.last = v;
      b.write(v);
    }
  }
}
