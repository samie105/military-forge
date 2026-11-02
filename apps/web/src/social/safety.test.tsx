/**
 * Player safety on the web (audit-2, 1 Nov): the player sheet (Report with its reasons and note, the
 * thanks, Block by id or name, the host's Remove), a row's ⋯ (none for bots or yourself), the request
 * toast's Block, the "who can send me requests" setting, and the under-18 gate (no friends, voice or
 * search; the account told with only a flag; a new guest made with it). Voice's kept mutes are in
 * voice/voice.test.ts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerAge } from '../shell/age';
import { Api, ApiError, type Me } from '../shell/api';
import { ControllerContext } from '../shell/context';
import { ShellController, type GameHost } from '../shell/controller';
import { alertFromApiError, alertFromConnection, suspendedAlert } from '../shell/alerts';
import { createShellStore, type ShellStore } from '../shell/store';
import { CloseCode } from '@military-forge/protocol';
import type { FriendsList } from './api';
import { FindMeSetting, REQUESTS_FROM_LABEL } from './FindMe';
import { BLOCK_LINE, PlayerMore, PlayerSheet, REPORT_REASONS, REPORT_THANKS, REMOVE_LINE, roomTarget } from './ReportSheet';
import { RequestToast } from './RequestToast';
import { SocialController, socialAllowed, socialOf, type SocialShell } from './social';

const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

function list(extra: Partial<FriendsList> = {}): FriendsList {
  return { code: '7KQ4-M9XP', friends: [], incoming: [], outgoing: [], blocked: [], max: 200, ...extra };
}

/** A shell stand-in: an online, adult player in room KMTXRA (the host), and the API answering from `routes`. */
function fakeShell(routes: Record<string, (body: unknown) => unknown>, store: ShellStore = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } })) {
  const calls: { key: string; body: unknown }[] = [];
  const notices: string[] = [];
  const removed: number[] = [];
  const shell: SocialShell = {
    api: {
      authed: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        const key = `${method} ${path}`;
        calls.push({ key, body });
        const route = routes[key];
        if (!route) throw new ApiError(404, 'not_found', `no route ${key}`);
        return route(body) as T;
      },
      onSignIn: () => () => {},
    },
    store,
    host: { online: { leave: () => {}, removePlayer: (id) => removed.push(id) } },
    go: () => {},
    notify: (m) => notices.push(m),
  };
  return { shell, calls, notices, removed, store };
}

function inRoom(store: ShellStore, isHost = true) {
  store.setState({
    screen: { name: 'room', code: 'KMTXRA' } as never,
    lobby: {
      code: 'KMTXRA',
      isHost,
      players: [
        { id: 0, name: 'Ade', isBot: false, ready: true, host: isHost, you: true, pingMs: 20 },
        { id: 3, name: 'Pest_99', isBot: false, ready: false, host: false, you: false, pingMs: 40 },
        { id: 5, name: 'Kestrel', isBot: true, ready: true, host: false, you: false, pingMs: -1 },
      ],
    } as never,
  });
}

/** Renders a component inside a stand-in shell context (useSocial needs ctl.store and ctl.api.onSignIn). */
function render(node: React.ReactNode, shell: SocialShell): string {
  return textOf(renderToStaticMarkup(<ControllerContext.Provider value={shell as never}>{node}</ControllerContext.Provider>));
}

