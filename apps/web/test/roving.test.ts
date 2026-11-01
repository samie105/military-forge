/** Option groups as one tab stop (ui/roving.ts; audit 1, D-10): which option takes Tab, where the arrows land. */
import { describe, expect, it } from 'vitest';
import { roveTo, tabStop } from '../src/ui/roving';

const opt = (checked = false, enabled = true, focused = false) => ({ checked, enabled, focused });

describe('option groups: one tab stop each', () => {
  it('Tab lands on the focused option, else the chosen one, else the first that can be chosen', () => {
    expect(tabStop([opt(), opt(true), opt()])).toBe(1);
    expect(tabStop([opt(), opt(true), opt(false, true, true)])).toBe(2);
    expect(tabStop([opt(false, false), opt(), opt()])).toBe(1);
    // a chosen option that can't be chosen now (the time limit's None with no kill limit)
    expect(tabStop([opt(true, false), opt(), opt()])).toBe(1);
    expect(tabStop([opt(false, false)])).toBe(-1);
  });

  it('the arrows move along the group and wrap, over the options that can be chosen; Home and End go to its ends', () => {
    const on = [true, false, true, true];
    expect(roveTo(on, 0, 'ArrowRight')).toBe(2);
    expect(roveTo(on, 0, 'ArrowDown')).toBe(2);
    expect(roveTo(on, 3, 'ArrowRight')).toBe(0);
    expect(roveTo(on, 0, 'ArrowLeft')).toBe(3);
    expect(roveTo(on, 2, 'ArrowUp')).toBe(0);
    expect(roveTo(on, 2, 'Home')).toBe(0);
    expect(roveTo([false, true, true, false], 1, 'End')).toBe(2);
    expect(roveTo(on, 0, 'Enter')).toBe(-1);
  });
});
