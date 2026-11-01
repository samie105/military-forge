/** The motion system's script half (ui/motion.ts, docs/design/ui-motion-spec.md): its pure parts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flipTransform, floodRadius, reduced, rollPlan, rollText, stagger, staggerIndex } from '../src/ui/motion';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Just enough of the DOM for rollText: elements with children, and animations that never send their
 * finish events (a busy or hidden page, where those come late or not at all).
 */
class FakeAnimation {
  onfinish: (() => void) | null = null;
  oncancel: (() => void) | null = null;
  done = false;
  finish(): void {
    this.done = true;
  }
}
class FakeEl {
  parent: FakeEl | null = null;
  kids: FakeEl[] = [];
  text = '';
  className = '';
  dataset: Record<string, string> = {};
  anims: FakeAnimation[] = [];
  classList = {
    add: (c: string) => (this.className = `${this.className} ${c}`.trim()),
    contains: (c: string) => this.className.split(' ').includes(c),
  };
  get children(): FakeEl[] {
    return this.kids;
  }
  get childElementCount(): number {
    return this.kids.length;
  }
  get firstElementChild(): FakeEl | null {
    return this.kids[0] ?? null;
  }
  get textContent(): string {
    return this.kids.length ? this.kids.map((k) => k.textContent).join('') : this.text;
  }
  set textContent(v: string) {
    for (const k of this.kids) k.parent = null;
    this.kids = [];
    this.text = v;
  }
  append(k: FakeEl): void {
    k.parent = this;
    this.kids.push(k);
  }
  remove(): void {
    if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  animate(): FakeAnimation {
    const a = new FakeAnimation();
    this.anims.push(a);
    return a;
  }
  getAnimations(): FakeAnimation[] {
    const own = this.anims.filter((a) => !a.done);
    return [...own, ...this.kids.flatMap((k) => k.getAnimations())];
  }
}
function fakeDocument(): void {
  vi.stubGlobal('document', { documentElement: { classList: { contains: () => false } }, createElement: () => new FakeEl() });
}

describe('motion helpers', () => {
  it('reduced(): the game\'s switch wins over the system preference both ways (the OS is only its default; audit 28 Oct)', () => {
    const doc = (on: boolean) => ({ documentElement: { classList: { contains: (c: string) => on && c === 'reduce-motion' } } }) as unknown as Document;
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(reduced(doc(true))).toBe(true);
    expect(reduced(doc(false))).toBe(false);
    // the system asks for less motion, but the player switched Reduce motion off in Settings
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion') }));
    expect(reduced(doc(false))).toBe(false);
    expect(reduced(doc(true))).toBe(true);
  });

  it('P3 stagger: the row index sets --i, capped at 10 so the last row lands within 300 ms', () => {
    expect([0, 3, 10, 25, -2, 2.7].map(staggerIndex)).toEqual([0, 3, 10, 10, 0, 2]);
    const set: [string, string][] = [];
    stagger({ style: { setProperty: (n, v) => set.push([n, v]) } }, 14);
    expect(set).toEqual([['--i', '10']]);
  });

  it('P2 shared element: the inverse transform puts the new box where the old one was', () => {
    expect(flipTransform({ left: 100, top: 50, width: 200, height: 100 }, { left: 300, top: 250, width: 400, height: 200 })).toBe('translate(-200px, -200px) scale(0.5, 0.5)');
    expect(flipTransform({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 0 })).toBe('translate(0px, 0px) scale(1, 1)');
  });

  it('P4 roll: only the digits that changed roll, matched from the right', () => {
    expect(rollPlan('30', '29')).toEqual([
      { char: '2', changed: true },
      { char: '9', changed: true },
    ]);
    expect(rollPlan('12', '13').map((p) => p.changed)).toEqual([false, true]);
    expect(rollPlan('9', '10').map((p) => p.changed)).toEqual([true, true]);
    expect(rollPlan('1:05', '1:04').map((p) => p.changed)).toEqual([false, false, false, true]);
  });

  it('P4 roll: quick changes on a page that never finishes its animations leave no stale glyphs (audit B-02)', () => {
    vi.useFakeTimers();
    fakeDocument();
    const el = new FakeEl();
    const show = (v: string) => rollText(el as unknown as HTMLElement, v);
    show('5:09');
    // a busy page: ten changes inside one frame, no finish event and no timer between them
    for (const v of ['5:08', '5:07', '5:06', '5:05', '5:04', '5:03', '5:02', '5:01', '5:00', '4:59']) show(v);
    // each cell holds its glyph and at most the one leaving, never a pile ("5:05765432")
    expect(el.children).toHaveLength(4);
    for (const cell of el.children) expect(cell.childElementCount).toBeLessThanOrEqual(2);
    expect(el.children.map((c) => c.children.at(-1)!.textContent).join('')).toBe('4:59');
    // the leaving glyphs go on a timer even when their finish events never come
    vi.advanceTimersByTime(200);
    expect(el.textContent).toBe('4:59');
  });

  it('P6 flood: the circle reaches past the farthest corner', () => {
    expect(floodRadius(0, 0, 300, 400)).toBe(500);
    expect(floodRadius(150, 200, 300, 400)).toBe(250);
  });
});
