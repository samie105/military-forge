/**
 * The Lobby feed on the web (feed/): its states (loading, error, offline, empty, quiet), the cards and
 * their one-tap replies, mutes and "Hide public chat" hiding players' lines, the owner's chat mute shown
 * with its reason and end, no text box while free text is off, a message's Report opening the Report
 * sheet with place chat and the message, sending and its limits in words, and the unread dot.
 */
import type { LobbyEntry } from '@military-forge/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../shell/api';
import { ControllerContext } from '../shell/context';
import { createShellStore } from '../shell/store';
import { PlayerSheet } from '../social/ReportSheet';
import { socialOf, type SocialShell } from '../social/social';
import { FeedController, feedOf, quietLine, sendErrorText, type FeedResponse } from './feed';
import { LobbyButton, LobbyPanel } from './LobbyFeed';

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

const NOW = Date.parse('2026-11-01T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function feedBody(over: Partial<FeedResponse> = {}, me: Partial<FeedResponse['me']> = {}): FeedResponse {
  return {
    entries: [],
    now: new Date(NOW).toISOString(),
    lastMatchAt: iso(3 * HOUR),
    fightNight: { startsAt: '2026-11-01T19:00:00.000Z', endsAt: '2026-11-01T21:00:00.000Z', live: false },
    me: { mute: null, freeText: { on: false, allowed: false, needs: [] }, ...me },
    ...over,
  };
}

const chat = (id: string, from: string, quick: string, text: string, msAgo = 5 * MIN): LobbyEntry => ({ kind: 'chat', id, at: iso(msAgo), from: { id: `u_${from.toLowerCase()}`, name: from }, quick: quick as never, text, replyTo: null });

function fakeShell(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { key: string; body: unknown }[] = [];
  const notices: string[] = [];
  const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
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
    go: () => {},
    notify: (m) => notices.push(m),
  };
  return { shell, calls, notices, store };
}

function setup(routes: Record<string, (body: unknown) => unknown> = {}) {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const s = fakeShell({ 'GET /lobby': () => feedBody(), ...routes });
  const feed = feedOf(s.shell);
  const social = socialOf(s.shell);
  const render = () => textOf(renderToStaticMarkup(<ControllerContext.Provider value={s.shell as never}><LobbyPanel feed={feed} social={social} /></ControllerContext.Provider>));
  return { ...s, feed, social, render };
}

afterEach(() => vi.useRealTimers());

describe("the panel's states", () => {
  it('loading, then the error and offline states with Try again; nothing while closed', async () => {
    const { feed, render } = setup({ 'GET /lobby': () => new Promise(() => {}) });
    expect(render()).toBe('');
    feed.open();
    expect(render()).toContain('Loading the Lobby…');

    const bad = setup({ 'GET /lobby': () => Promise.reject(new ApiError(500, 'internal_error', 'boom')) });
    bad.feed.open();
    await bad.feed.load();
    expect(bad.render()).toContain('The Lobby needs a connection');
    expect(bad.render()).toContain('Try again');

    const err = setup({ 'GET /lobby': () => Promise.reject(new ApiError(400, 'invalid_request', 'no')) });
    err.feed.open();
    await err.feed.load();
    expect(err.render()).toContain('The Lobby didn’t load');
  });

  it('empty: says so plainly, with Fight night pinned (and no fake activity)', async () => {
    const { feed, render } = setup({ 'GET /lobby': () => feedBody({ lastMatchAt: null }) });
    feed.open();
    await feed.load();
    const text = render();
    expect(text).toContain('Nothing here yet today.');
    expect(text).toContain('Fight night');
    expect(text).toContain('Every day 20:00–22:00 WAT');
    expect(text).toContain('Starts in 7 h');
    expect(text).toContain('Remind me');
  });

  it('quiet: the honest line when nobody has spoken for an hour', async () => {
    const card: LobbyEntry = { kind: 'match_result', id: '4', winnerId: 'u_kemi', winnerName: 'Kemi', mode: 'deathmatch', map: 'street-market', people: 2, bots: 2, at: iso(3 * HOUR) };
    const { feed, render } = setup({ 'GET /lobby': () => feedBody({ entries: [chat('3', 'Tobi', 'how_far', 'How far?', 2 * HOUR), card] }) });
    feed.open();
    await feed.load();
    const text = render();
    expect(text).toContain('Quiet right now. Last match 3 h ago.');
    expect(text).toContain('Kemi won on Street Market');
    expect(text).toContain('2 players, 2 bots');
    // its one-tap replies
    for (const r of ['GG', 'Nice shot', 'Rematch?']) expect(text).toContain(r);
    expect(quietLine([chat('9', 'Tobi', 'gg', 'GG', 10 * MIN)], null, NOW)).toBeNull();
    expect(quietLine([], null, NOW)).toBe('Quiet right now. No matches yet today.');
  });

  it("a bot's win names nobody; a room card has Join; a welcome asks to say welcome", async () => {
    const entries: LobbyEntry[] = [
      { kind: 'match_result', id: '1', winnerId: null, winnerName: null, mode: 'deathmatch', map: 'street-market', people: 1, bots: 3, at: iso(HOUR) },
      { kind: 'room_posted', id: '2', code: 'KMTXRA', hostName: 'Kemi', mode: 0, map: 'street-market', people: 2, bots: 2, seats: 4, tag: 'new', lang: 'yo', at: iso(MIN) },
      { kind: 'room_posted', id: '5', code: 'OLDOLD', hostName: 'Tobi', mode: 2, map: null, people: 1, bots: null, seats: 7, tag: null, lang: null, at: iso(2 * HOUR) },
      { kind: 'welcome', id: '3', playerId: 'u_tobi', name: 'Tobi', at: iso(MIN) },
    ];
    const { feed, render } = setup({ 'GET /lobby': () => feedBody({ entries }) });
    feed.open();
    await feed.load();
    const text = render();
    expect(text).toContain('A bot took Street Market');
    expect(text).toContain('Kemi opened a room · New players welcome');
    expect(text).toContain('Street Market · Free-for-all · 2 players, 2 bots · 4 seats free · Yorùbá · room KMTXRA');
    expect(text).toContain('Tobi opened a room');
    expect(text).toContain('2 teams · 1 player · 7 seats free · room OLDOLD');
    // only the fresh room offers Join (a posted room may have moved on after 30 minutes)
    expect(text.match(/Join/g)).toHaveLength(1);
    expect(text).toContain('Tobi joined · say welcome');
  });
});

