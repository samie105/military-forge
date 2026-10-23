/**
 * A tap on a menu button while another finger is down (QA 23 Oct, qa-bullets-lag-touch.md §3 H): the
 * browser makes no click, so ui/multiTouchTap.ts makes it. Two pointers here: a thumb on the move
 * dial (the game, not a button) and a finger on Resume.
 */
import { describe, expect, it, vi } from 'vitest';
import { CLICKABLE, ECHO_MS, OWN_POINTER, TAP_MAX_MS, TAP_SLOP_PX, startMultiTouchTaps, type TapElement } from '../src/ui/multiTouchTap';

/** A stand-in element: a button (or not), its parent, its own clicks. */
class El implements TapElement {
  clicks = 0;
  disabled = false;
  attrs = new Set<string>();
  constructor(
    readonly kind: 'button' | 'control' | 'plain',
    readonly parent: El | null = null,
    private readonly onClick: (el: El) => void = () => {},
  ) {}
  closest(selector: string): El | null {
    if (selector === CLICKABLE && this.kind === 'button') return this;
    if (selector === OWN_POINTER && this.kind === 'control') return this;
    if (selector !== CLICKABLE && selector !== OWN_POINTER && selector.includes('aria-disabled') && this.attrs.has('aria-disabled')) return this;
    return this.parent?.closest(selector) ?? null;
  }
  contains(other: unknown): boolean {
    for (let n = other as El | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  click(): void {
    this.clicks++;
    this.onClick(this);
  }
}

function setup() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  let now = 1000;
  let under: unknown = null;
  const target = {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
  };
  const fire = (type: string, e: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) fn(e);
  };
  // a click event as the page sees it (ours from el.click(), or the browser's)
  const click = (el: El) => {
    const e = { target: el, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    fire('click', e);
    return e;
  };
  const resume = new El('button', null, (el) => click(el));
  const icon = new El('plain', resume); // the svg inside the button: where the finger lands
  const game = new El('plain'); // the canvas: the move dial's thumb
  const ptr = (id: number, el: unknown, x = 100, y = 100, type = 'touch') => ({ pointerId: id, pointerType: type, clientX: x, clientY: y, target: el });
  const stop = startMultiTouchTaps({ target, elementAt: () => under, now: () => now });
  return {
    resume,
    icon,
    game,
    fire,
    click,
    ptr,
    stop,
    listeners,
    at: (el: unknown) => (under = el),
    wait: (ms: number) => (now += ms),
  };
}

describe('a tap while another finger is down', () => {
  it('a thumb on the move dial, then a tap on Resume: Resume gets its click (the browser sends none)', () => {
    const t = setup();
    t.fire('pointerdown', t.ptr(1, t.game, 60, 300)); // the thumb, resting on the dial
    t.at(t.icon);
    t.fire('pointerdown', t.ptr(2, t.icon));
    t.wait(90);
    t.fire('pointerup', t.ptr(2, t.icon, 103, 98));
    expect(t.resume.clicks).toBe(1);
    // again, the thumb still down: every tap counts
    t.fire('pointerdown', t.ptr(3, t.icon));
    t.wait(80);
    t.fire('pointerup', t.ptr(3, t.icon));
    expect(t.resume.clicks).toBe(2);
  });

  it('one press, one action: the browser\'s own click after ours is swallowed (no double fire)', () => {
    const t = setup();
    t.fire('pointerdown', t.ptr(1, t.game));
    t.at(t.icon);
    t.fire('pointerdown', t.ptr(2, t.icon));
    t.fire('pointerup', t.ptr(1, t.game)); // the thumb lifts first: this browser does click after all
    t.fire('pointerup', t.ptr(2, t.icon));
    expect(t.resume.clicks).toBe(1);
    t.wait(30);
    const echo = t.click(t.resume);
    expect(echo.stopImmediatePropagation).toHaveBeenCalled();
    expect(echo.preventDefault).toHaveBeenCalled();
    // a later click is a new press: it goes through
    t.wait(ECHO_MS + 1);
    expect(t.click(t.resume).stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('a second finger landing during a one-finger press turns it multi-touch too', () => {
    const t = setup();
    t.at(t.icon);
    t.fire('pointerdown', t.ptr(1, t.icon));
    t.fire('pointerdown', t.ptr(2, t.game, 60, 300));
    t.fire('pointerup', t.ptr(1, t.icon));
    expect(t.resume.clicks).toBe(1);
  });

  it('a one-finger tap, a mouse and a keyboard are left to the browser', () => {
    const t = setup();
    t.at(t.icon);
    t.fire('pointerdown', t.ptr(1, t.icon));
    t.fire('pointerup', t.ptr(1, t.icon));
    t.fire('pointerdown', t.ptr(5, t.game, 0, 0, 'mouse'));
    t.fire('pointerdown', t.ptr(6, t.icon, 100, 100, 'mouse'));
    t.fire('pointerup', t.ptr(6, t.icon, 100, 100, 'mouse'));
    expect(t.resume.clicks).toBe(0);
    // the browser's click for the one-finger tap goes through untouched
    expect(t.click(t.resume).stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('not a tap: dragged off, held too long, ended elsewhere, cancelled, or disabled', () => {
    const t = setup();
    t.fire('pointerdown', t.ptr(1, t.game));
    t.at(t.icon);
    t.fire('pointerdown', t.ptr(2, t.icon));
    t.fire('pointerup', t.ptr(2, t.icon, 100 + TAP_SLOP_PX + 1, 100));
    t.fire('pointerdown', t.ptr(3, t.icon));
    t.wait(TAP_MAX_MS + 1);
    t.fire('pointerup', t.ptr(3, t.icon));
    t.fire('pointerdown', t.ptr(4, t.icon));
    t.at(t.game); // slid off the button (a touch's pointerup still targets where it began)
    t.fire('pointerup', t.ptr(4, t.icon));
    t.at(t.icon);
    t.fire('pointerdown', t.ptr(7, t.icon));
    t.fire('pointercancel', t.ptr(7, t.icon));
    t.fire('pointerup', t.ptr(7, t.icon));
    t.resume.disabled = true;
    t.fire('pointerdown', t.ptr(8, t.icon));
    t.fire('pointerup', t.ptr(8, t.icon));
    expect(t.resume.clicks).toBe(0);
  });

  it('the touch controls act on their own pointer events: never clicked here', () => {
    const t = setup();
    const fire = new El('control');
    t.fire('pointerdown', t.ptr(1, t.game));
    t.at(fire);
    t.fire('pointerdown', t.ptr(2, fire));
    t.fire('pointerup', t.ptr(2, fire));
    expect(fire.clicks).toBe(0);
  });

  it('a page that lost focus mid-press forgets the fingers; stop() removes every listener', () => {
    const t = setup();
    t.fire('pointerdown', t.ptr(1, t.game));
    t.fire('blur', {});
    t.at(t.icon);
    t.fire('pointerdown', t.ptr(2, t.icon));
    t.fire('pointerup', t.ptr(2, t.icon));
    expect(t.resume.clicks).toBe(0); // one finger now: the browser's click
    t.stop();
    expect([...t.listeners.values()].every((l) => l.length === 0)).toBe(true);
  });
});
