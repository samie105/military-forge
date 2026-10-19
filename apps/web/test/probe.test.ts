/** The net trial's ping probe (src/probe/stats.ts): the numbers it reports and the result it posts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PING_BYTES, REFERENCES, echoSeq, refUrl, refsPayload, traceColo, guessDevice, median, missingAnswer, parseConfig, percentile, pingFrame, resultPayload, summarize, verdict, type Answers } from '../src/probe/stats';

const answers = (over: Partial<Answers> = {}): Answers => ({ city: 'Lagos', network: 'mtn', isp: '', connection: 'mobile', device: 'Android phone', note: '', ...over });

describe('probe stats', () => {
  it('median and nearest-rank percentiles', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it('summarizes a run: lost pings count against loss only, jitter follows send order', () => {
    const s = summarize([40, 50, null, 40, 200, null]);
    expect(s.sent).toBe(6);
    expect(s.received).toBe(4);
    expect(s.loss).toBe(33.3);
    expect(s.median).toBe(45);
    expect(s.p95).toBe(200);
    // |50-40| + |40-50| + |200-40| over 3 steps
    expect(s.jitter).toBe(60);
    expect(s.min).toBe(40);
    expect(s.max).toBe(200);
    expect(s.over150).toBe(25);
  });

  it('a run with no echoes is all loss and no numbers', () => {
    const s = summarize(Array(300).fill(null));
    expect(s).toMatchObject({ sent: 300, received: 0, loss: 100, median: null, p95: null, jitter: null, over150: null });
  });

  it('pings carry their sequence number; anything else is not an echo', () => {
    const f = pingFrame(1234567);
    expect(f.byteLength).toBe(PING_BYTES);
    expect(echoSeq(f)).toBe(1234567);
    expect(echoSeq(new ArrayBuffer(8))).toBeNull();
    expect(echoSeq('1234')).toBeNull();
  });
});

describe('probe config', () => {
  it('keeps well-formed regions and result URLs', () => {
    const c = parseConfig({
      trial: 'mf-trial',
      regions: [
        { id: 'los', name: 'Lagos', provider: 'AWS Local Zone', echo: 'wss://1-2-3-4.sslip.io/echo' },
        { id: 'BAD ID', echo: 'wss://x/echo' },
        { id: 'jnb', echo: 'http://not-a-socket' },
      ],
      results: ['https://1-2-3-4.sslip.io/probe-api/results', 'javascript:alert(1)'],
    });
    expect(c?.regions.map((r) => r.id)).toEqual(['los']);
    expect(c?.results).toEqual(['https://1-2-3-4.sslip.io/probe-api/results']);
    expect(parseConfig({ regions: [] })).toBeNull();
    expect(parseConfig(null)).toBeNull();
  });
});

describe('probe answers and result', () => {
  it('asks for what is missing', () => {
    expect(missingAnswer(answers())).toBe('');
    expect(missingAnswer(answers({ city: ' ' }))).toMatch(/city/);
    expect(missingAnswer(answers({ network: '' }))).toMatch(/network/);
    expect(missingAnswer(answers({ network: 'fibre' }))).toMatch(/fibre/);
    expect(missingAnswer(answers({ network: 'fibre', isp: 'Spectranet' }))).toBe('');
    expect(missingAnswer(answers({ device: '' }))).toMatch(/device/);
  });

  it('guesses the device from the user agent', () => {
    expect(guessDevice('Mozilla/5.0 (Linux; Android 14; SM-A145F) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36')).toBe('Android phone');
    expect(guessDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(guessDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows PC or laptop');
    expect(guessDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('Mac');
    expect(guessDevice('')).toBe('');
  });

  it('posts the answers and per-region raw RTTs with their summary, and nothing about the browser', () => {
    const config = { trial: 'mf-trial', regions: [], results: [] };
    const body = resultPayload('id-12345678', config, answers({ note: ' indoors ' }), { los: { connectMs: 123.456, rtts: [30.04, null, 31.27], error: '' } }, { at: '2026-10-20T10:00:00Z', page: 'x.sslip.io', backgrounded: false });
    expect(body).toMatchObject({ id: 'id-12345678', trial: 'mf-trial', city: 'Lagos', network: 'mtn', note: 'indoors', backgrounded: false });
    expect(body.regions.los).toEqual({ connectMs: 123.5, sent: 3, rtts: [30, null, 31.3], median: 30.7, p95: 31.3, jitter: 1.3, loss: 33.3, error: '' });
    expect(JSON.stringify(body)).not.toMatch(/Mozilla|userAgent/);
  });

  it('names the faster region', () => {
    const a = { name: 'Lagos', s: summarize([30, 32, 31]) };
    const b = { name: 'Johannesburg', s: summarize([90, 95, 92]) };
    expect(verdict(a, b)).toEqual({ faster: 'Lagos', slower: 'Johannesburg', by: 61 });
    expect(verdict(b, a)?.faster).toBe('Lagos');
    expect(verdict(a, { name: 'x', s: summarize([null]) })).toBeNull();
  });
});

describe('reference pings', () => {
  it('have unique ids the probe server keeps, over HTTPS', () => {
    const ids = REFERENCES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of REFERENCES) {
      expect(r.id).toMatch(/^[a-z0-9-]{2,24}$/);
      expect(new URL(r.url).protocol).toBe('https:');
    }
    expect(REFERENCES.length).toBeLessThanOrEqual(16);
  });

  it("are all allowed by the trial box's Content-Security-Policy", () => {
    const script = readFileSync(new URL('../../../scripts/net-trial/cloud-init.sh', import.meta.url), 'utf8');
    const csp = /connect-src ([^;]*);/.exec(script)?.[1] ?? '';
    const allowed = csp.split(/\s+/).filter((s) => s.startsWith('https://'));
    for (const r of REFERENCES) {
      const host = new URL(r.url).host;
      expect(allowed.some((a) => { const h = a.slice('https://'.length); return h === host || (h.startsWith('*.') && host.endsWith(h.slice(1))); }), host).toBe(true);
    }
  });

  it('cache-bust every request', () => {
    const ref = REFERENCES.find((r) => r.id === 'cf-edge')!;
    expect(refUrl(ref, 1)).toMatch(/\/trace\?mf=\w+1$/);
    expect(refUrl(REFERENCES[0]!, 2)).toMatch(/\?mf=\w+2$/);
    expect(refUrl(ref, 1)).not.toBe(refUrl(ref, 2));
  });

  it("read Cloudflare's city from its trace", () => {
    expect(traceColo('fl=1\nh=speed.cloudflare.com\nloc=NG\ncolo=LOS\nhttp=http/2\n')).toBe('LOS');
    expect(traceColo('colo=<x>')).toBe('');
  });

  it('go into the result with their summary', () => {
    const p = refsPayload({ 'aws-eu-west-2': { rtts: [150.04, null, 160], colo: '', error: '' } }) as Record<string, { rtts: unknown[]; median: number; loss: number }>;
    expect(p['aws-eu-west-2']!.rtts).toEqual([150, null, 160]);
    expect(p['aws-eu-west-2']!.median).toBe(155);
    expect(p['aws-eu-west-2']!.loss).toBeCloseTo(33.3, 1);
    const body = resultPayload('id-12345678', { trial: 't', regions: [], results: [] }, answers(), {}, { at: '', page: '', backgrounded: false });
    expect(body.refs).toEqual({});
  });
});
