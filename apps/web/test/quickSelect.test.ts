/** The weapon quick-select: tap swaps on release, hold opens the wheel, a pick becomes a slot or grenade cycles. */
import { HAMMER, K47, NO_WEAPON } from '@military-forge/content';
import { Btn, createInput } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { wheelSpotOnPage } from '../src/hud/hud';
import { HOLD_MS, QuickSelect, cyclesTo, itemAt, itemAngle, itemSpot, pickByAngle, quickItems, type QuickPlayer } from '../src/quickSelect';

const me = (over: Partial<QuickPlayer> = {}): QuickPlayer => ({ alive: true, active: 0, dual: false, weapons: [{ def: HAMMER.index }, { def: K47.index }], grenadeType: 0, grenadeCounts: [2, 0, 1, 1, 0, 0], ...over });
const sample = (q: QuickSelect, now: number, buttons = 0) => {
  const out = createInput();
  out.buttons = buttons;
  q.tick(now);
  q.take(out);
  return out;
};

describe('the quick-select', () => {
  it('lists the gun in hand, the slung gun, then each grenade type carried', () => {
    expect(quickItems(me())).toEqual([
      { kind: 'gun', slot: 0, def: HAMMER.index },
      { kind: 'gun', slot: 1, def: K47.index },
      { kind: 'grenade', type: 0, count: 2 },
      { kind: 'grenade', type: 2, count: 1 },
      { kind: 'grenade', type: 3, count: 1 },
    ]);
    expect(quickItems(me({ active: 1, weapons: [{ def: HAMMER.index }, { def: NO_WEAPON }], grenadeCounts: [] }))).toEqual([{ kind: 'gun', slot: 0, def: HAMMER.index }]);
    expect(quickItems(null)).toEqual([]);
  });

  it('a tap swaps on its release, for one sample, and the swap key never reaches the sim held', () => {
    const q = new QuickSelect();
    q.observe(me());
    q.press('key', 0, { x: 400, y: 300 });
    expect(sample(q, 16, Btn.Swap).buttons & Btn.Swap).toBe(0);
    q.release(90);
    expect(sample(q, 100).buttons & Btn.Swap).toBe(Btn.Swap);
    expect(sample(q, 116).buttons & Btn.Swap).toBe(0);
    expect(q.open).toBe(false);
  });

  it('a hold opens the wheel on the slung gun: letting go takes it (weaponSelect), the fire button stays out while open', () => {
    const q = new QuickSelect();
    q.observe(me());
    q.press('key', 0, { x: 400, y: 300 });
    sample(q, HOLD_MS - 1);
    expect(q.open).toBe(false);
    expect(sample(q, HOLD_MS, Btn.Fire).buttons & Btn.Fire).toBe(0);
    expect(q.open).toBe(true);
    expect(q.view.highlight).toBe(1);
    q.release(HOLD_MS + 300);
    const out = sample(q, HOLD_MS + 316);
    expect(out.weaponSelect).toBe(2);
    expect(out.buttons & Btn.Swap).toBe(0);
    expect(sample(q, HOLD_MS + 332).weaponSelect).toBe(0);
  });

  it('pointing, the wheel and a click pick; a grenade type is reached with CycleGrenade presses, one every other sample', () => {
    const q = new QuickSelect();
    q.observe(me());
    q.press('key', 0, { x: 400, y: 300 });
    sample(q, HOLD_MS);
    const n = q.view.items.length;
    // point at the fifth item (smoke? no: the belt's third carried type, 3)
    const a = itemAngle(4, n);
    q.point(400 + Math.cos(a) * 100, 300 + Math.sin(a) * 100);
    expect(q.view.highlight).toBe(4);
    q.point(402, 301); // inside the dead zone: unchanged
    expect(q.view.highlight).toBe(4);
    expect(q.step(1)).toBe(true);
    expect(q.view.highlight).toBe(0);
    q.step(-1);
    expect(q.click()).toBe(true);
    const presses = [0, 1, 2, 3, 4, 5].map((i) => sample(q, 300 + i * 16, i === 0 ? Btn.Fire : 0).buttons);
    expect(presses.map((b) => (b & Btn.CycleGrenade ? 1 : 0))).toEqual([1, 0, 1, 0, 0, 0]);
    // the click didn't fire
    expect(presses[0]! & Btn.Fire).toBe(0);
  });

  it('cycles to a grenade type the way the sim cycles (skipping the empty ones)', () => {
    expect(cyclesTo(3, 0, [2, 0, 1, 1, 0, 0])).toBe(2);
    expect(cyclesTo(0, 3, [2, 0, 1, 1, 0, 0])).toBe(1);
    expect(cyclesTo(1, 0, [2, 0, 1, 1, 0, 0])).toBe(0);
    expect(cyclesTo(0, 0, [2, 0, 1, 1, 0, 0])).toBe(0);
  });

  it('the slices round the wheel: clockwise from the top, each item at the middle of its own', () => {
    for (const n of [2, 5, 8]) for (let i = 0; i < n; i++) expect(itemAt(itemAngle(i, n), n)).toBe(i);
    expect(itemAt(-Math.PI / 2, 4)).toBe(0);
    expect(itemAt(0, 4)).toBe(1);
  });

  it('never opens dead, dual-wielding, or with one thing to choose; a pad stick points past half-way', () => {
    const q = new QuickSelect();
    q.observe(me({ dual: true }));
    q.press('pad', 0, { x: 0, y: 0 });
    sample(q, HOLD_MS + 10);
    expect(q.open).toBe(false);
    q.release(HOLD_MS + 20);
    q.observe(me());
    q.press('pad', 1000, { x: 0, y: 0 });
    sample(q, 1000 + HOLD_MS);
    expect(q.open).toBe(true);
    q.stick(0.2, 0);
    expect(q.view.highlight).toBe(1);
    q.stick(0, -1); // up
    expect(q.view.highlight).toBe(0);
    q.observe({ ...me(), alive: false });
    expect(q.open).toBe(false);
  });
});

