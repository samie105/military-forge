import { describe, expect, it } from 'vitest';
import {
  IdAllocator,
  Pool,
  Xoshiro128,
  angleToU16,
  approach,
  hash4,
  hashToUnit,
  quantize,
  simAtan2,
  simCos,
  simCosSin,
  simExp,
  simSin,
  u16ToAngle,
  utf8Decode,
  utf8Encode,
  wrapAngle,
} from '../src';

describe('Xoshiro128', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = new Xoshiro128(1234);
    const b = new Xoshiro128(1234);
    const c = new Xoshiro128(1235);
    const seqA = Array.from({ length: 16 }, () => a.nextU32());
    const seqB = Array.from({ length: 16 }, () => b.nextU32());
    const seqC = Array.from({ length: 16 }, () => c.nextU32());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('produces a fixed known sequence (guards against accidental algorithm changes)', () => {
    const r = new Xoshiro128(42);
    expect(Array.from({ length: 4 }, () => r.nextU32())).toMatchInlineSnapshot(`
      [
        2837322924,
        544945897,
        479756282,
        3500138142,
      ]
    `);
  });

  it('floats are in [0,1) and roughly uniform', () => {
    const r = new Xoshiro128(7);
    const buckets = new Array<number>(10).fill(0);
    let min = 1;
    let max = 0;
    // plain comparisons in the loop: 200k expect() calls took seconds under parallel load and hit the timeout
    for (let i = 0; i < 100_000; i++) {
      const f = r.nextFloat();
      if (f < min) min = f;
      if (f > max) max = f;
      buckets[Math.floor(f * 10)]!++;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
    for (const count of buckets) expect(Math.abs(count - 10_000)).toBeLessThan(500);
  });

  it('round-trips state', () => {
    const r = new Xoshiro128(99);
    r.nextU32();
    const state = r.getState();
    const expected = [r.nextU32(), r.nextU32()];
    r.setState(state);
    expect([r.nextU32(), r.nextU32()]).toEqual(expected);
  });
});

describe('hash4', () => {
  it('is stateless and sensitive to every input', () => {
    expect(hash4(1, 2, 3, 4)).toBe(hash4(1, 2, 3, 4));
    const base = hash4(1, 2, 3, 4);
    expect(hash4(0, 2, 3, 4)).not.toBe(base);
    expect(hash4(1, 0, 3, 4)).not.toBe(base);
    expect(hash4(1, 2, 0, 4)).not.toBe(base);
    expect(hash4(1, 2, 3, 0)).not.toBe(base);
    expect(hashToUnit(base)).toBeGreaterThanOrEqual(0);
    expect(hashToUnit(base)).toBeLessThan(1);
  });
});

describe('sim maths', () => {
  it('simSin/simCos match Math within 1e-9 over a wide range', () => {
    for (let x = -50; x <= 50; x += 0.0137) {
      expect(Math.abs(simSin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(simCos(x) - Math.cos(x))).toBeLessThan(1e-9);
    }
  });

  it('simCosSin agrees with simCos/simSin', () => {
    const out = { x: 0, y: 0 };
    for (let x = -10; x <= 10; x += 0.093) {
      simCosSin(x, out);
      expect(out.x).toBe(simCos(x));
      expect(out.y).toBe(simSin(x));
    }
  });

  it('simAtan2 matches Math.atan2 within 1e-9 in all quadrants', () => {
    for (let a = -Math.PI; a <= Math.PI; a += 0.0071) {
      for (const radius of [1e-3, 0.5, 1, 37]) {
        const y = Math.sin(a) * radius;
        const x = Math.cos(a) * radius;
        expect(Math.abs(simAtan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-9);
      }
    }
    expect(simAtan2(0, 0)).toBe(0);
    expect(simAtan2(0, -1)).toBeCloseTo(Math.PI, 12);
    expect(simAtan2(1, 0)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('simExp matches Math.exp to 1e-12 relative', () => {
    for (let x = -20; x <= 20; x += 0.031) {
      const rel = Math.abs(simExp(x) - Math.exp(x)) / Math.exp(x);
      expect(rel).toBeLessThan(1e-12);
    }
  });

  it('wrapAngle maps into (-π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('quantisation', () => {
  it('never produces -0', () => {
    expect(Object.is(quantize(-0.0001, 1024), 0)).toBe(true);
    expect(Object.is(quantize(-0, 1024), 0)).toBe(true);
  });

  it('is idempotent and exact', () => {
    for (let v = -100; v < 100; v += 0.0173) {
      const q = quantize(v, 1024);
      expect(quantize(q, 1024)).toBe(q);
      expect(Math.abs(q - v)).toBeLessThanOrEqual(0.5 / 1024 + 1e-12);
    }
  });

  it('angle u16 round-trips within one step', () => {
    for (let a = -Math.PI + 0.001; a < Math.PI; a += 0.01) {
      const back = u16ToAngle(angleToU16(a));
      expect(Math.abs(wrapAngle(back - a))).toBeLessThan((2 * Math.PI) / 65536);
    }
    expect(angleToU16(2 * Math.PI)).toBe(0);
  });
});

describe('helpers', () => {
  it('approach clamps at the target', () => {
    expect(approach(0, 5, 2)).toBe(2);
    expect(approach(4, 5, 2)).toBe(5);
    expect(approach(0, -5, 2)).toBe(-2);
  });

  it('pool reuses released objects', () => {
    let created = 0;
    const pool = new Pool(() => ({ v: ++created }), (o) => (o.v = 0));
    const a = pool.acquire();
    pool.release(a);
    expect(pool.acquire()).toBe(a);
    expect(created).toBe(1);
  });

  it('id allocator hands out lowest free ids', () => {
    const ids = new IdAllocator(4);
    expect([ids.allocate(), ids.allocate(), ids.allocate()]).toEqual([0, 1, 2]);
    ids.free(1);
    expect(ids.allocate()).toBe(1);
    expect(ids.allocate()).toBe(3);
    expect(ids.allocate()).toBe(-1);
  });

  it('utf8 decoding never throws on malformed bytes', () => {
    expect(utf8Decode(Uint8Array.from([0xf7, 0xbf, 0xbf, 0xbf]))).toBe('\ufffd');
    expect(utf8Decode(Uint8Array.from([0xed, 0xa0, 0x80]))).toBe('\ufffd');
  });

  it('utf8 round-trips non-ASCII names', () => {
    for (const s of ['Ade', 'Ọlá', 'राज', 'Kemi 🚀']) expect(utf8Decode(utf8Encode(s))).toBe(s);
  });
});