describe('what you hide', () => {
  it('a player muted in the Lobby, and Hide public chat, hide players’ lines (cards stay); kept on this device', async () => {
    const entries = [chat('1', 'Pest', 'join_my_room', 'Join my room'), chat('2', 'Kemi', 'gg', 'GG'), { kind: 'welcome', id: '3', playerId: 'u_tobi', name: 'Tobi', at: iso(MIN) } as LobbyEntry];
    const { feed, render, notices, shell } = setup({ 'GET /lobby': () => feedBody({ entries }) });
    feed.open();
    await feed.load();
    expect(render()).toContain('Join my room');
    feed.mute('u_pest', 'Pest');
    expect(render()).not.toContain('Join my room');
    expect(render()).toContain('Muted here · 1');
    expect(notices.at(-1)).toBe('Pest is muted in the Lobby on this device');
    // a new controller on this device remembers
    expect(new FeedController(shell, null).store.getState().muted).toEqual({ u_pest: 'Pest' });
    feed.setHideChat(true);
    const hidden = render();
    expect(hidden).not.toContain('GG');
    expect(hidden).toContain('Tobi joined');
    expect(hidden).toContain('Public chat is hidden on this device');
    expect(hidden).not.toContain('Quick chat');
    feed.unmute('u_pest');
    feed.setHideChat(false);
    expect(render()).toContain('Join my room');
  });

  it("the owner's chat mute: the reason and how long, and no way to post", async () => {
    const { feed, render } = setup({ 'GET /lobby': () => feedBody({}, { mute: { until: new Date(NOW + 2 * HOUR).toISOString(), reason: 'Spamming the Lobby' } }) });
    feed.open();
    await feed.load();
    const text = render();
    expect(text).toContain('You can’t post in the Lobby for 2 h.');
    expect(text).toContain('Reason: Spamming the Lobby.');
    expect(text).not.toContain('Quick chat');
  });
});

describe('free text', () => {
  it('off (the default): no text box at all, only Quick chat', async () => {
    const { feed, render } = setup();
    feed.open();
    await feed.load();
    const html = renderToStaticMarkup(<LobbyPanel feed={feed} social={socialOf(feed.shell as never)} />);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('textarea');
    expect(render()).toContain('Quick chat');
    expect(await feed.sendText('hello')).toBe(false);
  });

  it('on and allowed: a box; on but locked: what it takes', async () => {
    const on = setup({ 'GET /lobby': () => feedBody({}, { freeText: { on: true, allowed: true, needs: [] } }) });
    on.feed.open();
    await on.feed.load();
    expect(renderToStaticMarkup(<LobbyPanel feed={on.feed} social={on.social} />)).toContain('<input');
    const locked = setup({ 'GET /lobby': () => feedBody({}, { freeText: { on: true, allowed: false, needs: ['account'] } }) });
    locked.feed.open();
    await locked.feed.load();
    expect(locked.render()).toContain('Typing opens after a day and 3 online matches');
  });
});

