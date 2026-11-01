/** Home's nameplate sizes a name by how wide it runs, not its letter count (UX audit 31 Oct, C-03). */
import { describe, expect, it } from 'vitest';
import { nameplateChars } from '../src/shell/screens/Home';

describe("Home's nameplate", () => {
  it('a name of wide letters counts wider than its length, a narrow one less; short names keep a floor', () => {
    expect(nameplateChars('WWWWWWWWWWWWWWWW')).toBeCloseTo(22.4);
    expect(nameplateChars('mmmm')).toBeCloseTo(5.6);
    expect(nameplateChars('Ada')).toBe(4);
    expect(nameplateChars('SteadyRaven384')).toBe(14);
    expect(nameplateChars('Ii11')).toBe(4);
    expect(nameplateChars('WMWMWWMWGWGWNWDQ')).toBeGreaterThan(16);
  });
});
