/**
 * The menus with a pad (gamepad/menus.ts) on a tiny fake page: a dialog that focuses its own frame,
 * the first focus (data-pad-first, never a way out), B / Options on a screen's own buttons, a select
 * stepped sideways, a letter box stepped up and down (UX audit 2, N-01 / N-02 / N-04 / N-05).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, focusFirst, moveFocus, pressMarked, stepFocusedFar } from '../../src/gamepad/menus';

/** A fake element: a tag, attributes, a box, children; enough of the DOM for menus.ts. */
class El {
  parentElement: El | null = null;
  children: El[] = [];
  classes = new Set<string>();
  clicks = 0;
  keys: string[] = [];
  disabled = false;
  /** a select's options and choice */
  options: unknown[] = [];
  selectedIndex = 0;
  constructor(
    public tagName: string,
    public attrs: Record<string, string> = {},
    public box = { left: 0, top: 0, width: 100, height: 40 },
  ) {}
  get classList() {
    const c = this.classes;
    return { add: (n: string) => c.add(n), remove: (n: string) => c.delete(n), contains: (n: string) => c.has(n) };
  }
  add(...kids: El[]): this {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  getAttribute(n: string) {
    return n in this.attrs ? this.attrs[n]! : null;
  }
  hasAttribute(n: string) {
    return n in this.attrs;
  }
  setAttribute(n: string, v: string) {
    this.attrs[n] = v;
  }
  /** the selectors menus.ts asks for: a list of tags and [attr] / [attr="v"] parts */
  matches(sel: string): boolean {
    return sel.split(',').some((part) => {
      const p = part.trim();
      const tag = /^[a-z]+/.exec(p)?.[0];
      if (tag && tag !== this.tagName) return false;
      for (const m of p.replace(/:not\([^)]*\)/g, '').matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)) {
        const v = this.getAttribute(m[1]!);
        if (v === null || (m[2] !== undefined && v !== m[2])) return false;
      }
      if (/:not\(\[tabindex="-1"\]\)/.test(p) && this.getAttribute('tabindex') === '-1') return false;
      if (p.includes('.btn--volt') && !this.classes.has('btn--volt')) return false;
      if (tag === 'input' && p.includes(':not([type="hidden"])') && this.getAttribute('type') === 'hidden') return false;
      if (tag === 'a' && !this.hasAttribute('href')) return false;
      return true;
    });
  }
  querySelectorAll(sel: string): El[] {
    return this.all().filter((e) => e.matches(sel));
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel: string): El | null {
    return this.matches(sel) ? this : (this.parentElement?.closest(sel) ?? null);
  }
  contains(o: El | null): boolean {
    for (let e = o; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  getBoundingClientRect() {
    const b = this.box;
    return { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height, width: b.width, height: b.height, x: b.left, y: b.top };
  }
  focus() {
    doc.activeElement = this;
  }
  click() {
    this.clicks++;
  }
  scrollIntoView() {}
  dispatchEvent(e: { type: string; key?: string; defaultPrevented?: boolean }) {
    if (e.type === 'keydown') this.keys.push(e.key!);
    return true;
  }
  get scrollHeight() {
    return 0;
  }
  get clientHeight() {
    return 0;
  }
}

const doc = {
  activeElement: null as El | null,
  body: new El('body'),
  querySelector: (sel: string) => (sel === '.mf-pad-focused' ? (page.all().find((e) => e.classes.has('mf-pad-focused')) ?? null) : null),
  elementFromPoint: () => null,
};
let page: El;

beforeEach(() => {
  page = new El('div');
  doc.activeElement = null;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block', opacity: '1', overflowY: 'visible', overflowX: 'visible' }));
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('KeyboardEvent', class {
    constructor(public type: string, o: { key: string }) {
      Object.assign(this, o);
    }
  });
  vi.stubGlobal('HTMLInputElement', class {});
  vi.stubGlobal('HTMLTextAreaElement', class {});
});
afterEach(() => vi.unstubAllGlobals());

const button = (text: string, attrs: Record<string, string> = {}, at = { left: 0, top: 0 }) => new El('button', { 'aria-label': text, ...attrs }, { ...at, width: 100, height: 40 });
const scopeOf = (...kids: El[]) => page.add(new El('section').add(...kids)).children.at(-1)!;

describe('the menus with a pad', () => {
  it('a dialog that focuses its own frame: the first D-pad press lands on its first control (N-02)', () => {
    const first = button('Graphics', { role: 'tab', 'aria-selected': 'true' }, { left: 0, top: 100 });
    const other = button('Done', {}, { left: 600, top: 700 });
    const frame = new El('section', { role: 'dialog', tabindex: '-1' }, { left: 0, top: 0, width: 1280, height: 800 }).add(first, other);
    page.add(frame);
    frame.focus();
    moveFocus(frame as unknown as Element, 'down');
    expect(doc.activeElement).toBe(first);
    // and ✕ / A on the frame presses nothing: it lands on the control instead
    frame.focus();
    activate(frame as unknown as Element);
    expect(doc.activeElement).toBe(first);
    expect(first.clicks + other.clicks).toBe(0);
  });

  it('the first focus: the screen’s own pick, else the selected tab; never a way out by place alone (N-04)', () => {
    const leave = button('Leave', { 'data-pad-leave': '' }, { left: 0, top: 0 });
    const copy = button('Copy link', {}, { left: 0, top: 200 });
    const ready = button('Ready', {}, { left: 500, top: 700 });
    const lobby = scopeOf(leave, copy, ready) as unknown as Element;
    expect(focusFirst(lobby)).toBe(copy);
    ready.attrs['data-pad-first'] = '';
    expect(focusFirst(lobby)).toBe(ready);
    // a skipped control is never the pad's (Home's current tab, the joining card's Cancel)
    const cancel = button('Cancel', { 'data-pad-skip': '', 'data-pad-back': '' });
    const joining = scopeOf(cancel) as unknown as Element;
    expect(focusFirst(joining)).toBeNull();
    // ○ / B presses the screen's own Back (the joining card's Cancel, the confirm's Stay)
    expect(pressMarked(joining, 'data-pad-back')).toBe(true);
    expect(cancel.clicks).toBe(1);
    expect(pressMarked(lobby, 'data-pad-back')).toBe(false);
  });

  it('a letter box: up and down are its letter, ✕ / A is Enter; left and right still move (N-05)', () => {
    const a = new El('input', { 'data-pad-cycle': '', 'aria-label': 'Letter 1' }, { left: 0, top: 0, width: 60, height: 80 });
    const b = new El('input', { 'data-pad-cycle': '', 'aria-label': 'Letter 2' }, { left: 70, top: 0, width: 60, height: 80 });
    const join = scopeOf(a, b) as unknown as Element;
    a.focus();
    moveFocus(join, 'down');
    moveFocus(join, 'up');
    activate(join);
    expect(a.keys).toEqual(['ArrowDown', 'ArrowUp', 'Enter']);
    moveFocus(join, 'right');
    expect(doc.activeElement).toBe(b);
  });

  it('a select steps sideways, and ten at a time with L1 / R1, through its own keys first (N-01)', () => {
    class FakeSelect extends El {}
    vi.stubGlobal('HTMLSelectElement', FakeSelect);
    const year = new FakeSelect('select', { id: 'age-year' });
    const below = button('Continue', {}, { left: 0, top: 100 });
    const card = scopeOf(year, below) as unknown as Element;
    year.focus();
    moveFocus(card, 'left');
    expect(stepFocusedFar(card, 1)).toBe(true);
    expect(year.keys).toEqual(['ArrowLeft', 'PageUp']);
    expect(doc.activeElement).toBe(year);
    moveFocus(card, 'down');
    expect(doc.activeElement).toBe(below);
    expect(stepFocusedFar(card, 1)).toBe(false);
  });
});
