/**
 * Binds the HUD's markup to its values by attribute, so the look (template.ts, the kit's CSS) can
 * change without touching the logic (hud.ts, model.ts):
 *
 *   data-bind="key"                   the element's text
 *   data-bind-attr="name: key; …"     attributes (an icon's <use href>, a class list, a title)
 *   data-bind-var="--name: key; …"    CSS custom properties: a bar's --hp: 0.72
 *   data-bind-state="key"             its data-state (words for CSS)
 *   data-bind-show="key"              hidden while the value is ''
 *
 * Every write is cached: an element is touched only when its value changes, so a frame costs a few
 * dozen string compares.
 */
export type HudValues = Readonly<Record<string, string>>;

interface Binding {
  key: string;
  last: string | null;
  write(value: string): void;
}

function pairs(spec: string): [name: string, key: string][] {
  return spec
    .split(';')
    .map((pair) => {
      const i = pair.indexOf(':');
      return i < 0 ? null : ([pair.slice(0, i).trim(), pair.slice(i + 1).trim()] as [string, string]);
    })
    .filter((p): p is [string, string] => p !== null && p[0] !== '' && p[1] !== '');
}

export class Binder {
  private readonly bindings: Binding[] = [];

  constructor(root: Element) {
    const all = (attr: string) => [...(root.matches(`[${attr}]`) ? [root] : []), ...root.querySelectorAll(`[${attr}]`)];
    const add = (key: string, write: (v: string) => void) => this.bindings.push({ key: key.trim(), last: null, write });
    for (const el of all('data-bind')) add(el.getAttribute('data-bind')!, (v) => (el.textContent = v));
    for (const el of all('data-bind-state')) add(el.getAttribute('data-bind-state')!, (v) => el.setAttribute('data-state', v));
    for (const el of all('data-bind-show')) add(el.getAttribute('data-bind-show')!, (v) => el.toggleAttribute('hidden', v === ''));
    for (const el of all('data-bind-attr')) for (const [name, key] of pairs(el.getAttribute('data-bind-attr')!)) add(key, (v) => el.setAttribute(name, v));
    for (const el of all('data-bind-var')) for (const [name, key] of pairs(el.getAttribute('data-bind-var')!)) add(key, (v) => (el as HTMLElement).style.setProperty(name, v));
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