describe('saying something', () => {
  it('a phrase goes by its id; the answer joins the feed; limits come back in words', async () => {
    let n = 10;
    const { feed, calls } = setup({
      'POST /lobby/messages': (body) => {
        const b = body as { quick: string };
        if (b.quick === 'nice_shot') throw new ApiError(429, 'slow_down', 'slow', { retryAfter: 3 });
        if (b.quick === 'gg') return { dropped: 'repeat' };
        return { entry: chat(String(++n), 'Ade', b.quick, 'How far?', 0) };
      },
    });
    feed.open();
    await feed.load();
    expect(await feed.send('how_far', '3')).toBe(true);
    expect(calls.at(-1)).toEqual({ key: 'POST /lobby/messages', body: { quick: 'how_far', replyTo: '3' } });
    expect(feed.store.getState().entries.map((e) => e.id)).toEqual(['11']);
    await feed.send('nice_shot');
    expect(feed.store.getState().notice).toBe('One message every 3 seconds');
    await feed.send('gg');
    expect(feed.store.getState().notice).toBe('You just said that');
    expect(sendErrorText(new ApiError(429, 'rate_limited', 'x', { retryAfter: 40 }))).toBe('That’s a lot of messages. Wait 40 s');
  });

  it('a muted answer turns into the mute notice', async () => {
    const until = new Date(NOW + HOUR).toISOString();
    const { feed } = setup({ 'POST /lobby/messages': () => Promise.reject(new ApiError(403, 'chat_muted', 'no', { until, reason: 'Spam' })) });
    feed.open();
    await feed.load();
    await feed.send('hi');
    expect(feed.store.getState().mute).toEqual({ until, reason: 'Spam' });
  });

  it("a message's Report opens the Report sheet with place chat, and the report names the message", async () => {
    const { feed, social, shell, calls } = setup({ 'GET /lobby': () => feedBody({ entries: [chat('7', 'Pest', 'join_my_room', 'Join my room')] }), 'POST /reports/player': () => ({ id: 1 }) });
    feed.open();
    await feed.load();
    social.openReport({ name: 'Pest', id: 'u_pest', place: 'chat', messageId: '7' });
    const sheet = textOf(renderToStaticMarkup(<ControllerContext.Provider value={shell as never}><PlayerSheet social={social} /></ControllerContext.Provider>));
    expect(sheet).toContain("What's wrong with Pest's message?");
    expect(sheet).toContain('Spamming the Lobby');
    expect(sheet).not.toContain('Abusive voice');
    await social.sendReport('spam', '');
    expect(calls.at(-1)).toEqual({ key: 'POST /reports/player', body: { id: 'u_pest', reason: 'spam', place: 'chat', message: '7' } });
  });
});

describe('the unread dot', () => {
  it('shows when a newer line exists than the last one seen here; opening clears it', async () => {
    let head = '12';
    const { feed, shell } = setup({ 'GET /lobby/head': () => ({ id: head }), 'GET /lobby': () => feedBody({ entries: [chat('12', 'Kemi', 'gg', 'GG')] }) });
    const button = () => renderToStaticMarkup(<ControllerContext.Provider value={shell as never}><LobbyButton /></ControllerContext.Provider>);
    await feed.checkHead();
    expect(feed.store.getState().unread).toBe(true);
    expect(button()).toContain('Lobby, new messages');
    feed.open();
    await feed.load();
    feed.close();
    await feed.checkHead();
    expect(feed.store.getState().unread).toBe(false);
    head = '13';
    await feed.checkHead();
    expect(feed.store.getState().unread).toBe(true);
    // live lines while closed light it too; open lines don't
    feed.onEvent('lobby_entry', { entry: chat('14', 'Tobi', 'hi', 'Hi all') });
    expect(feed.store.getState().entries.at(-1)?.id).toBe('14');
    feed.onEvent('lobby_remove', { id: '14' });
    expect(feed.store.getState().entries.map((e) => e.id)).toEqual(['12']);
  });

  it('an under-18 or offline profile gets no Lobby button at all', () => {
    const { shell, store } = setup();
    store.setState({ profile: { nickname: 'Kid', changeableAt: null, offline: false, minor: true } });
    expect(renderToStaticMarkup(<ControllerContext.Provider value={shell as never}><LobbyButton /></ControllerContext.Provider>)).toBe('');
    store.setState({ profile: { nickname: 'Ade', changeableAt: null, offline: true } });
    expect(renderToStaticMarkup(<ControllerContext.Provider value={shell as never}><LobbyButton /></ControllerContext.Provider>)).toBe('');
  });
});
