/** When play starts the shell lets go of the keyboard (shell/focus.ts): Space and the arrows are the game's. */
import { describe, expect, it } from 'vitest';
import { releaseShellFocus } from '../src/shell/focus';

function element(inShell: boolean) {
  const el = {
    blurred: false,
    closest: (sel: string) => (sel === '#shell' && inShell ? el : null),
    blur() {
      el.blurred = true;
    },
  };
  return el;
}

describe('releaseShellFocus', () => {
  it("blurs a focused control in the shell (Start now, Ready, the controls card's Got it)", () => {
    const button = element(true);
    expect(releaseShellFocus({ activeElement: button as unknown as Element })).toBe(true);
    expect(button.blurred).toBe(true);
  });

  it('leaves focus elsewhere alone (the page itself, the tuning panel), and copes with none', () => {
    const outside = element(false);
    expect(releaseShellFocus({ activeElement: outside as unknown as Element })).toBe(false);
    expect(outside.blurred).toBe(false);
    expect(releaseShellFocus({ activeElement: null })).toBe(false);
    expect(releaseShellFocus(undefined)).toBe(false);
  });
});
