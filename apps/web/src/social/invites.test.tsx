import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../shell/api';
import { createShellStore, type Intent, type Screen } from '../shell/store';
import type { Invite } from './api';
import { EventStream, parseSse } from './events';
import { InvitePicker, InviteToast, watchInvite } from './Invites';
import { SocialController, badgeCount, clockText, secondsLeft, type SocialShell } from './social';

afterEach(() => vi.useRealTimers());

function anInvite(id: string, from = 'Kemi', room = 'OPSDEK', seconds = 120): Invite {
  const at = Date.now();
  return { id, from: { id: `u_${from}`, nickname: from }, to: { id: 'u_me', nickname: 'Ade' }, room, at: new Date(at).toISOString(), expiresAt: new Date(at + seconds * 1000).toISOString() };
}

function fakeShell(routes: Record<string, (body: unknown) => unknown>, screen: Screen = { name: 'home' }) {
  const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false }, screen });
  const gone: Intent[] = [];
  const notices: string[] = [];
  const left: string[] = [];
  const shell: SocialShell = {
    api: {
      authed: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        const route = routes[`${method} ${path}`];
        if (!route) throw new ApiError(404, 'not_found', `no route ${method} ${path}`);
        return route(body) as T;
      },
      onSignIn: () => () => {},
    },
    store,
    host: { online: { leave: () => left.push('left') } },
    go: (intent) => gone.push(intent),
    notify: (m) => notices.push(m),
  };
  return { shell, gone, notices, left, store };
}

