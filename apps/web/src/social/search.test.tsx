/**
 * Finding players (31 Oct): the panel's name search and its states, the Add / Request sent / Accept /
 * Friends buttons, Played with recently, the friend request toast (audit C-26), the stale "Request
 * sent" line and lobby presence (C-27), and "Let players find me by name".
 */
import { MatchPhase } from '@military-forge/sim';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../shell/api';
import { createShellStore } from '../shell/store';
import type { FoundPlayer, Friend, FriendsList, Person } from './api';
import { FindMeSetting } from './FindMe';
import { FriendsPanel } from './FriendsPanel';
import { RequestToast } from './RequestToast';
import { SEARCH_DEBOUNCE_MS, SocialController, addedText, searchErrorText, searchLetters, type SocialShell } from './social';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function friend(id: string, nickname: string, over: Partial<Friend> = {}): Friend {
  return { id, nickname, status: 'online', room: null, lastSeenAt: iso(NOW), since: iso(NOW), look: null, ...over };
}
const person = (id: string, nickname: string, at = NOW): Person => ({ id, nickname, at: iso(at), look: null });
const found = (id: string, nickname: string, relation: FoundPlayer['relation'] = 'none', over: Partial<FoundPlayer> = {}): FoundPlayer => ({ id, nickname, level: 4, look: null, relation, ...over });

function list(over: Partial<FriendsList> = {}): FriendsList {
  return { code: '7KQ4-M9XP', friends: [friend('u_f', 'Femi')], incoming: [person('u_i', 'Ife', NOW - 3600_000)], outgoing: [person('u_s', 'Sola')], blocked: [], max: 200, findable: true, ...over };
}

