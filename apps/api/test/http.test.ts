/** Cross-cutting HTTP behaviour: health, version, request ids, CORS, error shapes, helpers. */
import { CONTENT_HASH, PROTOCOL_VERSION } from '@military-forge/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipPrefix, rateLimitSubject } from '../src/http/clientIp';
import { LIMITS } from '../src/http/rateLimit';
import { newId } from '../src/ids';
import { createTestApi, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(() => api.close());

describe('service endpoints', () => {
  it('GET /health reports the backends', async () => {
    const res = await api.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: api.database.kind, kv: api.kv.kind });
  });

  it('GET /version follows docs/07 §11', async () => {
    expect(await (await api.app.request('/version')).json()).toEqual({
      api: '0.1.0',
      minClient: null,
      latest: null,
      protocolVersion: PROTOCOL_VERSION,
      contentHash: CONTENT_HASH,
      maintenance: false,
      motd: null,
    });
    const pinned = await createTestApi({ MIN_CLIENT_VERSION: '0.3.0', LATEST_CLIENT_VERSION: '0.4.1' });
    expect(await (await pinned.app.request('/version')).json()).toMatchObject({ minClient: '0.3.0', latest: '0.4.1' });
    await pinned.close();
  });

  it('every response has a request id; a sane incoming one is echoed', async () => {
    expect((await api.app.request('/version')).headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await api.app.request('/version', { headers: { 'x-request-id': 'trace-123' } })).headers.get('x-request-id')).toBe('trace-123');
  });

  it('unknown routes and oversized bodies use the error contract', async () => {
    const missing = await api.app.request('/nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'No route for GET /nope' } });
    const big = await api.app.request('/auth/guest', { method: 'POST', body: 'x'.repeat(20_000), headers: { 'content-length': '20000' } });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe('payload_too_large');
  });
});

describe('CORS', () => {
  const preflight = (origin: string, a: TestApi = api) =>
    a.app.request('/auth/refresh', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });

  it('dev default: any localhost origin, with credentials', async () => {
    const res = await preflight('http://localhost:5183');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5183');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses state-changing requests from other origins (CSRF), allows listed ones and non-browser clients', async () => {
    const s = (await (await api.app.request('/auth/guest', { method: 'POST', headers: { 'x-forwarded-for': api.ip() } })).json()) as { refreshToken: string };
    const logout = (headers: Record<string, string>) =>
      api.app.request('/auth/logout', { method: 'POST', headers: { cookie: `refresh_token=${s.refreshToken}`, 'content-type': 'text/plain', ...headers } });
    const forged = await logout({ origin: 'https://evil.example' });
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('origin_not_allowed');
    expect((await logout({ origin: 'null' })).status).toBe(403);
    expect((await api.app.request('/version', { headers: { origin: 'https://evil.example' } })).status).toBe(200);
    expect((await logout({ origin: 'http://localhost:5183' })).status).toBe(204);
    expect((await logout({})).status).toBe(204);
  });

  it('configured: exact origins only', async () => {
    const strict = await createTestApi({ CORS_ORIGINS: 'https://play.example.com' });
    expect((await preflight('https://play.example.com', strict)).headers.get('access-control-allow-origin')).toBe('https://play.example.com');
    expect((await preflight('http://localhost:5173', strict)).headers.get('access-control-allow-origin')).toBeNull();
    await strict.close();
  });
});

describe('helpers', () => {
  it('ids are prefixed, unique and sort by creation time', () => {
    const a = newId('u', 1_000);
    const b = newId('u', 2_000);
    expect(a).toMatch(/^u_[0-9a-z]{26}$/);
    expect(a < b).toBe(true);
    expect(newId('s', 5)).not.toBe(newId('s', 5));
  });

  it('ip prefixes keep only the network part', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix('64:ff9b::203.0.113.77')).toBe('64:ff9b:0::/48');
    expect(ipPrefix('unknown')).toBeNull();
  });

  it('rate limits key IPv4 per address and IPv6 per /64', () => {
    expect(rateLimitSubject('203.0.113.77')).toBe('203.0.113.77');
    expect(rateLimitSubject('::ffff:203.0.113.77')).toBe('203.0.113.77');
    expect(rateLimitSubject('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSubject('2001:DB8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSubject('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitSubject('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitSubject('unknown')).toBe('unknown');
  });
});

describe('client IP and rate-limit buckets', () => {
  const guest = (a: TestApi, headers: Record<string, string>) => a.app.request('/auth/guest', { method: 'POST', headers });
  const statuses = async (a: TestApi, n: number, headers: (i: number) => Record<string, string>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await guest(a, headers(i))).status);
    return out;
  };

  it('xff: a spoofed left-most hop does not change the bucket; the proxy-appended hop does', async () => {
    const limit = LIMITS.guestCreate.limit;
    const spoofed = await statuses(api, limit + 5, (i) => ({ 'x-forwarded-for': `10.9.${i}.1, 198.51.100.50` }));
    expect(spoofed.filter((s) => s === 201)).toHaveLength(limit);
    expect(spoofed.at(-1)).toBe(429);
    // the right-most entry is the client as the trusted proxy saw it
    expect((await guest(api, { 'x-forwarded-for': '198.51.100.50, 198.51.100.51' })).status).toBe(201);
  });

  it('xff with two trusted proxies reads the second entry from the right', async () => {
    const two = await createTestApi({ TRUST_PROXY_HOPS: '2' });
    const limit = LIMITS.guestCreate.limit;
    const res = await statuses(two, limit + 1, (i) => ({ 'x-forwarded-for': `10.0.${i}.1, 198.51.100.60, 10.1.1.${i}` }));
    expect(res.at(-1)).toBe(429);
    await two.close();
  });

  it('cloudflare: every address in one IPv6 /64 shares a bucket', async () => {
    const cf = await createTestApi({ TRUST_PROXY: 'cloudflare' });
    const limit = LIMITS.guestCreate.limit;
    const res = await statuses(cf, limit + 5, (i) => ({ 'cf-connecting-ip': `2001:db8:1:2::${(i + 1).toString(16)}` }));
    expect(res.filter((s) => s === 201)).toHaveLength(limit);
    expect(res.at(-1)).toBe(429);
    // the neighbouring /64 is someone else
    expect((await guest(cf, { 'cf-connecting-ip': '2001:db8:1:3::1' })).status).toBe(201);
    await cf.close();
  });
});
