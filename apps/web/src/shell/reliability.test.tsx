/**
 * A deploy and a long drop, as the player sees them (audit 2 L-05, L-18, L-24): a server draining
 * for an update never blames the player's Wi-Fi, the reconnect banner says "the match keeps running"
 * only when one is, and the update's own card offers to try again.
 */
import { CloseCode } from '@military-forge/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SERVER_RESTARTING, waitingOutUpdate } from './App';
import { alertFromConnection } from './alerts';
import { Connecting, ReconnectBanner } from './screens/Connection';
import type { ConnectionView } from './store';

const base: ConnectionView = { state: 'reconnecting', detail: '', code: 1006, since: 0, until: 60_000, attempt: 2, lastPingMs: 40, lossPct: 0 };

describe('a server draining for an update (L-05)', () => {
  it('turned away before we were in: the Connecting card waits and says the server is restarting', () => {
    expect(waitingOutUpdate({ state: 'reconnecting', code: CloseCode.ServerUpdating }, false)).toBe(true);
    // in the room already: the banner over the game says it (no card)
    expect(waitingOutUpdate({ state: 'reconnecting', code: CloseCode.ServerUpdating }, true)).toBe(false);
    expect(waitingOutUpdate({ state: 'reconnecting', code: 1006 }, false)).toBe(false);
    const html = renderToStaticMarkup(<Connecting code="KMTXRA" step={1} note={SERVER_RESTARTING} onCancel={() => {}} />);
    expect(html).toContain('The server is restarting · back in a moment');
    expect(html).not.toMatch(/Wi-Fi|your data/);
  });

  it('a drain that outlasts the wait: "Updating the server", try again, never "check your Wi-Fi"', () => {
    const a = alertFromConnection({ code: CloseCode.ServerUpdating, detail: 'the server is still restarting', attempt: 40, lastPingMs: -1, lossPct: 0 }, 'KMTXRA');
    expect(a).toMatchObject({ title: 'Updating the server', action: 'rejoin', code: 'SERVER_UPDATING · room KMTXRA' });
    expect(a.message).not.toMatch(/Wi-Fi|your data/);
    // a real drop still says it
    expect(alertFromConnection({ code: 1006, detail: 'connection lost', attempt: 3, lastPingMs: 40, lossPct: 0 }, 'KMTXRA').message).toMatch(/Wi-Fi/);
  });

  it('in the room: the banner says the server is restarting and we come back to the same room', () => {
    const html = renderToStaticMarkup(<ReconnectBanner connection={{ ...base, code: CloseCode.ServerUpdating }} />);
    expect(html).toContain('The server is restarting.');
    expect(html).toContain('Back in the same room in a moment');
  });
});

describe('a long drop (L-18)', () => {
  it('"The match keeps running" only while one does; a lobby keeps your place', () => {
    expect(renderToStaticMarkup(<ReconnectBanner connection={base} playing />)).toContain('The match keeps running');
    const lobby = renderToStaticMarkup(<ReconnectBanner connection={base} playing={false} />);
    expect(lobby).toContain('Your place is kept for a minute');
    expect(lobby).not.toContain('The match keeps running');
  });
});