/** A shell stand-in answering from `routes` (a function per `METHOD path`, the query left off). */
function fakeShell(routes: Record<string, (body: unknown, path: string) => unknown>) {
  const calls: string[] = [];
  const notices: string[] = [];
  const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
  const shell: SocialShell = {
    api: {
      authed: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push(`${method} ${path}`);
        const route = routes[`${method} ${path.split('?')[0]}`];
        if (!route) throw new ApiError(404, 'not_found', `no route ${method} ${path}`);
        return route(body, path) as T;
      },
      onSignIn: () => () => {},
    },
    store,
    go: () => {},
    notify: (m) => notices.push(m),
  };
  return { shell, calls, notices, store };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('the name search', () => {
  it('waits for 2 letters, asks once after the typing stops, and keeps answers a minute', async () => {
    const { shell, calls } = fakeShell({ 'GET /friends/search': (_b, path) => ({ players: path.includes('kem') ? [found('u_k', 'Kemi')] : [] }) });
    const social = new SocialController(shell, null);
    expect(searchLetters(' k_ ')).toBe(1);
    social.setQuery('k');
    expect(social.store.getState().search.status).toBe('short');
    social.setQuery('ke');
    social.setQuery('kem');
    expect(social.store.getState().search.status).toBe('busy');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(calls).toEqual(['GET /friends/search?q=kem']);
    expect(social.store.getState().search).toMatchObject({ status: 'done', players: [{ nickname: 'Kemi' }] });
    // backspace and type it again: the answer from a moment ago, no new request
    social.setQuery('ke');
    social.setQuery('kem');
    expect(social.store.getState().search.status).toBe('done');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    // ("ke" never went out: the next key came within the wait)
    expect(calls).toEqual(['GET /friends/search?q=kem']);
    social.clearSearch();
    expect(social.store.getState().search.status).toBe('idle');
  });

  it("only the latest answer lands, and failures say why in the owner's words", async () => {
    let fail: ApiError | null = null;
    const { shell } = fakeShell({
      'GET /friends/search': () => {
        if (fail) throw fail;
        return { players: [] };
      },
    });
    const social = new SocialController(shell, null);
    fail = new ApiError(0, 'network', 'x');
    social.setQuery('zz');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(social.store.getState().search).toMatchObject({ status: 'failed', error: "Can't reach the server. Check your connection and try again." });
    fail = new ApiError(429, 'rate_limited', 'slow down', { retryAfter: 42 });
    social.setQuery('zzz');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(social.store.getState().search.error).toBe('Too many searches in a row. Wait 42 s and try again.');
    expect(searchErrorText(new ApiError(429, 'rate_limited', 'x', { retryAfter: 3000 }))).toBe('Too many searches in a row. Wait a few minutes and try again.');
  });

  it('shows each state in the panel: too short, searching, none, the players with what you can do', async () => {
    const players = [found('u_n', 'Kemi_A'), found('u_s', 'Sola', 'sent'), found('u_i', 'Ife', 'incoming'), found('u_f', 'Femi', 'friends')];
    let answer: FoundPlayer[] = [];
    const { shell } = fakeShell({ 'GET /friends': () => list(), 'GET /friends/recent': () => ({ players: [] }), 'GET /friends/search': () => ({ players: answer }) });
    const social = new SocialController(shell, null);
    await social.refresh();
    social.openPanel('friends');
    const html = () => renderToStaticMarkup(<FriendsPanel social={social} />);
    social.setQuery('k');
    expect(html()).toContain('Type at least 2 letters of their name.');
    expect(html()).not.toContain('role="tablist"');
    social.setQuery('qq');
    expect(html()).toContain('Searching…');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(html()).toContain('No player&#x27;s name starts with &quot;qq&quot;.');
    answer = players;
    social.setQuery('qqq');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    const out = html();
    expect(out).toContain('Players · 4');
    expect(out).toContain('aria-label="Add Kemi_A as a friend"');
    expect(out).toContain('Request sent');
    expect(out).toContain('aria-label="Accept Ife&#x27;s request"');
    expect(out).toMatch(/Friends<\/span>/);
    // a friend code shape says how to add by it
    social.setQuery('7KQ4-M9XP');
    expect(html()).toContain('That looks like a friend code: press Send to add it.');
  });

  it('Add sends the request by name: Request sent at once, back to Add when refused', async () => {
    let refuse = false;
    const asked: unknown[] = [];
    const { shell, notices } = fakeShell({
      'GET /friends': () => list(),
      'POST /friends/requests': (body) => {
        asked.push(body);
        if (refuse) throw new ApiError(0, 'network', 'x');
        return { status: 'requested', user: person('u_n', 'Kemi_A') };
      },
    });
    const social = new SocialController(shell, null);
    await social.refresh();
    const p = found('u_n', 'Kemi_A');
    const sent = social.addPlayer(p);
    expect(social.relationOf(p)).toBe('sent');
    expect(await sent).toBe(true);
    expect(asked).toEqual([{ name: 'Kemi_A' }]);
    expect(notices).toEqual(['Request sent to Kemi_A']);
    refuse = true;
    const q = found('u_q', 'Quinn');
    expect(await social.addPlayer(q)).toBe(false);
    expect(social.relationOf(q)).toBe('none');
    expect(notices.at(-1)).toBe("Can't reach the server. Try again in a moment");
  });

  it('where you stand follows the friends list, not the search it came from (audit C-27)', async () => {
    let l = list();
    const { shell } = fakeShell({ 'GET /friends': () => l });
    const social = new SocialController(shell, null);
    await social.refresh();
    const sola = found('u_s', 'Sola', 'sent');
    expect(social.relationOf(sola)).toBe('sent');
    // Sola accepted on her side: the push channel's "friends" reloads the list
    l = list({ outgoing: [], friends: [friend('u_f', 'Femi'), friend('u_s', 'Sola')] });
    social.onEvent('friends', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(social.relationOf(sola)).toBe('friends');
    // and the line under the field says so instead of "Request sent"
    expect(addedText({ tone: 'ok', message: 'Request sent to Sola. It waits until they answer.', to: { id: 'u_s', nickname: 'Sola' } }, l)).toEqual({ tone: 'ok', message: "Sola accepted: you're friends now" });
  });
});

describe('played with recently', () => {
  it('loads when the panel opens and lists who is not a friend yet, with Add', async () => {
    const { shell } = fakeShell({
      'GET /friends': () => list(),
      'GET /friends/recent': () => ({ players: [found('u_r', 'Rex', 'none', { at: iso(NOW - 2 * 3600_000) }), found('u_f', 'Femi', 'friends', { at: iso(NOW) })] }),
    });
    const social = new SocialController(shell, null);
    await social.refresh();
    social.openPanel('friends');
    await vi.advanceTimersByTimeAsync(0);
    const html = renderToStaticMarkup(<FriendsPanel social={social} />);
    expect(html).toContain('Played with recently · 1');
    expect(html).toContain('Played 2 h ago');
    expect(html).toContain('aria-label="Add Rex as a friend"');
  });
});

describe('the friend request toast (audit C-26)', () => {
  it('pops for a request that arrives, not for old ones, never twice, and not over the open panel', async () => {
    let l = list();
    const { shell } = fakeShell({ 'GET /friends': () => l, 'GET /friends/recent': () => ({ players: [] }) });
    const social = new SocialController(shell, null);
    await social.refresh();
    // Ife's request is an hour old: it was waiting already, no toast
    expect(social.store.getState().requestToasts).toEqual([]);
    l = list({ incoming: [person('u_new', 'Bisi'), person('u_i', 'Ife', NOW - 3600_000)] });
    social.onEvent('friends', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(social.store.getState().requestToasts.map((p) => p.nickname)).toEqual(['Bisi']);
    const html = renderToStaticMarkup(<RequestToast social={social} />);
    expect(html).toContain('Bisi wants to be friends');
    expect(html).toContain('>Accept<');
    expect(html).toContain('aria-label="Later: keep it in Friends"');
    social.hideRequestToast('u_new');
    expect(renderToStaticMarkup(<RequestToast social={social} />)).toBe('');
    await social.refresh();
    expect(social.store.getState().requestToasts).toEqual([]);
    // with the panel open the request shows there instead
    l = list({ incoming: [person('u_new2', 'Tobi'), ...l.incoming] });
    social.openPanel('friends');
    await social.refresh();
    expect(social.store.getState().requestToasts).toEqual([]);
  });

  it('a fresh request on the first load counts; mid-match it takes the in-play spot and goes sooner', async () => {
    const { shell, store } = fakeShell({ 'GET /friends': () => list({ incoming: [person('u_new', 'Bisi', NOW - 20_000)] }) });
    const social = new SocialController(shell, null);
    await social.refresh();
    expect(social.store.getState().requestToasts.map((p) => p.id)).toEqual(['u_new']);
    store.setState({ screen: { name: 'room', code: 'KMTXRA' } as never, match: { phase: MatchPhase.InProgress } as never, overlay: null });
    expect(renderToStaticMarkup(<RequestToast social={social} />)).toContain('sx-toast--play');
  });

  it('gives way to an invite', async () => {
    const { shell } = fakeShell({ 'GET /friends': () => list({ incoming: [person('u_new', 'Bisi', NOW - 20_000)] }) });
    const social = new SocialController(shell, null);
    await social.refresh();
    social.onEvent('invite', { invite: { id: 'i1', from: { id: 'u_f', nickname: 'Femi' }, to: { id: 'me', nickname: 'Ade' }, room: 'KMTXRA', at: iso(NOW), expiresAt: iso(NOW + 120_000) } });
    expect(renderToStaticMarkup(<RequestToast social={social} />)).toBe('');
  });
});

describe('lobby or match (audit C-27)', () => {
  it('a friend moving from the lobby into the match is told by the push channel', async () => {
    const { shell } = fakeShell({ 'GET /friends': () => list({ friends: [friend('u_h', 'Host', { status: 'in_room', room: 'KMTXRA', playing: false })] }) });
    const social = new SocialController(shell, null);
    await social.refresh();
    social.openPanel('friends');
    expect(renderToStaticMarkup(<FriendsPanel social={social} />)).toContain('In the lobby · room KMTXRA');
    social.onEvent('presence', { id: 'u_h', status: 'in_room', room: 'KMTXRA', playing: true });
    expect(renderToStaticMarkup(<FriendsPanel social={social} />)).toContain('In a match · room KMTXRA');
  });
});

describe('"Let players find me by name"', () => {
  it('switches at once and goes back (with a notice) when the API refuses', async () => {
    let refuse = false;
    const { shell, notices } = fakeShell({
      'GET /friends': () => list(),
      'PUT /friends/settings': (body) => {
        if (refuse) throw new ApiError(0, 'network', 'x');
        return body;
      },
    });
    const social = new SocialController(shell, null);
    await social.refresh();
    expect(await social.setFindable(false)).toBe(true);
    expect(social.store.getState().list?.findable).toBe(false);
    refuse = true;
    const back = social.setFindable(true);
    expect(social.store.getState().list?.findable).toBe(true);
    expect(await back).toBe(false);
    expect(social.store.getState().list?.findable).toBe(false);
    expect(notices).toEqual(["Can't reach the server. Try again in a moment"]);
  });

  it('is a Privacy row only where friends work', () => {
    expect(renderToStaticMarkup(<FindMeSetting />)).toBe('');
  });
});
