/** Dialogs keep the keyboard inside (ui/focusTrap.ts). */
import { describe, expect, it } from 'vitest';
import { wrapFocus } from '../src/ui/focusTrap';

describe('focus inside a dialog', () => {
  const list = ['close', 'tab-a', 'tab-b', 'save'];
  it('wraps Tab from the last control to the first, and Shift+Tab from the first to the last', () => {
    expect(wrapFocus(list, 'save', false)).toBe('close');
    expect(wrapFocus(list, 'close', true)).toBe('save');
  });
  it('lets the browser move between the controls in between', () => {
    expect(wrapFocus(list, 'tab-a', false)).toBeNull();
    expect(wrapFocus(list, 'tab-b', true)).toBeNull();
  });
  it('brings focus in from outside (the first control, or the last going back); nothing to focus: no help', () => {
    expect(wrapFocus(list, null, false)).toBe('close');
    expect(wrapFocus(list, null, true)).toBe('save');
    expect(wrapFocus([], null, false)).toBeNull();
  });
});
