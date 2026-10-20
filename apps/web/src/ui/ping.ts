/** Ping quality the kit's way: green up to 100 ms, amber to 200, red beyond; 4…1 signal bars. */
export function pingQuality(ms: number): { cls: 'ping--good' | 'ping--mid' | 'ping--bad'; bars: 1 | 2 | 3 | 4 } {
  if (ms <= 50) return { cls: 'ping--good', bars: 4 };
  if (ms <= 100) return { cls: 'ping--good', bars: 3 };
  if (ms <= 200) return { cls: 'ping--mid', bars: 2 };
  return { cls: 'ping--bad', bars: 1 };
}
