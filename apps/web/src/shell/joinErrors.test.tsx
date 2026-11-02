/**
 * Join, errors and the name rules (UX audit 1 Nov, batch 4): the alert cards carry no code (it goes to
 * the report log), blame the player's connection only when the browser says it's offline, say "server
 * down" when our game server never let us in while the API answers, and lead a gone room Home; a bad
 * room link gets its own card; the name field holds 16 characters, its lines are sentences, the next
 * change is a plain date, and Edit name can't save an unchanged name.
 */
import { CloseCode } from '@military-forge/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alertFromApiError, alertFromConnection, badLinkAlert, type NetCause } from './alerts';
import { ApiError } from './api';
import { ControllerContext } from './context';
import { badRoomLink, type ShellController } from './controller';
import { plainDate, refusedLine, sentence } from './nameRules';
import { Alert } from './screens/Connection';
import { NAME_MAX, NameEntry, canSaveName, nextChangeLine } from './screens/NameEntry';
import { createShellStore, type AlertInfo } from './store';

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const card = (alert: AlertInfo, rejoin = true) =>
  renderToStaticMarkup(
    <ControllerContext.Provider value={{} as ShellController}>
      <Alert alert={alert} onRejoin={rejoin ? () => {} : null} />
    </ControllerContext.Provider>,
  );

const online: NetCause = { online: true, api: 'up' };
const apiDown: NetCause = { online: true, api: 'down' };
const noInternet: NetCause = { online: false, api: 'down' };
const BLAME = /wi-?fi|your data|check your (connection|internet)/i;