describe('the quick-select lands where it is drawn (owner, 25 Oct: "isn\'t mapped properly")', () => {
  // hud.ts draws item i at itemSpot(i, n) × the HUD's fit round the wheel's centre (the reticle kept on screen)
  const opened = (n: number) => {
    const q = new QuickSelect();
    const grenadeCounts = [1, 1, 1, 1, 1, 1].map((c, i) => (i < n - 2 ? c : 0));
    q.observe(me({ grenadeCounts, grenadeType: 5 })); // a type not carried: taking any grenade cycles
    q.press('key', 0, { x: 30, y: 20 }); // near the corner: the HUD draws it pulled on screen
    sample(q, HOLD_MS);
    expect(q.view.items.length).toBe(n);
    return q;
  };

  for (const fit of [0.667, 0.75, 1, 1.5]) {
    for (const n of [3, 5, 8]) {
      it(`pointing at each drawn item takes that item (fit ${fit}, ${n} items, the wheel moved on screen)`, () => {
        const q = opened(n);
        // where the HUD drew it: not where it opened (it keeps the wheel on screen)
        const centre = { x: 340 * fit, y: 270 * fit };
        const spots = q.view.items.map((_, i) => wheelSpotOnPage(centre.x, centre.y, i, n, fit));
        q.layout(centre, spots);
        spots.forEach((s, i) => {
          q.point(s.x, s.y);
          expect(q.view.highlight).toBe(i);
          // and on the way there: 40 % of the way out, past the dead zone
          q.point(centre.x + (s.x - centre.x) * 0.4, centre.y + (s.y - centre.y) * 0.4);
          expect(q.view.highlight).toBe(i);
        });
        // letting go on the first grenade takes it (frags: one cycle from the type selected, not carried)
        q.point(spots[2]!.x, spots[2]!.y);
        q.release(HOLD_MS + 500);
        const outs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((k) => sample(q, 1000 + k * 16));
        expect(outs.some((o) => o.buttons & Btn.CycleGrenade)).toBe(true);
      });
    }
  }

  it("the pad's stick toward each drawn item takes that item", () => {
    const q = opened(8);
    const centre = { x: 960, y: 540 };
    const spots = q.view.items.map((_, i) => wheelSpotOnPage(centre.x, centre.y, i, 8, 1));
    q.layout(centre, spots);
    spots.forEach((s, i) => {
      const dx = s.x - centre.x;
      const dy = s.y - centre.y;
      const len = Math.hypot(dx, dy);
      q.stick(dx / len, dy / len);
      expect(q.view.highlight).toBe(i);
    });
  });

  it('the drawn directions, not equal slices: the ellipse moves the diagonal items off their slot angles', () => {
    // with 8 items on a 250 × 180 ellipse, item 1 is drawn at about −35.8°, not −45°
    const s = itemSpot(1, 8);
    expect((Math.atan2(s.y, s.x) * 180) / Math.PI).toBeCloseTo(-35.8, 0);
    expect(pickByAngle(Math.atan2(s.y, s.x), [0, 1, 2, 3, 4, 5, 6, 7].map((i) => Math.atan2(itemSpot(i, 8).y, itemSpot(i, 8).x)))).toBe(1);
  });
});