describe('reporting a player', () => {
  it('sends who (by name in a room, by id from Friends), the reason, the note, the room and the place; then thanks, nothing more', async () => {
    const { shell, calls, store } = fakeShell({ 'POST /reports/player': () => ({ id: 1 }), 'GET /friends': () => list() });
    inRoom(store);
    const social = new SocialController(shell, null);
    social.openReport({ name: 'Pest_99', pid: 3, place: 'lobby' });
    expect(social.store.getState().sheet).toMatchObject({ view: 'report', target: { name: 'Pest_99' } });
    expect(await social.sendReport('voice', '  slurs on voice  ')).toBe(true);
    expect(calls.at(-1)).toEqual({ key: 'POST /reports/player', body: { name: 'Pest_99', reason: 'voice', place: 'lobby', note: 'slurs on voice', room: 'KMTXRA' } });
    expect(social.store.getState().sheet?.view).toBe('sent');

    social.openReport({ name: 'Bisi', id: 'u_b', place: 'request' });
    await social.sendReport('spam', '');
    expect(calls.at(-1)?.body).toEqual({ id: 'u_b', reason: 'spam', place: 'request', room: 'KMTXRA' });

    // the thanks never promises more than the owner can keep
    expect(REPORT_THANKS).toBe("Thanks. We read every report and act on the ones that break the rules. We won't tell them it was you.");
  });

  it('a report that fails says why and stays on the form', async () => {
    const { shell } = fakeShell({
      'POST /reports/player': () => {
        throw new ApiError(429, 'rate_limited', 'x', { retryAfter: 3000 });
      },
    });
    const social = new SocialController(shell, null);
    social.openReport({ name: 'Pest_99', place: 'scoreboard' });
    expect(await social.sendReport('cheating', '')).toBe(false);
    expect(social.store.getState().sheet).toMatchObject({ view: 'report', sending: false, error: "You've sent a lot of reports in the last hour. Try again later." });
  });

  it('the sheet: six plain reasons and an optional note; the thanks; the block and remove lines', () => {
    const { shell, store } = fakeShell({});
    inRoom(store);
    const social = socialOf(shell);
    social.openReport({ name: 'Pest_99', pid: 3, place: 'lobby' });
    let html = render(<PlayerSheet social={social} />, shell);
    expect(html).toContain('Report Pest_99');
    for (const [, label] of REPORT_REASONS) expect(html).toContain(label);
    expect(REPORT_REASONS.map(([, l]) => l)).toEqual(['Offensive name', 'Abusive voice', 'Cheating', 'Spamming requests or invites', 'Under 18', 'Something else']);
    expect(html).toContain('Anything else? (optional)');
    expect(html).toContain('0/300');
    social.sheetView('sent');
    html = render(<PlayerSheet social={social} />, shell);
    expect(html).toContain(REPORT_THANKS);
    expect(html).toContain('Block Pest_99 too');
    social.sheetView('block');
    expect(render(<PlayerSheet social={social} />, shell)).toContain(BLOCK_LINE);
    social.sheetView('remove');
    expect(render(<PlayerSheet social={social} />, shell)).toContain(REMOVE_LINE);
  });

  it("one player's actions: Report and Block for anyone; Remove only for the room's host, never on the host", () => {
    const { shell, store } = fakeShell({});
    inRoom(store, true);
    const social = socialOf(shell);
    social.openPlayer({ name: 'Pest_99', pid: 3, place: 'lobby' });
    let html = render(<PlayerSheet social={social} />, shell);
    expect(html).toContain('Report');
    expect(html).toContain('Block');
    expect(html).toContain('Remove from room');
    inRoom(store, false);
    html = render(<PlayerSheet social={social} />, shell);
    expect(html).not.toContain('Remove from room');
    // from Friends (no room id): no Remove, no Mute
    inRoom(store, true);
    social.openPlayer({ name: 'Bisi', id: 'u_b', place: 'friends' });
    html = render(<PlayerSheet social={social} />, shell);
    expect(html).not.toContain('Remove from room');
  });

  it("the pause menu's Players lists the room's people: not you, not the bots", () => {
    const { shell, store } = fakeShell({});
    inRoom(store);
    const social = socialOf(shell);
    social.openPlayers();
    const html = render(<PlayerSheet social={social} />, shell);
    expect(html).toContain('Pest_99');
    expect(html).not.toContain('Kestrel');
    expect(html).not.toMatch(/\bAde\b/);
  });

  it('a row\'s ⋯ is there for other players, never for bots or your own row', () => {
    const { shell } = fakeShell({});
    expect(roomTarget({ id: 5, name: 'Kestrel', isBot: true, you: false }, 'lobby')).toBeNull();
    expect(roomTarget({ id: 0, name: 'Ade', isBot: false, you: true }, 'lobby')).toBeNull();
    expect(roomTarget({ id: 3, name: 'Pest_99', isBot: false, you: false }, 'lobby')).toEqual({ name: 'Pest_99', pid: 3, place: 'lobby' });
    const html = renderToStaticMarkup(<ControllerContext.Provider value={shell as never}><PlayerMore target={roomTarget({ id: 3, name: 'Pest_99', isBot: false, you: false }, 'lobby')} /></ControllerContext.Provider>);
    expect(html).toContain('aria-label="Report, block or mute Pest_99"');
    expect(renderToStaticMarkup(<ControllerContext.Provider value={shell as never}><PlayerMore target={null} /></ControllerContext.Provider>)).toBe('');
  });
});