describe('alert cards (UX-16, D-16)', () => {
  const everyAlert: AlertInfo[] = [
    alertFromApiError(new ApiError(404, 'room_not_found', 'x'), 'KMTXRA'),
    alertFromApiError(new ApiError(400, 'invalid_room_code', 'x'), 'QQ'),
    alertFromApiError(new ApiError(429, 'rate_limited', 'x', { retryAfter: 20 })),
    alertFromApiError(new ApiError(500, 'boom', 'internal detail')),
    alertFromApiError(new ApiError(0, 'network', 'down'), 'KMTXRA', online),
    alertFromApiError(new ApiError(0, 'network', 'down'), 'KMTXRA', noInternet),
    ...[CloseCode.ServerUpdating, CloseCode.VersionMismatch, CloseCode.RoomFull, CloseCode.NoRoom, CloseCode.RateLimited, CloseCode.BadMessage, CloseCode.DuplicateSession, CloseCode.TicketInvalid, 1008, 1011, 1006].map((code) =>
      alertFromConnection({ code, detail: code === CloseCode.TicketInvalid ? 'your pass expired' : '', attempt: 4, lastPingMs: -1, lossPct: 0 }, 'KMTXRA', false, false, online),
    ),
    alertFromConnection({ code: 1006, detail: '', attempt: 4, lastPingMs: 80, lossPct: 3 }, 'KMTXRA', false, false, online),
    badLinkAlert('12'),
  ];

  it('no card prints a code: it goes to the report log', () => {
    for (const a of everyAlert) {
      const t = textOf(card(a));
      expect(t, a.title).not.toMatch(/\bCode\b/);
      if (a.code) expect(t, a.title).not.toContain(a.code.split(' · ')[0]!);
      expect(t, a.title).not.toMatch(/HTTP \d|internal detail|[A-Z]+_[A-Z_]+/);
    }
  });

  it("no card blames the player's Wi-Fi unless the browser says this device is offline", () => {
    for (const a of everyAlert) expect(`${a.title} ${a.message}`, a.title).not.toMatch(BLAME);
  });

  it('the game server never let us in while the API answers: "server down", ours, Training leads, Try again beside it', () => {
    const a = alertFromConnection({ code: 1006, detail: 'connection lost', attempt: 6, lastPingMs: -1, lossPct: 0 }, 'KMTXRA', false, false, online);
    expect(a).toMatchObject({ kind: 'server-down', title: 'Our game server isn’t answering', action: 'rejoin', lead: 'training' });
    expect(a.message).toContain('It’s on our side, not your connection.');
    expect(a.code).toMatch(/^SERVER_DOWN/);
    const html = card(a);
    expect(html).toMatch(/class="stamp stamp--warn stamp--lg conn__stamp[^"]*">Server down</);
    expect(textOf(html)).not.toMatch(/Offline/);
    // the volt button is Training, then Try again, then Home
    const buttons = [...html.matchAll(/<button class="btn (btn--\w+)[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => `${m[1]} ${textOf(m[2]!).trim()}`);
    expect(buttons).toEqual(['btn--volt Training Bots · works offline', 'btn--paper Try again', 'btn--ghost Home']);
  });

  it('the API does not answer either: "No answer", and the words leave the cause open (ours or theirs)', () => {
    const a = alertFromConnection({ code: 1006, detail: '', attempt: 3, lastPingMs: -1, lossPct: 0 }, 'KMTXRA', false, false, apiDown);
    expect(a).toMatchObject({ kind: 'server-down', stamp: 'No answer', lead: 'training' });
    expect(a.message).toContain("If other sites load, it's on our side");
    expect(textOf(card(a))).toContain('No answer');
  });

  it('this device is offline: the one time the card says so', () => {
    const a = alertFromConnection({ code: 1006, detail: '', attempt: 3, lastPingMs: 40, lossPct: 0 }, 'KMTXRA', false, false, noInternet);
    expect(a).toMatchObject({ kind: 'offline', title: "You're offline", lead: 'training' });
    expect(textOf(card(a))).toContain('Offline');
  });

  it('a room that dropped while the API answers: "Connection lost", Rejoin, nobody blamed', () => {
    const a = alertFromConnection({ code: 1006, detail: '', attempt: 3, lastPingMs: 40, lossPct: 0 }, 'KMTXRA', false, false, online);
    expect(a).toMatchObject({ kind: 'connection-lost', title: 'Connection lost', action: 'rejoin' });
    expect(a.lead).toBeUndefined();
    expect(textOf(card(a))).toMatch(/Rejoin/);
  });

  it('a room that is gone leads Home (volt), with Try again as the ghost beside it', () => {
    const a = alertFromApiError(new ApiError(404, 'room_not_found', 'x'), 'QQQQQQ');
    expect(a).toMatchObject({ kind: 'room-not-found', lead: 'home', action: 'rejoin' });
    const html = card(a);
    expect(html).toMatch(/<button class="btn btn--volt[^"]*"[^>]*>.*?Home<\/button>/);
    expect(html).toMatch(/<button class="btn btn--ghost[^"]*"[^>]*>.*?Try again<\/button>/);
    expect(html).not.toMatch(/btn--volt[^"]*"[^>]*>(?:(?!<\/button>).)*Try again/);
    // a closed room's ticket: Home leads, Type a code beside it
    const closed = alertFromConnection({ code: CloseCode.TicketInvalid, detail: 'the room has closed', attempt: 0, lastPingMs: -1, lossPct: 0 }, 'KMTXRA');
    expect(textOf(card(closed))).toMatch(/Home.*Type a code/);
  });

  it('a room link that is not one gets its own card instead of a silent Home (B-17)', () => {
    expect(badRoomLink({ pathname: '/r/12', search: '' })).toBe('12');
    expect(badRoomLink({ pathname: '/r/', search: '' })).toBe('');
    expect(badRoomLink({ pathname: '/', search: '?room=hello' })).toBe('hello');
    expect(badRoomLink({ pathname: '/r/KMTXRA', search: '' })).toBeNull();
    expect(badRoomLink({ pathname: '/r/kmtxra', search: '' })).toBeNull();
    expect(badRoomLink({ pathname: '/', search: '' })).toBeNull();
    const a = badLinkAlert('12');
    expect(a).toMatchObject({ kind: 'room-not-found', title: "That link doesn't look right", lead: 'home', action: null });
    expect(textOf(card(a, false))).toMatch(/Home.*Type a code/);
  });

  it('a late HELLO still retries quietly and shows no code (UX-20 kept)', () => {
    const a = alertFromConnection({ code: 1008, detail: 'no HELLO within 5 s', attempt: 0, lastPingMs: -1, lossPct: 0 }, 'KMTXRA', false, false, online);
    expect(a).toMatchObject({ title: 'Took too long to load', code: '', action: 'rejoin' });
  });
});

describe('the name rules (A-04, C-35, UX-07)', () => {
  it('the field holds 16 characters, the most a name has', () => {
    const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
    const html = renderToStaticMarkup(
      <ControllerContext.Provider value={{ store, checkName: async () => null } as unknown as ShellController}>
        <NameEntry store={store} first />
      </ControllerContext.Provider>,
    );
    expect(NAME_MAX).toBe(16);
    expect(html).toMatch(/<input[^>]*id="ne-input"[^>]*maxLength="16"/);
    expect(textOf(html)).toContain('What do we call you?');
  });

  it("Edit name has its own headline, and Save is off while the name is unchanged", () => {
    const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
    const html = renderToStaticMarkup(
      <ControllerContext.Provider value={{ store, checkName: async () => null, closeOverlay: () => {} } as unknown as ShellController}>
        <NameEntry store={store} first={false} />
      </ControllerContext.Provider>,
    );
    const t = textOf(html);
    expect(t).toContain('Change your name');
    expect(t).not.toContain('What do we call you?');
    expect(t).not.toContain('You can change it later on Home');
    expect(t).toContain("That's your name now");
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save/);
    expect(canSaveName('same', false, false)).toBe(false);
    expect(canSaveName('available', false, false)).toBe(true);
    expect(canSaveName('unchecked', false, false)).toBe(true);
    expect(canSaveName('checking', false, true)).toBe(true);
    expect(canSaveName('available', true, false)).toBe(false);
  });

  it('the next change is a plain date ("8 Nov"), never "11/8/2026"', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    expect(plainDate('2026-11-08T09:00:00Z', now)).toBe('8 Nov');
    expect(plainDate('2027-01-03T09:00:00Z', now)).toBe('3 Jan 2027');
    expect(nextChangeLine('2026-11-08T09:00:00Z', now)).toBe('Name changes are once a week: next on 8 Nov.');
    expect(nextChangeLine('2026-10-30T09:00:00Z', now)).toBeNull();
    expect(nextChangeLine(null, now)).toBeNull();
    expect(nextChangeLine('2026-11-08T09:00:00Z', now)).not.toMatch(/\d+\/\d+/);
  });

  it('the status lines are sentences: "Someone already has that name. Try one of these."', () => {
    expect(refusedLine('Someone already has that name', true)).toBe('Someone already has that name. Try one of these.');
    expect(refusedLine("That name isn't allowed. Pick another", false)).toBe("That name isn't allowed. Pick another.");
    expect(refusedLine('You can change your name again on 8 Nov.', false)).toBe('You can change your name again on 8 Nov.');
    expect(sentence('At least 3 characters')).toBe('At least 3 characters.');
  });
});
