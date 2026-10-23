/**
 * Invites, parties and the push channel (GET /events): an invite reaches a friend's open stream at
 * once, lasts 2 minutes, and accepting it puts you in the inviter's party, which the next join
 * ticket carries for party voice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '../src/auth/keys';
import type { SocialEvent } from '../src/events/bus';
import { MAX_STREAMS } from '../src/events/routes';
import { MAX_PARTY, type PartyView } from '../src/invites/party';
import { INVITE_TTL_MS, REINVITE_MS, type Invite } from '../src/invites/service';
import type { RoomJoin } from '../src/rooms/routes';
import { befriend, bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi({}, { ticketKey: generateSigningKey() });
});
afterAll(() => api.close());

const post = (s: SessionBody, path: string, body: unknown = {}) => api.app.request(path, json(body, { ...bearer(s.accessToken), 'x-forwarded-for': api.ip() }));
const get = async <T>(s: SessionBody, path: string) => (await (await api.app.request(path, { headers: bearer(s.accessToken) })).json()) as T;
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const beat = (s: SessionBody, room: string | null = null) => api.app.request('/me/presence', { method: 'PUT', headers: { ...bearer(s.accessToken), 'content-type': 'application/json' }, body: JSON.stringify({ room }) });
const makeRoom = async (s: SessionBody) => (await (await post(s, '/rooms')).json()) as RoomJoin;
const invite = (s: SessionBody, to: SessionBody, room?: string) => post(s, '/invites', { to: to.user.id, ...(room ? { room } : {}) });
const ticketClaims = (ticket: string) => JSON.parse(Buffer.from(ticket.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

/** Events a player's bus subscription sees (the same fan-out the SSE stream uses). */
function listen(s: SessionBody) {
  const seen: SocialEvent[] = [];
  const stop = api.bus.subscribe(s.user.id, (e) => seen.push(e));
  return { seen, stop };
}

/** Reads an SSE response until `type` arrives (or the time runs out). */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, type: string, ms = 5000): Promise<{ text: string; data: unknown }> {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
    if (!chunk || chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    for (const frame of buf.split('\n\n')) {
      const ev = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (ev === type) return { text: buf, data: data ? JSON.parse(data) : null };
    }
  }
  throw new Error(`no ${type} event in: ${buf}`);
}

