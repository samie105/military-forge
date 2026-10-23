import { describe, expect, it } from 'vitest';
import { box, dimPath, holeCommands, holeFor, holesMoved, inflate, placeCallout, unionBox } from '../src/ui/spotlight';
import { hudTemplate } from '../src/hud/template';

const commands = (path: string) => path.replace(/[^A-Za-z]/g, '');

describe('the spotlight: holes', () => {
  it('a rect keeps its radius (capped); a pill is round-ended; a circle is a square with r = w/2', () => {
    const b = box(10, 20, 100, 40);
    expect(holeFor(b, 'rect', 6)).toMatchObject({ left: 10, top: 20, width: 100, height: 40, r: 6 });
    expect(holeFor(b, 'rect', 99).r).toBe(20);
    expect(holeFor(b, 'pill').r).toBe(20);
    const c = holeFor(b, 'circle');
    expect(c).toMatchObject({ width: 100, height: 100, r: 50, left: 10, top: -10 });
  });

  it('auto: a near-square with a radius of half its side is a circle, anything else a rounded rect', () => {
    expect(holeFor(box(0, 0, 80, 80), 'auto', 40).r).toBe(40);
    expect(holeFor(box(0, 0, 80, 80), 'auto', 6).r).toBe(6);
    expect(holeFor(box(0, 0, 200, 60), 'auto', 30).width).toBe(200);
  });

  it('every hole is the same command list, so the clip path interpolates between steps', () => {
    const rect = holeCommands(holeFor(box(0, 0, 200, 60), 'rect', 8));
    const circle = holeCommands(holeFor(box(0, 0, 60, 60), 'circle'));
    expect(commands(rect)).toBe('MHAVAHAVAZ');
    expect(commands(circle)).toBe(commands(rect));
    expect(commands(holeCommands(holeFor(box(0, 0, 10, 10), 'rect', 0)))).toBe('MHAVAHAVAZ');
  });

  it('the dim is the view minus each hole, even-odd', () => {
    const p = dimPath(1280, 720, [holeFor(box(100, 100, 50, 20), 'rect', 4), holeFor(box(400, 300, 40, 40), 'circle')]);
    expect(p.startsWith('path(evenodd, "M0 0H1280V720H0Z')).toBe(true);
    expect(p.match(/M/g)).toHaveLength(3);
  });

  it('rewrites the path only when a hole moved more than 2 px', () => {
    const a = [holeFor(box(100, 100, 50, 20), 'rect', 4)];
    expect(holesMoved(a, [holeFor(box(101.5, 100, 50, 20), 'rect', 4)])).toBe(false);
    expect(holesMoved(a, [holeFor(box(103, 100, 50, 20), 'rect', 4)])).toBe(true);
    expect(holesMoved(a, [])).toBe(true);
    expect(inflate(box(10, 10, 20, 20), 6)).toMatchObject({ left: 4, top: 4, width: 32, height: 32 });
    expect(unionBox([box(0, 0, 10, 10), box(20, 30, 5, 5)])).toMatchObject({ left: 0, top: 0, right: 25, bottom: 35 });
  });
});

describe('the spotlight: placing the callout', () => {
  const safe = box(12, 12, 1256, 696);
  const size = { width: 400, height: 140 };

  it('goes below the target, else above, else beside; shifted to stay inside the safe box', () => {
    expect(placeCallout(box(100, 100, 200, 60), size, safe, 'auto')).toEqual({ left: 12, top: 176, side: 'below' });
    expect(placeCallout(box(600, 600, 200, 60), size, safe, 'auto').side).toBe('above');
    expect(placeCallout(box(600, 600, 200, 60), size, safe, 'below').side).toBe('above'); // flipped
    expect(placeCallout(box(100, 20, 120, 680), size, safe, 'auto').side).toBe('right');
    expect(placeCallout(box(1100, 20, 160, 680), size, safe, 'auto').side).toBe('left');
    const shifted = placeCallout(box(1200, 100, 60, 60), size, safe, 'below');
    expect(shifted.left + size.width).toBeLessThanOrEqual(safe.right);
  });

  it('on a phone it sits top-centre, never over a thumb dial', () => {
    const phone = box(12, 12, 788, 351);
    expect(placeCallout(box(30, 220, 130, 130), { width: 320, height: 90 }, phone, 'top-centre')).toEqual({ left: 246, top: 12, side: 'top-centre' });
  });
});

describe('the HUD carries the tour hooks', () => {
  it('fuel, dash, belt, ammo, clock and scores', () => {
    const html = hudTemplate();
    for (const id of ['fuel', 'dash', 'belt', 'ammo', 'clock', 'scores']) expect(html).toContain(`data-tour="${id}"`);
  });
});
