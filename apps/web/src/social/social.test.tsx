import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../shell/api';
import { createShellStore, type Intent } from '../shell/store';
import { asFriendCode, type Friend, type FriendsList } from './api';
import { FriendRow, FriendsPanel } from './FriendsPanel';
import { SOCIAL_ICONS } from './icons';
import { SocialController, agoText, friendErrorText, onlineFriends, statusText, type SocialShell } from './social';

const NOW = Date.parse('2026-10-23T12:00:00Z');

function friend(id: string, nickname: string, status: Friend['status'], room: string | null = null): Friend {
  return { id, nickname, status, room, lastSeenAt: new Date(NOW - 2 * 3600_000).toISOString(), since: new Date(NOW).toISOString() };
}

function sampleList(): FriendsList {
  return {
    code: '7KQ4-M9XP',
    friends: [friend('u_k', 'Kemi', 'in_room', 'KMTXRA'), friend('u_t', 'Tunde', 'online'), friend('u_s', 'Seun', 'offline')],
    incoming: [{ id: 'u_b', nickname: 'Bisi', at: new Date(NOW).toISOString() }],
    outgoing: [{ id: 'u_a', nickname: 'Ade_07', at: new Date(NOW).toISOString() }],
    blocked: [],
    max: 200,
  };
}

/** A shell stand-in: a signed-in player, the API answering from `routes`, and what the controller asks of the shell. */
function fakeShell(routes: Record<string, (body: unknown) => unknown>) {
  const calls: string[] = [];
  const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
  const gone: Intent[] = [];
  const notices: string[] = [];
  const shell: SocialShell = {
    api: {
      authed: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        const key = `${method} ${path}`;
        calls.push(key);
        const route = routes[key];
        if (!route) throw new ApiError(404, 'not_found', `no route ${key}`);
        return route(body) as T;
      },
      onSignIn: () => () => {},
    },
    store,
    go: (intent) => gone.push(intent),
    notify: (m) => notices.push(m),
  };
  return { shell, calls, gone, notices, store };
}

