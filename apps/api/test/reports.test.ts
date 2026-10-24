/** Problem reports (reports/routes.ts): sent by anyone, rate limited, kept 7 days, read by the owner only. */
import { describe, expect, it } from 'vitest';
import { REPORT_TTL_MS } from '../src/reports/routes';
import { createTestApi, json } from './helpers';

const TOKEN = 'owner-secret-token-1234';
const report = (over: Record<string, unknown> = {}) => ({
  reason: 'auto',
  context: 'local room: unreachable',
  nickname: 'Ade',
  build: 'abc1234',
  device: { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', w: 844, h: 300, dpr: 3, standalone: false, touch: true, lang: 'en-GB' },
  events: [
    { t: 10, k: 'lan', m: 'join by code KMTXRA' },
    { t: 3600, k: 'rtc', m: 'connection failed' },
  ],
  errors: [],
  ...over,
});
const owner = { authorization: `Bearer ${TOKEN}` };

describe('problem reports', () => {
  it('stores a report and the owner reads it back, summarised then whole', async () => {
    const api = await createTestApi({ ADMIN_TOKEN: TOKEN });
    const sent = await api.app.request('/reports', json(report(), { 'x-forwarded-for': api.ip() }));
    expect(sent.status).toBe(201);
    const { id } = (await sent.json()) as { id: string };
    expect(id).toMatch(/^[A-Z0-9]{8}$/);
    const list = (await (await api.app.request('/reports', { headers: owner })).json()) as { reports: { id: string; problem: string; nickname: string }[] };
    expect(list.reports[0]).toMatchObject({ id, nickname: 'Ade', problem: 'rtc: connection failed' });
    const whole = (await (await api.app.request(`/reports/${id}`, { headers: owner })).json()) as { events: unknown[]; device: { w: number } };
    expect(whole.events).toHaveLength(2);
    expect(whole.device.w).toBe(844);
  });

  it('only the owner reads them, and never without a token configured', async () => {
    const api = await createTestApi({ ADMIN_TOKEN: TOKEN });
    expect((await api.app.request('/reports')).status).toBe(401);
    expect((await api.app.request('/reports', { headers: { authorization: 'Bearer wrong-token-wrong-token' } })).status).toBe(401);
    const off = await createTestApi();
    expect((await off.app.request('/reports', { headers: owner })).status).toBe(401);
  });

  it('refuses what is not a report, and more than 6 in 10 minutes from one address', async () => {
    const api = await createTestApi({ ADMIN_TOKEN: TOKEN });
    expect((await api.app.request('/reports', json({ hello: 1 }, { 'x-forwarded-for': '198.51.100.7' }))).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await api.app.request('/reports', json(report(), { 'x-forwarded-for': '198.51.100.7' }))).status).toBe(201);
    expect((await api.app.request('/reports', json(report(), { 'x-forwarded-for': '198.51.100.7' }))).status).toBe(429);
  });

  it('keeps a report 7 days', async () => {
    const api = await createTestApi({ ADMIN_TOKEN: TOKEN });
    const { id } = (await (await api.app.request('/reports', json(report(), { 'x-forwarded-for': api.ip() }))).json()) as { id: string };
    api.clock.advance(REPORT_TTL_MS - 1000);
    expect((await api.app.request(`/reports/${id}`, { headers: owner })).status).toBe(200);
    api.clock.advance(2000);
    expect((await api.app.request(`/reports/${id}`, { headers: owner })).status).toBe(404);
  });
});
