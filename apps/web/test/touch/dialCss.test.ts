/** The dials' CSS on an iPhone: the arcs stay on the dial inside the skin's zoom; the aim tag goes once learned. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/touch/touch.css', import.meta.url), 'utf8');

describe('the dials on iPhone Safari', () => {
  it("turns the HP, fuel and throw arcs about their own centre (Safari zooms a px transform-origin, not the SVG's units)", () => {
    const rule = /\.mf-touch \.dial__arcs :is\(([^)]*)\)\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    for (const arc of ['.dial__track', '.dial__hp', '.dial__fuel', '.dial__throw']) expect(rule![1]).toContain(arc);
    expect(rule![2]).toMatch(/transform-box:\s*fill-box/);
    expect(rule![2]).toMatch(/transform-origin:\s*center/);
  });

  it('fades the "Aim to shoot" tag once the stick has aimed', () => {
    expect(css).toMatch(/\.mf-ctl-aim\.mf-aimed \.dial__tag\s*\{[^}]*visibility:\s*hidden/);
  });

  it("puts each button's word on a plate of its own (a name tag behind can't read as it), once", () => {
    const caps = css.match(/\.mf-touch \.mf-cap \{[^}]*\}/g) ?? [];
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatch(/background:/);
  });
});
