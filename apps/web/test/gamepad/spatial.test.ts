/** Spatial navigation (gamepad/spatial.ts): the D-pad moves focus to the right neighbour. */
import { describe, expect, it } from 'vitest';
import { navScore, nextTab, pickFirst, pickNext, type Rect } from '../../src/gamepad/spatial';

const box = (left: number, top: number, w = 100, h = 40): Rect => ({ left, top, right: left + w, bottom: top + h });

describe('spatial navigation', () => {
  // a 3 × 2 grid of buttons, 20 px apart
  const grid = [box(0, 0), box(120, 0), box(240, 0), box(0, 60), box(120, 60), box(240, 60)];

  it('walks a grid one neighbour at a time', () => {
    expect(pickNext(grid[0]!, grid, 'right')).toBe(1);
    expect(pickNext(grid[1]!, grid, 'right')).toBe(2);
    expect(pickNext(grid[1]!, grid, 'down')).toBe(4);
    expect(pickNext(grid[4]!, grid, 'left')).toBe(3);
    expect(pickNext(grid[5]!, grid, 'up')).toBe(2);
  });

  it('stops at the edge (no wrapping, nothing that way)', () => {
    expect(pickNext(grid[2]!, grid, 'right')).toBe(-1);
    expect(pickNext(grid[0]!, grid, 'up')).toBe(-1);
  });

  it('prefers the control lined up with it over a nearer diagonal one', () => {
    const from = box(0, 0, 100, 40);
    const diagonalNear = box(110, 60, 100, 40); // just right, but a row below
    const inLine = box(300, 0, 100, 40); // further, on the same row
    expect(pickNext(from, [diagonalNear, inLine], 'right')).toBe(1);
  });

  it('from a vertical tab strip, right lands beside it in the panel, not far below', () => {
    const tab = box(0, 100, 200, 48);
    const panelTop = box(260, 0, 400, 48);
    const panelBeside = box(260, 110, 400, 48);
    const panelLow = box(260, 600, 400, 48);
    expect(pickNext(tab, [panelTop, panelBeside, panelLow], 'right')).toBe(1);
  });

  it('down a column of settings rows of different widths keeps to the column', () => {
    const rows = [box(0, 0, 600, 40), box(400, 60, 200, 40), box(0, 120, 600, 40)];
    expect(pickNext(rows[0]!, rows, 'down')).toBe(1);
    expect(pickNext(rows[1]!, rows, 'down')).toBe(2);
    expect(pickNext(rows[2]!, rows, 'up')).toBe(1);
  });

  it('a wide box above that reaches past the focus is not "to the right" of it', () => {
    const button = box(0, 100, 100, 40);
    const wideField = box(0, 0, 600, 40);
    expect(pickNext(button, [wideField], 'right')).toBe(-1);
    expect(pickNext(button, [wideField], 'up')).toBe(0);
  });

  it('something that contains the focus or sits behind it is not "that way"', () => {
    expect(navScore(box(100, 100), box(50, 50, 300, 300), 'right')).toBeNull();
    expect(navScore(box(100, 100), box(100, 100), 'down')).toBeNull();
  });

  it('the first focus: the one that asks, else the top-left one', () => {
    expect(pickFirst(grid)).toBe(0);
    expect(pickFirst([box(200, 0), box(0, 200), box(0, 2)])).toBe(2);
    expect(pickFirst(grid, 4)).toBe(4);
    expect(pickFirst([])).toBe(-1);
  });

  it('L1 / R1 step through a tab strip and wrap round', () => {
    expect(nextTab(5, 0, 1)).toBe(1);
    expect(nextTab(5, 4, 1)).toBe(0);
    expect(nextTab(5, 0, -1)).toBe(4);
    expect(nextTab(5, -1, 1)).toBe(0);
    expect(nextTab(0, 0, 1)).toBe(-1);
  });
});