describe('the push channel client', () => {
  it('parses SSE frames, keeps a partial one for later, and skips comments', () => {
    const { frames, rest } = parseSse('event: hello\ndata: {"a":1}\n\n: ping\n\nevent: invite\ndata: {"b"');
    expect(frames).toEqual([{ event: 'hello', data: '{"a":1}' }]);
    expect(rest).toBe('event: invite\ndata: {"b"');
    expect(parseSse('data: x\r\ndata: y\r\n\r\n').frames).toEqual([{ event: 'message', data: 'x\ny' }]);
  });

  it('delivers events, says when it is live, and opens again when the server ends the stream', async () => {
    const seen: [string, unknown][] = [];
    const states: boolean[] = [];
    let opens = 0;
    const body = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
    const api = {
      stream: async () => {
        opens++;
        if (opens > 2) return new Promise<Response>(() => {}); // the third stays open
        return new Response(body(`event: hello\ndata: {}\n\nevent: invite\ndata: {"n":${opens}}\n\n`), { status: 200 });
      },
    };
    const s = new EventStream(api, (type, data) => seen.push([type, data]), (on) => states.push(on), null);
    s.start();
    for (let i = 0; i < 50 && opens < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([
      ['invite', { n: 1 }],
      ['invite', { n: 2 }],
    ]);
    expect(states).toEqual([true, false, true, false]);
    s.stop();
  });

  it('backs off after a failure instead of hammering the server', async () => {
    vi.useFakeTimers();
    let opens = 0;
    const s = new EventStream({ stream: async () => (opens++, new Response(null, { status: 503 })) }, () => {}, () => {}, null);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(opens).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(opens).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toBe(2);
    s.stop();
  });
});

describe('invites in the SocialController', () => {
  it('an invite event lights the badge and the toast; the panel opening counts it seen', () => {
    const { shell } = fakeShell({});
    const social = new SocialController(shell, null);
    social.onEvent('invite', { type: 'invite', invite: anInvite('i_1') });
    social.onEvent('invite', { type: 'invite', invite: anInvite('i_1') }); // the same one again: once
    expect(social.store.getState().invites.map((i) => i.id)).toEqual(['i_1']);
    expect(badgeCount(social.store.getState())).toBe(1);
    expect(secondsLeft(social.store.getState().invites[0]!)).toBe(120);
    social.openPanel();
    expect(social.store.getState().unseen).toBe(0);
    social.onEvent('invite_gone', { id: 'i_1' });
    expect(social.store.getState().invites).toEqual([]);
  });

  it('Join answers the invite, leaves the room you were in for good, then joins by code; Decline just drops it', async () => {
    const answered: string[] = [];
    const { shell, gone, left } = fakeShell(
      {
        'POST /invites/i_1/accept': () => (answered.push('accept'), { invite: anInvite('i_1'), room: 'OPSDEK', party: true }),
        'POST /invites/i_2/decline': () => void answered.push('decline'),
      },
      { name: 'room', code: 'KMTXRA' },
    );
    const social = new SocialController(shell, null);
    social.onEvent('invite', { invite: anInvite('i_1') });
    social.onEvent('invite', { invite: anInvite('i_2', 'Tunde', 'QWERTY') });
    expect(await social.acceptInvite(social.store.getState().invites.find((i) => i.id === 'i_1')!)).toBe(true);
    expect(left).toEqual(['left']);
    expect(gone).toEqual([{ to: 'join', code: 'OPSDEK' }]);
    await social.declineInvite(social.store.getState().invites[0]!);
    expect(answered).toEqual(['accept', 'decline']);
    expect(social.store.getState().invites).toEqual([]);
  });

  it('a run-out invite says so instead of joining', async () => {
    const { shell, gone, notices } = fakeShell({
      'POST /invites/i_1/accept': () => {
        throw new ApiError(404, 'invite_not_found', 'gone');
      },
    });
    const social = new SocialController(shell, null);
    social.onEvent('invite', { invite: anInvite('i_1') });
    expect(await social.acceptInvite(social.store.getState().invites[0]!)).toBe(false);
    expect(gone).toEqual([]);
    expect(notices).toEqual(['That invite has run out']);
  });

  it('invites from your room; the answer shows on your side', async () => {
    const { shell } = fakeShell({ 'POST /invites': (body) => ({ invite: { ...anInvite('i_9'), to: { id: (body as { to: string }).to, nickname: 'Tunde' }, room: (body as { room: string }).room } }) }, { name: 'room', code: 'KMTXRA' });
    const social = new SocialController(shell, null);
    expect(await social.invite({ id: 'u_t', nickname: 'Tunde' })).toBe(true);
    expect(social.store.getState().sent.u_t).toMatchObject({ id: 'i_9', room: 'KMTXRA' });
    social.onEvent('invite_answered', { id: 'i_9', to: 'u_t', answer: 'declined' });
    expect(social.store.getState().sent.u_t?.answer).toBe('declined');
  });

  it("can't invite from outside a room", async () => {
    const { shell } = fakeShell({});
    const social = new SocialController(shell, null);
    expect(await social.invite({ id: 'u_t', nickname: 'Tunde' })).toBe(false);
  });

  it('invites run out after their 2 minutes', async () => {
    vi.useFakeTimers();
    const { shell } = fakeShell({});
    const social = new SocialController(shell, null);
    social.onEvent('invite', { invite: anInvite('i_1', 'Kemi', 'OPSDEK', 3) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(social.store.getState().invites).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(social.store.getState().invites).toEqual([]);
    expect(social.store.getState().unseen).toBe(0);
  });

  it("a friend's status change moves them in the list without a reload", async () => {
    const { shell } = fakeShell({
      'GET /friends': () => ({
        code: 'X',
        friends: [
          { id: 'u_a', nickname: 'Ade', status: 'online', room: null, lastSeenAt: null, since: '' },
          { id: 'u_b', nickname: 'Bisi', status: 'online', room: null, lastSeenAt: null, since: '' },
        ],
        incoming: [],
        outgoing: [],
        blocked: [],
        max: 200,
      }),
    });
    const social = new SocialController(shell, null);
    await social.refresh();
    social.onEvent('presence', { id: 'u_b', status: 'in_room', room: 'KMTXRA' });
    expect(social.store.getState().list!.friends.map((f) => [f.nickname, f.status, f.room])).toEqual([
      ['Bisi', 'in_room', 'KMTXRA'],
      ['Ade', 'online', null],
    ]);
  });
});

describe('the toast and the picker', () => {
  it('the toast: who, which room, the time left, Join / Decline, and Watch', () => {
    const { shell } = fakeShell({}, { name: 'room', code: 'KMTXRA' });
    const social = new SocialController(shell, null);
    social.onEvent('invite', { invite: anInvite('i_1') });
    const html = renderToStaticMarkup(<InviteToast social={social} />);
    expect(html).toContain('Join Kemi in');
    expect(html).toContain('OPSDEK');
    expect(html).toContain(clockText(120));
    // Watch (v20 spectating): on, no "Soon" tag
    expect(html).toMatch(/<button type="button" class="btn btn--ghost btn--sm sx-act sx-watch" data-hook="watch"[^>]*>/);
    expect(html).not.toMatch(/disabled=""[^>]*data-hook="watch"/);
    expect(html).not.toContain('Soon');
    expect(html).not.toContain('Joining leaves this match'); // in the lobby: nothing to leave yet
    social.hideInvite(social.store.getState().invites[0]!);
    expect(renderToStaticMarkup(<InviteToast social={social} />)).toBe('');
  });

  it("Watch takes the invite's room as a spectator: the toast goes, the invite stays, a room we're in is left first", () => {
    const { shell, gone, left } = fakeShell({}, { name: 'room', code: 'KMTXRA' });
    const social = new SocialController(shell, null);
    social.onEvent('invite', { invite: anInvite('i_1') });
    const inv = social.store.getState().invites[0]!;
    watchInvite(social, inv);
    expect(left).toEqual(['left']);
    expect(gone).toEqual([{ to: 'watch', code: inv.room }]);
    expect(social.store.getState().invites).toHaveLength(1); // not answered: Join still works from Friends
    expect(renderToStaticMarkup(<InviteToast social={social} />)).toBe('');
    // already in that room: nothing to do
    const here = fakeShell({}, { name: 'room', code: inv.room });
    const again = new SocialController(here.shell, null);
    again.onEvent('invite', { invite: anInvite('i_2') });
    watchInvite(again, again.store.getState().invites[0]!);
    expect(here.gone).toEqual([]);
    expect(here.left).toEqual([]);
  });

  it('the picker lists friends to invite and the link for everyone else', async () => {
    const { shell } = fakeShell(
      {
        'GET /friends': () => ({
          code: 'X',
          friends: [
            { id: 'u_k', nickname: 'Kemi', status: 'in_room', room: 'KMTXRA', lastSeenAt: null, since: '' },
            { id: 'u_t', nickname: 'Tunde', status: 'online', room: null, lastSeenAt: null, since: '' },
            { id: 'u_s', nickname: 'Seun', status: 'offline', room: null, lastSeenAt: null, since: '' },
          ],
          incoming: [],
          outgoing: [],
          blocked: [],
          max: 200,
        }),
      },
      { name: 'room', code: 'KMTXRA' },
    );
    const social = new SocialController(shell, null);
    await social.refresh();
    social.openPicker();
    const html = renderToStaticMarkup(<InvitePicker social={social} />);
    expect(html).toContain('KMTXRA');
    expect(html).toContain('In this room');
    expect(html).toContain('Offline · invites need them on');
    expect(html).toContain('Copy invite link');
    expect(html.match(/>Invite</g)).toHaveLength(1); // Tunde only: Kemi is here, Seun is off
  });
});
