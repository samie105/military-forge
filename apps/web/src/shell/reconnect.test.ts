import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alertFromConnection } from './alerts';
import { ControllerContext } from './context';
import type { ShellController } from './controller';
import { RECONNECT_WINDOW_MS, reconnectDelay, reconnectTries } from './reconnect';
import { Alert, ReconnectBanner, TryPips } from './screens/Connection';
import type { ConnectionView } from './store';

describe('the reconnect counter', () => {
  it("follows onlineMode's backoff: 250 ms doubling to 2 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelay)).toEqual([250, 500, 1000, 2000, 2000, 2000]);
  });

  it('counts the tries a window holds', () => {
    // 0.25 + 0.5 + 1 + 2 = 3.75 s for the first four, then one every 2 s
    expect(reconnectTries(3750)).toBe(4);
    expect(reconnectTries(5750)).toBe(5);
    expect(reconnectTries(RECONNECT_WINDOW_MS)).toBe(32);
    expect(reconnectTries(0)).toBe(1);
  });

  it('draws one pip a try: the ones made, the one under way, the failed ones', () => {
    const html = renderToStaticMarkup(createElement(TryPips, { made: 2, of: 4 }));
    expect(html).toBe('<span class="mf-tries" aria-hidden="true"><i class="is-done"></i><i class="is-now"></i><i></i><i></i></span>');
    const failed = renderToStaticMarkup(createElement(TryPips, { made: 3, of: 3, failed: true }));
    expect(failed).toBe('<span class="mf-tries is-failed" aria-hidden="true"><i class="is-done"></i><i class="is-done"></i><i class="is-done"></i></span>');
  });

  it('the banner says "try N of M" while it reconnects', () => {
    const since = performance.now();
    const c: ConnectionView = { state: 'reconnecting', detail: 'closed', code: 1006, since, until: since + RECONNECT_WINDOW_MS, attempt: 3, lastPingMs: -1, lossPct: 0 };
    const html = renderToStaticMarkup(createElement(ReconnectBanner, { connection: c }));
    expect(html).toContain(' of 32');
    expect(html.match(/<i class="is-done"><\/i>/g)).toHaveLength(2);
    expect(html).toContain('class="is-now"');
  });

  it('the lost card counts the failed tries, shows the code and says Rejoin', () => {
    const alert = alertFromConnection({ code: 1006, detail: '', attempt: 32, lastPingMs: 412, lossPct: 18.2 }, 'KMTXRA');
    expect(alert.tries).toEqual({ made: 32, of: 32 });
    const ctl = {} as ShellController;
    const html = renderToStaticMarkup(createElement(ControllerContext.Provider, { value: ctl }, createElement(Alert, { alert, onRejoin: () => {} })));
    expect(html).toMatch(/<span class="num">32 of 32<\/span> tries failed/);
    expect(html).toContain('Code CONNECTION_LOST');
    expect(html).toContain('Rejoin');
    // never heard back at all: no pips
    expect(alertFromConnection({ code: 1006, detail: '', attempt: 0, lastPingMs: -1, lossPct: 0 }, 'KMTXRA').tries).toBeUndefined();
  });
});
