/** Problem reports on the device (diag/): the log keeps the newest, a report fits the API's limit, a failed connection sends one at most every 10 minutes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_EVENTS, MAX_ERRORS, MAX_LINE, clearDiag, diag, diagError, diagErrors, diagEvents } from '../../src/diag/log';
import { AUTO_EVERY_MS, MAX_NOTE, MAX_REPORT_BYTES, WHAT_IS_SENT, autoReport, buildReport, reportStore, sendReport, setReportSources } from '../../src/diag/report';

afterEach(() => {
  clearDiag();
  vi.unstubAllGlobals();
});

describe('the device event log', () => {
  it('keeps the newest events and errors, each line cut short', () => {
    for (let i = 0; i < MAX_EVENTS + 20; i++) diag('lan', `step ${i}`);
    expect(diagEvents()).toHaveLength(MAX_EVENTS);
    expect(diagEvents()[0]!.m).toBe('step 20');
    diag('rtc', 'x'.repeat(1000));
    expect(diagEvents().at(-1)!.m).toHaveLength(MAX_LINE);
    for (let i = 0; i < MAX_ERRORS + 5; i++) diagError(new Error(`boom ${i}`));
    expect(diagErrors()).toHaveLength(MAX_ERRORS);
    expect(diagErrors().at(-1)).toContain('boom 24');
  });
});

describe('a report', () => {
  it('carries the log, the name, the device and the build, and fits under the API limit', () => {
    setReportSources({ nickname: () => 'Ade', tour: () => ['12:00:01 shown {"step":"run"}'] });
    for (let i = 0; i < MAX_EVENTS; i++) diag('net', `${'y'.repeat(200)} ${i}`);
    const r = buildReport('manual', 'settings');
    expect(r).toMatchObject({ reason: 'manual', context: 'settings', nickname: 'Ade', tour: ['12:00:01 shown {"step":"run"}'] });
    expect(r.device).toHaveProperty('ua');
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    // the newest events stay
    expect(r.events.at(-1)!.m).toMatch(/ 299$/);
  });

  it('says on screen what it sends, the note included', () => {
    for (const word of ['steps', 'errors', 'device', 'browser', 'version', 'in-game name', 'note', '7 days']) expect(WHAT_IS_SENT).toContain(word);
  });

  it("carries the player's note (the legal pages' contact route until there is an email), trimmed and cut to the API's limit", () => {
    expect(buildReport('manual', 'settings', '  Please send me a copy of my data. Name: Ade  ').note).toBe('Please send me a copy of my data. Name: Ade');
    expect(buildReport('manual', 'settings', 'x'.repeat(MAX_NOTE + 50)).note).toHaveLength(MAX_NOTE);
    expect(buildReport('manual', 'settings', '   ')).not.toHaveProperty('note');
  });

  it('posts to /api/reports and remembers the id; offline and rate-limited say so', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'ABCD2345' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendReport('manual', 'pause: in a room')).toEqual({ ok: true, id: 'ABCD2345' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/reports');
    expect(init.credentials).toBe('omit');
    expect(reportStore.getState().last).toMatchObject({ id: 'ABCD2345', reason: 'manual' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    expect(await sendReport('manual', 'x')).toEqual({ ok: false, why: 'busy' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await sendReport('manual', 'x')).toEqual({ ok: false, why: 'offline' });
  });

  it('a failed connection sends one by itself, at most every 10 minutes (no bot check in this build: no token)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'X' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = 1_000_000_000;
    const sent = new Promise<boolean>((resolve) => expect(autoReport('local room: unreachable', t, resolve)).toBe(true));
    expect(await sent).toBe(true);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).not.toHaveProperty('turnstileToken');
    expect(autoReport('local room: unreachable', t + 60_000)).toBe(false);
    expect(autoReport('room: lost', t + AUTO_EVERY_MS)).toBe(true);
  });

  it("carries the bot check's token when there is one, and still fits under the API limit with Turnstile's longest (bot check, 30 Oct)", async () => {
    for (let i = 0; i < MAX_EVENTS; i++) diag('net', `${'y'.repeat(200)} ${i}`);
    const token = 't'.repeat(2048);
    const r = buildReport('manual', 'settings', 'a note', token);
    expect(r.turnstileToken).toBe(token);
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(buildReport('manual', 'settings')).not.toHaveProperty('turnstileToken');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'ABCD2345' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendReport('manual', 'settings', '', 'tok');
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ reason: 'manual', turnstileToken: 'tok' });
  });
});
