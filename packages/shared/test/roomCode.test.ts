import { describe, expect, it } from 'vitest';
import { ROOM_CODE_ALPHABET, isRoomCode, normalizeRoomCode, roomCodeFromBytes } from '../src';

describe('room codes (docs/07 §5.1)', () => {
  it('uses 6 letters from the 23-letter alphabet without 0/O, 1/I/L', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(23);
    for (const c of 'OIL01') expect(ROOM_CODE_ALPHABET).not.toContain(c);
    expect(isRoomCode('KQXMZP')).toBe(true);
    for (const bad of ['KQXMZ', 'KQXMZPA', 'kqxmzp', 'KQ0MZP', 'KQIMZP', 'KQLMZP', 'KQOMZP', 'KQ MZP', '']) expect(isRoomCode(bad)).toBe(false);
  });

  it('normalises what players type or paste', () => {
    expect(normalizeRoomCode(' kqx-mzp ')).toBe('KQXMZP');
    expect(normalizeRoomCode('kqx mzp')).toBe('KQXMZP');
    expect(normalizeRoomCode('https://abc.trycloudflare.com/r/KQXMZP')).toBe('KQXMZP');
    expect(normalizeRoomCode('https://host/?room=kqxmzp&x=1')).toBe('KQXMZP');
    expect(normalizeRoomCode('KQ0MZP')).toBeNull();
    expect(normalizeRoomCode('hello world')).toBeNull();
    expect(normalizeRoomCode('')).toBeNull();
  });

  it('draws codes uniformly from random bytes, skipping the biased tail', () => {
    // 253..255 would favour the first three letters; they are skipped
    expect(roomCodeFromBytes(Uint8Array.from([255, 0, 1, 2, 253, 3, 254, 4, 5]))).toBe('ABCDEF');
    expect(roomCodeFromBytes(Uint8Array.from([22, 45, 252, 23, 24, 25]))).toBe('ZZZABC');
    expect(() => roomCodeFromBytes(Uint8Array.from([253, 254, 1]))).toThrow(/not enough/);
    const counts = new Map<string, number>();
    for (let b = 0; b < 253; b++) {
      const c = roomCodeFromBytes(Uint8Array.from([b, b, b, b, b, b]))[0]!;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(new Set(counts.values())).toEqual(new Set([11]));
  });
});
