import { afterEach, describe, expect, it } from 'vitest';
import { drawButtonCap } from '../../src/gamepad/caps';
import { noteKeys, notePad, setGlyphSetting } from '../../src/gamepad/device';
import { sanitizePadSettings } from '../../src/gamepad/settings';
import { Binder } from '../../src/hud/bind';

/** Minimal DOM cap with real text/markup replacement semantics. */
function cap() {
  let markup = '';
  const attrs = new Map([['data-bind', 'bind.interact.0']]);
  const dataset: Record<string, string> = {};
  const classes = new Set<string>();
  return {
    dataset,
    classList: { toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) },
    get innerHTML() { return markup; },
    set innerHTML(value: string) { markup = value; },
    set textContent(value: string) { markup = value; },
    getAttribute: (key: string) => attrs.get(key) ?? null,
    setAttribute: (key: string, value: string) => attrs.set(key, value),
    removeAttribute: (key: string) => attrs.delete(key),
    hasAttribute: (key: string) => key === 'data-pad-code' ? !!dataset.padCode : attrs.has(key),
    matches: (selector: string) => selector === '[data-bind]',
    querySelectorAll: () => [],
  } as unknown as HTMLElement;
}

afterEach(() => { setGlyphSetting('auto'); noteKeys(); });

describe('controller caps in the live HUD', () => {
  it('the HUD binder preserves a triangle drawing across frames, then restores keyboard text', () => {
    const el = cap();
    const binder = new Binder(el);
    notePad('playstation', true);
    drawButtonCap(el, 'Pad3', '△');
    const triangle = el.innerHTML;
    expect(triangle).toContain('<svg');
    expect(el.getAttribute('aria-label')).toBe('Triangle button');
    binder.update({ 'bind.interact.0': '△' });
    expect(el.innerHTML).toBe(triangle);
    drawButtonCap(el, 'KeyE', 'E');
    binder.update({ 'bind.interact.0': 'E' });
    expect(el.innerHTML).toBe('E');
    expect(el.hasAttribute('data-pad-code')).toBe(false);
  });

  it('same physical button changes from triangle to Xbox Y and Nintendo X', () => {
    const el = cap();
    notePad('xbox');
    drawButtonCap(el, 'Pad3', '');
    expect(el.getAttribute('aria-label')).toBe('Y button');
    expect(el.innerHTML).toContain('>Y</text>');
    notePad('nintendo');
    drawButtonCap(el, 'Pad3', '');
    expect(el.getAttribute('aria-label')).toBe('X button');
  });

  it('old saves get the layout; Nintendo overrides and hiding the layout survive loading', () => {
    expect(sanitizePadSettings({}).showLayout).toBe(true);
    const settings = sanitizePadSettings({ glyphs: 'nintendo', showLayout: false });
    expect(settings.glyphs).toBe('nintendo');
    expect(settings.showLayout).toBe(false);
  });
});