describe('blocking anyone, and the host remove', () => {
  it('blocks a room player by name (no id there), and a stranger by id; their names reach voice chat', async () => {
    const { shell, calls, notices } = fakeShell({ 'POST /friends/blocks': () => undefined, 'GET /friends': () => list({ blocked: [{ id: 'u_b', nickname: 'Bisi', at: '' }] }) });
    const social = new SocialController(shell, null);
    expect(await social.blockPlayer({ name: 'Pest_99', pid: 3, place: 'scoreboard' })).toBe(true);
    expect(calls.find((c) => c.key === 'POST /friends/blocks')?.body).toEqual({ name: 'Pest_99' });
    expect(social.isBlocked({ name: 'pest_99' })).toBe(true);
    expect(notices).toContain("Blocked Pest_99. They aren't told.");
    await social.refresh();
    expect(await social.blockPlayer({ name: 'Bisi', id: 'u_b', place: 'request' })).toBe(true);
    expect(calls.filter((c) => c.key === 'POST /friends/blocks').at(-1)?.body).toEqual({ id: 'u_b' });
    expect(social.blockedNameList().sort()).toEqual(['bisi', 'pest_99']);
  });

  it("the host's Remove sends the room command for that player and says so", () => {
    const { shell, removed, notices } = fakeShell({});
    const social = new SocialController(shell, null);
    expect(social.removeFromRoom({ name: 'Pest_99', pid: 3, place: 'lobby' })).toBe(true);
    expect(removed).toEqual([3]);
    expect(notices).toContain('Pest_99 was removed from the room');
    // nobody to remove without a room id
    expect(social.removeFromRoom({ name: 'Bisi', id: 'u_b', place: 'friends' })).toBe(false);
  });

  it("the request toast has Block beside Accept: it asks once, on the sheet", () => {
    const { shell } = fakeShell({});
    const social = socialOf(shell);
    social.store.setState({ requestToasts: [{ id: 'u_p', nickname: 'Pest_99', at: new Date().toISOString() }] });
    const html = render(<RequestToast social={social} />, shell);
    expect(html).toContain('Pest_99 wants to be friends');
    expect(html).toContain('Accept');
    expect(html).toContain('Block');
  });

  it('a removed player is told plainly, with nothing to retry; suspended and under-18 refusals say what still works', () => {
    expect(alertFromConnection({ code: CloseCode.Removed, detail: '', attempt: 0, lastPingMs: -1, lossPct: 0 }, 'KMTXRA')).toMatchObject({ title: 'Removed from the room', message: 'The host removed you from this room.', action: null });
    const until = suspendedAlert('2026-11-02T12:00:00Z');
    expect(until.message).toMatch(/^This account can't play online until .+\. Training with bots still works\. If you think this is a mistake, send a report from Settings\.$/);
    expect(suspendedAlert(null).code).toBe('ACCOUNT_DISABLED');
    expect(alertFromApiError(new ApiError(403, 'adults_only', 'x'))).toMatchObject({ title: 'Online play is for adults', action: null });
  });
});

describe('who can send me friend requests', () => {
  it('three choices under "Let players find me by name"; picking one saves it, and rolls back if the API says no', async () => {
    let fail = false;
    const { shell, calls } = fakeShell({
      'GET /friends': () => list({ requestsFrom: 'anyone' }),
      'PUT /friends/settings': (b) => {
        if (fail) throw new ApiError(500, 'server_error', 'x');
        return { findable: true, requestsFrom: (b as { requestsFrom: string }).requestsFrom };
      },
    });
    const social = socialOf(shell);
    await social.refresh();
    const html = render(<FindMeSetting />, shell);
    expect(html).toContain(REQUESTS_FROM_LABEL);
    expect(html).toContain('Anyone');
    expect(html).toContain("People you've played with");
    expect(html).toContain('Only with your code');
    expect(await social.setRequestsFrom('played')).toBe(true);
    expect(calls.at(-1)).toEqual({ key: 'PUT /friends/settings', body: { requestsFrom: 'played' } });
    expect(social.store.getState().list?.requestsFrom).toBe('played');
    fail = true;
    expect(await social.setRequestsFrom('code')).toBe(false);
    expect(social.store.getState().list?.requestsFrom).toBe('played');
  });
});

describe('under 18: training only', () => {
  it('no friends for a minor profile, nor offline; an adult online player has them', () => {
    expect(socialAllowed({ offline: false })).toBe(true);
    expect(socialAllowed({ offline: false, minor: true })).toBe(false);
    expect(socialAllowed({ offline: true })).toBe(false);
    expect(socialAllowed(null)).toBe(false);
    const { shell } = fakeShell({}, createShellStore({ profile: { nickname: 'Kid', changeableAt: null, offline: false, minor: true } }));
    expect(new SocialController(shell, null).available).toBe(false);
  });

  function controller(api: Partial<Api>) {
    const host = { local: null, online: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost;
    const store = createShellStore();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('location', { pathname: '/', search: '', hash: '', origin: 'https://play.example', host: 'play.example', protocol: 'https:' });
    vi.stubGlobal('history', { pushState: vi.fn(), replaceState: vi.fn(), state: null });
    return { store, ctl: new ShellController(store, host, api as Api) };
  }
  const me: Me = { id: 'u_1', nickname: 'Kid', isGuest: true, createdAt: '', nicknameChangeableAt: null, level: 1, xp: 0 };

  it('answering under 18 tells the account (only the flag) and turns friends off at once', async () => {
    const markMinor = vi.fn(async () => ({ ...me, minor: true as const }));
    const { store, ctl } = controller({ me, markMinor } as unknown as Partial<Api>);
    store.setState({ profile: { nickname: 'Kid', changeableAt: null, offline: false } });
    ctl.go({ to: 'create' });
    expect(ctl.answerAge(2012)).toBe('refused');
    expect(store.getState().profile?.minor).toBe(true);
    await vi.waitFor(() => expect(markMinor).toHaveBeenCalledOnce());
  });

  it('a device that said under 18 before: the restored account is told at start; a new guest is made with the flag', async () => {
    answerAge(2012);
    const markMinor = vi.fn(async () => ({ ...me, minor: true as const }));
    const restore = vi.fn(async () => me);
    const { store, ctl } = controller({ restore, markMinor, me } as unknown as Partial<Api>);
    await ctl.boot();
    expect(store.getState().profile?.minor).toBe(true);
    await vi.waitFor(() => expect(markMinor).toHaveBeenCalledOnce());

    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse((init.body as string) ?? '{}') });
      return new Response(JSON.stringify({ accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshToken: 'r', user: { ...me, minor: true } }), { status: 201 });
    });
    await new Api('/api', fetchImpl as unknown as typeof fetch).guest('Kid', true);
    expect(calls[0]).toEqual({ url: '/api/auth/guest', body: { nickname: 'Kid', minor: true } });
  });

  it('a suspended account (refresh refused) keeps its token, trains, and is told why', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'account_disabled', message: 'x', until: '2026-11-02T12:00:00Z' } }), { status: 403 }));
    saved.set('session.refreshToken.v1', 's_x.y');
    const api = new Api('/api', fetchImpl as unknown as typeof fetch);
    expect(await api.restore()).toBeNull();
    expect(api.disabled).toEqual({ until: '2026-11-02T12:00:00Z' });
    expect(saved.get('session.refreshToken.v1')).toBe('s_x.y');
    answerAge(1995);
    const { store, ctl } = controller({ restore: async () => null, disabled: api.disabled } as unknown as Partial<Api>);
    await ctl.boot();
    expect(store.getState().profile).toMatchObject({ offline: true, suspended: { until: '2026-11-02T12:00:00Z' } });
    ctl.go({ to: 'create' });
    expect(store.getState().screen).toMatchObject({ name: 'error', alert: { title: "Can't play online right now" } });
  });
});
