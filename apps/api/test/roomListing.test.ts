/** listing.ts: the Rooms list's order, who sees what, and Play now's pick (one ranking for both). */
import { describe, expect, it } from 'vitest';
import { QUICK_OPEN_MS, QUICK_PEOPLE, compareRows, playNowPick, rankRooms, rowOf, visibleTo, type Candidate, type RankedRow, type RoomRecord, type Viewer } from '../src/rooms/listing';
import type { StoredRoomState } from '../src/rooms/state';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const viewer = (over: Partial<Viewer> = {}): Viewer => ({ id: 'u_me', friends: new Set(), party: new Set(), blocked: new Set(), ...over });

function state(over: Partial<StoredRoomState> = {}): StoredRoomState {
  return { code: 'AAAAAA', phase: 'lobby', teams: 0, map: 'street-market', people: 2, bots: 4, seats: 6, timeLeftS: null, hostId: 'u_host', ids: ['u_host', 'u_two'], at: T0, ...over };
}

function cand(code: string, over: { record?: Partial<RoomRecord>; state?: Partial<StoredRoomState> | null; created?: number } = {}): Candidate {
  const record: RoomRecord = { host: 'u_host', createdAt: at(over.created ?? 0), visibility: 'public', players: ['u_host'], ...over.record };
  const s = over.state === null ? null : state({ code, ...over.state });
  return { code, record, state: s, hostId: s?.hostId ?? record.host, hostName: 'Host', ids: s?.ids ?? record.players ?? [], people: s?.people ?? (record.players ?? []).length };
}

const row = (c: Candidate, v = viewer()): RankedRow & { record: RoomRecord } => ({ ...rowOf(c, v), record: c.record });

describe('the order', () => {
  it('friends first, then rooms in their lobby, then the most people with a seat free, then the newest', () => {
    const v = viewer({ friends: new Set(['u_pal']) });
    const rows = [
      row(cand('NEWEST', { created: 50, state: { people: 1 } }), v),
      row(cand('OLDBIG', { created: 0, state: { people: 5, seats: 3 } }), v),
      row(cand('INGAME', { created: 60, state: { phase: 'playing', people: 7, seats: 1, timeLeftS: 200 } }), v),
      row(cand('FULLRM', { created: 70, state: { people: 8, seats: 0 } }), v),
      row(cand('FRIEND', { created: 1, state: { phase: 'playing', people: 1, ids: ['u_host', 'u_pal'], timeLeftS: 100 } }), v),
      row(cand('OLDER1', { created: 10, state: { people: 1 } }), v),
    ];
    expect(rankRooms(rows).map((r) => r.code)).toEqual(['FRIEND', 'OLDBIG', 'NEWEST', 'OLDER1', 'FULLRM', 'INGAME']);
  });

  it("a friend's room counts as a friend inside; a room just made (not heard from yet) counts as in its lobby", () => {
    const v = viewer({ friends: new Set(['u_host']) });
    const hosted = row(cand('HOSTED', { state: { phase: 'playing', hostId: 'u_host', ids: ['u_host'], timeLeftS: 90 } }), v);
    const fresh = row(cand('FRESHX', { state: null, record: { host: 'u_other', players: ['u_other'] } }), viewer());
    expect(hosted.host.friend).toBe(true);
    expect(compareRows(hosted, fresh)).toBeLessThan(0);
    expect(fresh.phase).toBeNull();
    expect(fresh.bots).toBeNull(); // bots aren't guessed: the page says "Bots fill the rest"
  });

  it('people and bots stay apart in a row', () => {
    const r = row(cand('COUNTS', { state: { people: 3, bots: 4, seats: 5 } }));
    expect([r.people, r.bots, r.seats]).toEqual([3, 4, 5]);
  });
});

describe('who sees a room', () => {
  it('Public and Play now rooms: everyone; Friends: the host\'s friends and party; Private: nobody', () => {
    const pub = cand('PUBLIC');
    const quick = cand('QUICKR', { record: { quick: true, visibility: undefined } });
    const friends = cand('FRIEND', { record: { visibility: 'friends' } });
    const priv = cand('PRIVAT', { record: { visibility: undefined } });
    const stranger = viewer();
    expect([pub, quick, friends, priv].map((c) => visibleTo(c, stranger))).toEqual([true, true, false, false]);
    expect(visibleTo(friends, viewer({ friends: new Set(['u_host']) }))).toBe(true);
    expect(visibleTo(friends, viewer({ party: new Set(['u_host']) }))).toBe(true);
    expect(visibleTo(priv, viewer({ friends: new Set(['u_host']) }))).toBe(false);
  });

  it('a block either way with the host or anyone playing hides the room', () => {
    const c = cand('BLOCKS', { state: { ids: ['u_host', 'u_rude'] } });
    expect(visibleTo(c, viewer({ blocked: new Set(['u_rude']) }))).toBe(false);
    expect(visibleTo(c, viewer({ blocked: new Set(['u_host']) }))).toBe(false);
    expect(visibleTo(c, viewer({ blocked: new Set(['u_other']) }))).toBe(true);
  });
});

describe("Play now's pick", () => {
  const now = T0 + 30_000;
  it('takes the top row it may join: a seat, someone in it, not a room you were in, not the scoreboard or a match about to end', () => {
    const rows = rankRooms([
      row(cand('FULLRM', { state: { people: 8, seats: 0 } })),
      row(cand('RESULT', { state: { phase: 'results', people: 6, seats: 2 } })),
      row(cand('ENDING', { state: { phase: 'playing', people: 6, seats: 2, timeLeftS: 20 } })),
      row(cand('MINEXX', { state: { people: 5, seats: 3 }, record: { players: ['u_host', 'u_me'] } })),
      row(cand('EMPTYX', { state: { people: 0, seats: 8, ids: [] } })),
      row(cand('GOODXX', { state: { people: 2, seats: 6 } })),
    ]);
    expect(playNowPick(rows, 'u_me', now)?.code).toBe('GOODXX');
    expect(playNowPick(rows.filter((r) => r.code !== 'GOODXX'), 'u_me', now)).toBeNull();
  });

  it('a Play now room takes up to QUICK_PEOPLE people, and only while young when the game server hasn\'t said', () => {
    const quick = { quick: true as const, visibility: undefined };
    expect(playNowPick([row(cand('QFULLX', { record: quick, state: { people: QUICK_PEOPLE, seats: 4 } }))], 'u_me', now)).toBeNull();
    const young = row(cand('QYOUNG', { record: { ...quick, players: ['u_host'] }, state: null }));
    expect(playNowPick([young], 'u_me', now)?.code).toBe('QYOUNG');
    expect(playNowPick([young], 'u_me', T0 + QUICK_OPEN_MS + 1)).toBeNull();
  });

  it('the list and Play now agree: Play now joins the first joinable row of the same ranking', () => {
    const v = viewer({ friends: new Set(['u_pal']) });
    const rows = rankRooms([row(cand('BIGGER', { state: { people: 4, seats: 4 } }), v), row(cand('PALSRM', { state: { people: 1, seats: 7, ids: ['u_host', 'u_pal'] } }), v)]);
    expect(rows[0]!.code).toBe('PALSRM');
    expect(playNowPick(rows, 'u_me', now)?.code).toBe('PALSRM');
  });
});