describe('friend codes and words', () => {
  it('reads a typed friend code loosely and refuses what can never be one', () => {
    expect(asFriendCode('7kq4-m9xp')).toBe('7KQ4M9XP');
    expect(asFriendCode(' 7KQ4 M9XP ')).toBe('7KQ4M9XP');
    expect(asFriendCode('Kemi_Ops')).toBeNull();
    expect(asFriendCode('OKQ4M9XP')).toBeNull();
  });

  it("says where a friend is, and when they were last seen", () => {
    expect(statusText(friend('u', 'K', 'in_room', 'KMTXRA'), NOW)).toBe('In a match · room KMTXRA');
    expect(statusText(friend('u', 'T', 'online'), NOW)).toBe('Online · in the menus');
    expect(statusText(friend('u', 'S', 'offline'), NOW)).toBe('Last seen 2 h ago');
    expect(agoText(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
    expect(agoText(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago');
    expect(agoText(new Date(NOW - 4 * 86_400_000).toISOString(), NOW)).toBe('4 days ago');
    expect(onlineFriends(sampleList()).map((f) => f.nickname)).toEqual(['Kemi', 'Tunde']);
    expect(friendErrorText(new ApiError(404, 'player_not_found', 'x'))).toBe('No player has that name or friend code');
    expect(friendErrorText(new ApiError(0, 'network', 'x'))).toMatch(/Can't reach the server/);
  });
});

describe('SocialController', () => {
  it('loads the list, and opens and closes the panel at a tab', async () => {
    const { shell } = fakeShell({ 'GET /friends': () => sampleList() });
    const social = new SocialController(shell, null);
    await social.refresh();
    expect(social.store.getState().list?.friends).toHaveLength(3);
    social.openPanel('requests');
    expect(social.store.getState().panel).toEqual({ open: true, tab: 'requests' });
    social.closePanel();
    expect(social.store.getState().panel.open).toBe(false);
  });

  it('does nothing without a signed-in online player', async () => {
    const { shell, calls, store } = fakeShell({ 'GET /friends': () => sampleList() });
    store.setState({ profile: { nickname: 'Ade', changeableAt: null, offline: true } });
    const social = new SocialController(shell, null);
    await social.refresh();
    expect(calls).toEqual([]);
  });

  it('adds by code, and tries a code-shaped name as a name when no code matches', async () => {
    const asked: unknown[] = [];
    const { shell } = fakeShell({
      'GET /friends': () => sampleList(),
      'POST /friends/requests': (body) => {
        asked.push(body);
        if ((body as { code?: string }).code) throw new ApiError(404, 'player_not_found', 'no');
        return { status: 'requested', user: { id: 'u_x', nickname: 'ABCDEFGH', at: '' } };
      },
    });
    const social = new SocialController(shell, null);
    const outcome = await social.add('abcd-efgh');
    expect(asked).toEqual([{ code: 'ABCDEFGH' }, { name: 'abcd-efgh' }]);
    expect(outcome).toEqual({ tone: 'ok', message: 'Request sent to ABCDEFGH. It waits until they answer.' });
    expect(social.store.getState().added).toEqual(outcome);
  });

  it('says why an add failed', async () => {
    const { shell } = fakeShell({
      'POST /friends/requests': () => {
        throw new ApiError(409, 'blocked_by_you', 'blocked');
      },
    });
    const social = new SocialController(shell, null);
    expect(await social.add('Kemi')).toEqual({ tone: 'warn', message: 'You blocked this player: unblock them first (Blocked tab)' });
  });

  it('applies an action at once and puts it back (with a notice) when the API refuses', async () => {
    let fail = false;
    const { shell, notices } = fakeShell({
      'GET /friends': () => sampleList(),
      'DELETE /friends/u_t': () => {
        if (fail) throw new ApiError(500, 'internal_error', 'boom');
      },
      'POST /friends/requests/u_b/accept': () => ({ friend: friend('u_b', 'Bisi', 'online') }),
    });
    const social = new SocialController(shell, null);
    await social.refresh();
    const accepted = social.accept(sampleList().incoming[0]!);
    // optimistic: Bisi is a friend before the API answers
    expect(social.store.getState().list?.friends.map((f) => f.id)).toContain('u_b');
    expect(social.store.getState().list?.incoming).toEqual([]);
    expect(await accepted).toBe(true);

    await social.refresh();
    fail = true;
    const removed = social.remove({ id: 'u_t', nickname: 'Tunde' });
    expect(social.store.getState().list?.friends.map((f) => f.id)).not.toContain('u_t');
    expect(await removed).toBe(false);
    expect(social.store.getState().list?.friends.map((f) => f.id)).toContain('u_t');
    expect(notices).toEqual(["Can't reach the server. Try again in a moment"]);
  });

  it("blocks: off every list and onto Blocked; join goes to the friend's room by its code", async () => {
    const { shell, gone } = fakeShell({ 'GET /friends': () => sampleList(), 'POST /friends/blocks': () => undefined });
    const social = new SocialController(shell, null);
    await social.refresh();
    void social.block({ id: 'u_k', nickname: 'Kemi' });
    const list = social.store.getState().list!;
    expect(list.friends.map((f) => f.id)).not.toContain('u_k');
    expect(list.blocked.map((p) => p.id)).toEqual(['u_k']);
    social.join(friend('u_t', 'Tunde', 'in_room', 'QWERTY'));
    expect(gone).toEqual([{ to: 'join', code: 'QWERTY' }]);
  });

  it('keeps the list fresh while watched, at the shortest interval asked for', async () => {
    vi.useFakeTimers();
    try {
      const { shell, calls } = fakeShell({ 'GET /friends': () => sampleList() });
      const social = new SocialController(shell, null);
      const stopHome = social.watch(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      const stopPanel = social.watch(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toHaveLength(2);
      stopPanel();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toHaveLength(3);
      stopHome();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the panel', () => {
  it('shows your code, the requests on top, then in a match / online / offline', async () => {
    const { shell } = fakeShell({ 'GET /friends': () => sampleList() });
    const social = new SocialController(shell, null);
    await social.refresh();
    social.openPanel('friends');
    const html = renderToStaticMarkup(<FriendsPanel social={social} />);
    expect(html).toContain('7KQ4-M9XP');
    expect(html).toContain('Wants to be friends');
    const order = ['Requests · 1', 'In a match · 1', 'Online · 1', 'Offline · 1'].map((t) => html.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('In a match · room KMTXRA');
    expect(html).toContain('Friends see your status and your room. Nobody else does.');
  });

  it('is closed until opened, and a friend in a room has Join', async () => {
    const { shell } = fakeShell({ 'GET /friends': () => sampleList() });
    const social = new SocialController(shell, null);
    expect(renderToStaticMarkup(<FriendsPanel social={social} />)).toBe('');
    const row = renderToStaticMarkup(<FriendRow social={social} friend={friend('u_k', 'Kemi', 'in_room', 'KMTXRA')} />);
    expect(row).toContain('>Join<');
    expect(renderToStaticMarkup(<FriendRow social={social} friend={friend('u_t', 'Tunde', 'online')} />)).not.toContain('>Join<');
  });

  it('draws its own icons in the kit style', () => {
    expect(SOCIAL_ICONS).toEqual(expect.arrayContaining(['sx-friends', 'sx-mic', 'sx-mic-off', 'sx-ban', 'sx-dots']));
  });
});
