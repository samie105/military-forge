/** The weapon quick-select: tap swaps on release, hold opens the wheel, a pick becomes a slot or grenade cycles. */
import { HAMMER, K47, NO_WEAPON } from '@military-forge/content';
import { Btn, createInput } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { HOLD_MS, QuickSelect, cyclesTo, itemAt, itemAngle, quickItems, type QuickPlayer } from '../src/quickSelect';

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