describe('the push channel (GET /events)', () => {
  it('needs a valid session', async () => {
    expect((await api.app.request('/events')).status).toBe(401);
    expect((await api.app.request('/events', { headers: bearer('nope') })).status).toBe(401);
  });

  it("streams a friend's invite the moment it's sent, with Caddy's encode kept off, and lets go when closed", async () => {
    const host = await createGuest(api);
    const friend = await createGuest(api);
    await befriend(api.app, host, friend);
    const room = await makeRoom(host);

    const stop = new AbortController();
    const res = await api.app.request('/events', { headers: bearer(friend.accessToken), signal: stop.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    const reader = res.body!.getReader();
    const hello = await readUntil(reader, 'hello');
    expect(hello.data).toMatchObject({ at: expect.any(String), until: expect.any(String) });
    expect(api.bus.listeners(friend.user.id)).toBe(1);

    const t0 = performance.now();
    expect((await invite(host, friend, room.code)).status).toBe(201);
    const got = await readUntil(reader, 'invite');
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(got.data).toMatchObject({ type: 'invite', invite: { room: room.code, from: { id: host.user.id }, to: { id: friend.user.id } } });

    stop.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 50 && api.bus.listeners(friend.user.id) > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(api.bus.listeners(friend.user.id)).toBe(0);
  });

  it('holds a few streams per player, no more', async () => {
    const s = await createGuest(api);
    const aborts: AbortController[] = [];
    for (let i = 0; i < MAX_STREAMS; i++) {
      const a = new AbortController();
      aborts.push(a);
      const res = await api.app.request('/events', { headers: bearer(s.accessToken), signal: a.signal });
      expect(res.status).toBe(200);
      await readUntil(res.body!.getReader(), 'hello');
    }
    const extra = await api.app.request('/events', { headers: bearer(s.accessToken) });
    expect(extra.status).toBe(429);
    expect(await errorCode(extra)).toBe('too_many_streams');
    for (const a of aborts) a.abort();
  });

  it("tells friends when a request arrives and a friend's status changes", async () => {
    const a = await createGuest(api);
    const b = await createGuest(api);
    const ears = listen(b);
    const { code } = await get<{ code: string }>(b, '/friends');
    await post(a, '/friends/requests', { code });
    expect(ears.seen).toContainEqual({ type: 'friends' });
    await post(b, `/friends/requests/${a.user.id}/accept`);

    ears.seen.length = 0;
    await beat(a);
    expect(ears.seen).toContainEqual({ type: 'presence', id: a.user.id, status: 'online', room: null });
    ears.seen.length = 0;
    await beat(a); // no change, no event
    expect(ears.seen.filter((e) => e.type === 'presence')).toEqual([]);
    const room = await makeRoom(a);
    await beat(a, room.code);
    expect(ears.seen).toContainEqual({ type: 'presence', id: a.user.id, status: 'in_room', room: room.code });
    await api.app.request('/me/presence', { method: 'DELETE', headers: bearer(a.accessToken) });
    expect(ears.seen).toContainEqual({ type: 'presence', id: a.user.id, status: 'offline', room: null });
    ears.stop();
  });
});

describe('invites', () => {
  it('only between friends, to a room that exists (yours by default), never to someone already in it', async () => {
    const host = await createGuest(api);
    const friend = await createGuest(api);
    const stranger = await createGuest(api);
    await befriend(api.app, host, friend);

    expect(await errorCode(await invite(host, stranger, 'ABCDEF'))).toBe('not_friends');
    expect(await errorCode(await invite(host, friend))).toBe('room_not_found');
    expect(await errorCode(await invite(host, friend, 'QQQQQQ'))).toBe('room_not_found');
    expect(await errorCode(await post(host, '/invites', { to: host.user.id, room: 'ABCDEF' }))).toBe('cannot_invite_self');

    const room = await makeRoom(host); // making a room marks you in it (presence)
    const sent = await invite(host, friend);
    expect(sent.status).toBe(201);
    const { invite: inv } = (await sent.json()) as { invite: Invite };
    expect(inv).toMatchObject({ room: room.code, from: { id: host.user.id }, to: { id: friend.user.id } });
    expect(Date.parse(inv.expiresAt) - Date.parse(inv.at)).toBe(INVITE_TTL_MS);

    // they join: a second invite to the same room is pointless
    await post(friend, `/rooms/${room.code}/join`);
    api.clock.advance(REINVITE_MS);
    expect(await errorCode(await invite(host, friend))).toBe('already_in_room');
  });

  it('lists what waits for you and what you sent; Decline tells the sender; it expires after 2 minutes', async () => {
    const host = await createGuest(api);
    const a = await createGuest(api);
    const b = await createGuest(api);
    await befriend(api.app, host, a);
    await befriend(api.app, host, b);
    const room = await makeRoom(host);
    const ears = listen(host);
    const ia = ((await (await invite(host, a)).json()) as { invite: Invite }).invite;
    await invite(host, b);

    const listed = await get<{ incoming: Invite[]; now: string }>(a, '/invites');
    expect(listed.incoming.map((i) => i.id)).toEqual([ia.id]);
    expect(listed.now).toBe(new Date(api.clock.now()).toISOString());
    expect((await get<{ sent: Invite[] }>(host, '/invites')).sent).toHaveLength(2);

    expect((await post(a, `/invites/${ia.id}/decline`)).status).toBe(204);
    expect(ears.seen).toContainEqual({ type: 'invite_answered', id: ia.id, to: a.user.id, answer: 'declined' });
    expect((await get<{ incoming: Invite[] }>(a, '/invites')).incoming).toEqual([]);
    const sent = (await get<{ sent: Invite[] }>(host, '/invites')).sent;
    expect(sent.find((i) => i.id === ia.id)?.answer).toBe('declined');
    expect(await errorCode(await post(a, `/invites/${ia.id}/accept`))).toBe('invite_answered');
    ears.stop();

    if (api.kv.kind !== 'memory') return; // a real Valkey's TTL can't be fast-forwarded
    api.clock.advance(INVITE_TTL_MS + 1);
    expect((await get<{ incoming: Invite[] }>(b, '/invites')).incoming).toEqual([]);
    void room;
  });

  it("an expired invite can't be accepted", async () => {
    if (api.kv.kind !== 'memory') return;
    const host = await createGuest(api);
    const friend = await createGuest(api);
    await befriend(api.app, host, friend);
    await makeRoom(host);
    const inv = ((await (await invite(host, friend)).json()) as { invite: Invite }).invite;
    api.clock.advance(INVITE_TTL_MS + 1);
    // the session's access token outlives 2 minutes; the invite doesn't
    expect(await errorCode(await post(friend, `/invites/${inv.id}/accept`))).toBe('invite_not_found');
  });

  it('inviting the same friend again sends the same invite again (after a few seconds), with fresh time', async () => {
    const host = await createGuest(api);
    const friend = await createGuest(api);
    await befriend(api.app, host, friend);
    await makeRoom(host);
    const first = ((await (await invite(host, friend)).json()) as { invite: Invite }).invite;
    expect((await invite(host, friend)).status).toBe(429); // a double tap
    api.clock.advance(REINVITE_MS);
    const again = ((await (await invite(host, friend)).json()) as { invite: Invite }).invite;
    expect(again.id).toBe(first.id);
    expect(Date.parse(again.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    expect((await get<{ incoming: Invite[] }>(friend, '/invites')).incoming).toHaveLength(1);
  });
});

describe('parties', () => {
  it("accepting puts you in the inviter's party; the join ticket carries it; leaving a party of two ends it", async () => {
    const host = await createGuest(api);
    const a = await createGuest(api);
    const b = await createGuest(api);
    await befriend(api.app, host, a);
    await befriend(api.app, host, b);
    const room = await makeRoom(host);
    const hostEars = listen(host);

    const ia = ((await (await invite(host, a)).json()) as { invite: Invite }).invite;
    const accepted = await post(a, `/invites/${ia.id}/accept`);
    expect(await accepted.json()).toMatchObject({ room: room.code, party: true, invite: { answer: 'accepted' } });
    expect(hostEars.seen).toContainEqual({ type: 'invite_answered', id: ia.id, to: a.user.id, answer: 'accepted' });
    expect(hostEars.seen).toContainEqual({ type: 'party' });

    const ib = ((await (await invite(host, b)).json()) as { invite: Invite }).invite;
    await post(b, `/invites/${ib.id}/accept`);
    const { party } = await get<{ party: PartyView }>(a, '/party');
    expect(party.members.map((m) => m.id).sort()).toEqual([host.user.id, a.user.id, b.user.id].sort());
    expect(party.max).toBe(MAX_PARTY);

    // the ticket for the room names the party, for party voice
    const join = (await (await post(a, `/rooms/${room.code}/join`)).json()) as RoomJoin;
    expect(ticketClaims(join.ticket!)).toMatchObject({ party: party.id, room: room.code });

    expect((await post(b, '/party/leave')).status).toBe(204);
    expect((await get<{ party: PartyView | null }>(b, '/party')).party).toBeNull();
    expect((await get<{ party: PartyView }>(host, '/party')).party.members).toHaveLength(2);
    await post(a, '/party/leave');
    // a party of one is no party
    expect((await get<{ party: PartyView | null }>(host, '/party')).party).toBeNull();
    const solo = (await (await post(host, `/rooms/${room.code}/join`)).json()) as RoomJoin;
    expect(ticketClaims(solo.ticket!)).not.toHaveProperty('party');
    hostEars.stop();
  });
});
