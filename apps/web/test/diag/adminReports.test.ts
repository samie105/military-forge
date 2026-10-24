/** The admin page's Reports (admin/reports.ts): a device in a few words, a report as readable text. */
import { describe, expect, it } from 'vitest';
import { reportText, shortDevice } from '../../src/admin/reports';

describe('admin reports', () => {
  it('names the device and browser', () => {
    expect(shortDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(shortDevice('Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36')).toBe('SM-S911B · Samsung Internet');
    expect(shortDevice('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('Android · Chrome');
  });

  it('reads a report top to bottom: who, where, then each event with its time', () => {
    const text = reportText({
      id: 'ABCD2345',
      at: Date.UTC(2026, 9, 24, 18, 0),
      reason: 'auto',
      context: 'local room KMTXRA: connection lost (1006)',
      nickname: 'Ade',
      build: 'abc1234',
      device: { ua: 'Mozilla/5.0 (iPhone)', w: 844, h: 300, dpr: 3, standalone: false, touch: true },
      events: [
        { t: 1200, k: 'lan', m: 'guest: joining KMTXRA through the relay' },
        { t: 13_400, k: 'rtc', m: 'peer 1: connection failed at 12000 ms' },
      ],
      errors: [],
    });
    expect(text).toContain('Report ABCD2345');
    expect(text).toContain('sent by itself');
    expect(text).toContain('Ade · build abc1234 · iPhone · ? · 844×300 @3x · in the browser · touch');
    expect(text).toMatch(/ {3}1\.2 s {2}lan {4}guest: joining KMTXRA/);
    expect(text).toContain('13.4 s  rtc    peer 1: connection failed');
  });
});
