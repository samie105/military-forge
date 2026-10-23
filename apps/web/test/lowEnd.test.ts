/** The low-end tier (ui/lowEnd.ts) and the menus' backdrop pacing (ui/backdrop.ts). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BackdropPacer, COVERED_DRAW_MS, FIRST_COVERED_DRAW_MS } from '../src/ui/backdrop';
import { FrameJudge, JUDGE_FRAMES, SLOW_FRAME_MS, lowEndByHints } from '../src/ui/lowEnd';

describe('the low-end tier', () => {
  it('reads the browser’s hints: few cores, little memory, both modest, or the data saver', () => {
    expect(lowEndByHints({})).toBe(false); // Safari tells nothing: the frames decide
    expect(lowEndByHints({ cores: 8, memory: 8 })).toBe(false);
    expect(lowEndByHints({ cores: 8, memory: 4 })).toBe(false); // a mid phone
    expect(lowEndByHints({ cores: 2, memory: 8 })).toBe(true);
    expect(lowEndByHints({ cores: 8, memory: 2 })).toBe(true);
    expect(lowEndByHints({ cores: 4, memory: 3 })).toBe(true);
    expect(lowEndByHints({ cores: 4, memory: 4 })).toBe(false);
    expect(lowEndByHints({ cores: 8, memory: 8, saveData: true })).toBe(true);
  });

  it('judges the frames by their median over a full window; a hidden tab’s gaps and a few spikes don’t count', () => {
    const fast = new FrameJudge();
    for (let i = 0; i < JUDGE_FRAMES; i++) expect(fast.push(i % 10 === 0 ? 80 : 16.7)).toBe(false);
    expect(fast.push(5000)).toBe(false);
    const slow = new FrameJudge();
    let verdict = false;
    for (let i = 0; i < JUDGE_FRAMES; i++) verdict = slow.push(SLOW_FRAME_MS + 9);
    expect(verdict).toBe(true);
    const short = new FrameJudge();
    for (let i = 0; i < JUDGE_FRAMES - 1; i++) short.push(40);
    expect(short.slow()).toBe(false); // not enough frames yet
  });

  it('drops blur and idle loops on low-end and Low graphics; frost and the title step aside too', () => {
    const css = readFileSync(new URL('../src/ui/lowend.css', import.meta.url), 'utf8');
    expect(css).toMatch(/html:is\(\.mf-lowend, \.gfx-low\) \*[\s\S]*backdrop-filter: none !important/);
    expect(css).toContain('--m-pull-blur: 0px');
    for (const f of ['../src/ui/frost.css', '../src/shell/screens/title.css']) {
      const glass = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(glass.match(/html:not\(\.reduce-transparency\):not\(\.gfx-low\)(?!:not\(\.mf-lowend\))/g), f).toBeNull();
    }
  });
});

describe('the menus’ backdrop pacing', () => {
  it('draws every frame while nothing covers it', () => {
    const p = new BackdropPacer(() => false);
    let drawn = 0;
    for (let t = 0; t < 1000; t += 16) if (p.shouldDraw(t)) drawn++;
    expect(drawn).toBe(63);
  });

  it('draws once a second behind an opaque screen, and asks the page at most 4 times a second', () => {
    let asked = 0;
    const p = new BackdropPacer(() => (asked++, true));
    const at: number[] = [];
    for (let t = 0; t < 5000; t += 16) if (p.shouldDraw(t)) at.push(t);
    // the first draw waits for the page's first picture, then once a second
    expect(at[0]).toBeGreaterThanOrEqual(FIRST_COVERED_DRAW_MS);
    expect(at.length).toBe(Math.floor((5000 - at[0]!) / COVERED_DRAW_MS) + 1);
    expect(asked).toBeLessThanOrEqual(21);
  });

  it('goes back to every frame as soon as the cover goes', () => {
    let covered = true;
    const p = new BackdropPacer(() => covered);
    expect(p.shouldDraw(0)).toBe(false);
    expect(p.shouldDraw(100)).toBe(false);
    covered = false;
    expect(p.shouldDraw(300)).toBe(true);
    expect(p.shouldDraw(316)).toBe(true);
  });
});
