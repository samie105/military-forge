/**
 * A failed connection's automatic report with the bot check on (bot check, 30 Oct): it asks Turnstile
 * for a token quietly (no widget) and sends it; when none comes in time the report isn't sent, the
 * event log says so and the player sees nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const quietToken = vi.fn<(action: string) => Promise<string | null>>();
vi.mock('../../src/shell/account/turnstile', () => ({ botCheckOn: true, quietToken: (action: string) => quietToken(action) }));

const { AUTO_EVERY_MS, autoReport, reportStore } = await import('../../src/diag/report');
const { clearDiag, diagEvents } = await import('../../src/diag/log');

afterEach(() => {
  clearDiag();
  vi.unstubAllGlobals();
});

describe('an automatic report, with the bot check on', () => {
  it("is sent with a quiet token made for reports", async () => {
    quietToken.mockResolvedValueOnce('quiet-tok');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'AUTO2345' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await new Promise<boolean>((resolve) => expect(autoReport('room: lost', 1_000_000_000, resolve)).toBe(true));
    expect(ok).toBe(true);
    expect(quietToken).toHaveBeenCalledWith('report');
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ reason: 'auto', context: 'room: lost', turnstileToken: 'quiet-tok' });
    expect(reportStore.getState().last).toMatchObject({ id: 'AUTO2345', reason: 'auto' });
  });

  it("isn't sent when no token comes (the log notes it; nothing on screen)", async () => {
    quietToken.mockResolvedValueOnce(null);
    reportStore.setState({ last: null });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await new Promise<boolean>((resolve) => expect(autoReport('local room: unreachable', 1_000_000_000 + AUTO_EVERY_MS, resolve)).toBe(true));
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportStore.getState().last).toBeNull();
    expect(diagEvents().at(-1)).toMatchObject({ k: 'report', m: expect.stringContaining('not sent, no bot check token') });
  });
});
