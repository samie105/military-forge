/**
 * Rooms and Online now in the page: the words (people and bots apart, counts of people only), the
 * filters, every state the list and the panel can be in, and joining from the list (a room taken
 * meanwhile becomes Play now).
 */
import type { OnlineCounts, RoomRow } from '@military-forge/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGE_KEY } from '../shell/age';
import { ApiError, type Api } from '../shell/api';
import { ControllerContext } from '../shell/App';
import { ShellController, type GameHost } from '../shell/controller';
import { createShellStore } from '../shell/store';
import type { OnlineData, Polled } from './data';
import { inviteOnceInRoom } from './data';
import { DEFAULT_FILTERS, countsLine, filterRooms, langsIn, peopleLine, phaseLine, rowLabel, seatsLine } from './format';
import { listingLine } from './RoomListing';
import { ClosedState, OnlinePanel, RoomList, closedLine } from './RoomsScreen';

const row = (code: string, over: Partial<RoomRow> = {}): RoomRow => ({
  code,
  quick: false,
  visibility: 'public',
  teams: 0,
  map: 'street-market',
  host: { name: 'Kemi', friend: false },
  people: 3,
  bots: 4,
  seats: 5,
  phase: 'lobby',
  timeLeftS: null,
  tag: null,
  lang: null,
  friendInside: false,
  createdAt: '2026-11-01T12:00:00Z',
  ...over,
});

describe('the words', () => {
  it('counts people and bots apart, and always calls bots bots', () => {
    expect(peopleLine(3, 4)).toBe('3 players · 4 bots');
    expect(peopleLine(1, 1)).toBe('1 player · 1 bot');
    expect(peopleLine(8, 0)).toBe('8 players · no bots');
    expect(peopleLine(1, null)).toBe('1 player · bots fill the rest');
  });

  it('says where the match is', () => {
    expect(phaseLine({ phase: 'lobby', timeLeftS: null })).toBe('In lobby');
    expect(phaseLine({ phase: null, timeLeftS: null })).toBe('In lobby');
    expect(phaseLine({ phase: 'starting', timeLeftS: null })).toBe('Starting');
    expect(phaseLine({ phase: 'playing', timeLeftS: 160 })).toBe('In match · 2:40 left');
    expect(phaseLine({ phase: 'results', timeLeftS: null })).toBe('Results');
    expect(seatsLine(1)).toBe('1 seat left');
    expect(seatsLine(0)).toBe('Full');
  });

  it('Online now: people online and in matches; under 5 on, how many played today instead', () => {
    const c = (online: number, inMatches: number, playedToday: number): OnlineCounts => ({ online, inMatches, playedToday });
    expect(countsLine(c(14, 6, 40))).toBe('14 players online · 6 in matches');
    expect(countsLine(c(5, 1, 9))).toBe('5 players online · 1 in a match');
    expect(countsLine(c(3, 1, 23))).toBe('23 played today');
    expect(countsLine(c(0, 0, 0))).toBe('Quiet right now');
  });

  it('reads a row out whole for a screen reader', () => {
    expect(rowLabel(row('AAAAAA', { teams: 2, host: { name: 'Kemi', friend: true }, tag: 'chill', lang: 'en', friendInside: true }))).toBe(
      "Team deathmatch · 2 teams. Street Market. Kemi's room, a friend. 3 players · 4 bots. In lobby. 5 seats left. Chill. English. A friend is inside",
    );
    expect(listingLine({ visibility: 'public', tag: 'new', lang: 'yo', quick: false })).toBe('Public · New players welcome · Yorùbá');
    expect(listingLine({ visibility: 'public', tag: null, lang: null, quick: true })).toBe('Open · Play now room');
  });
});

describe('the filters', () => {
  const rows = [row('FFAONE'), row('TEAMSX', { teams: 2, lang: 'fr' }), row('FULLRM', { seats: 0 }), row('PALSRM', { friendInside: true }), row('NEWONE', { teams: null })];
  it('hide full rooms unless Show full is on; mode, friends and language narrow the rest', () => {
    const codes = (f: Partial<typeof DEFAULT_FILTERS>) => filterRooms(rows, { ...DEFAULT_FILTERS, ...f }).map((r) => r.code);
    expect(codes({})).toEqual(['FFAONE', 'TEAMSX', 'PALSRM', 'NEWONE']);
    expect(codes({ showFull: true })).toContain('FULLRM');
    expect(codes({ mode: 'ffa' })).toEqual(['FFAONE', 'PALSRM']);
    expect(codes({ mode: 'teams' })).toEqual(['TEAMSX']);
    expect(codes({ friends: true })).toEqual(['PALSRM']);
    expect(codes({ lang: 'fr' })).toEqual(['TEAMSX']);
    expect(langsIn(rows)).toEqual(['fr']);
  });
});

/** a controller stand-in: what the screens read */
function stubCtl(over: Record<string, unknown> = {}) {
  const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
  return { store, api: { authed: vi.fn() }, notify: vi.fn(), joinListed: vi.fn(), watch: vi.fn(), playNow: vi.fn(), go: vi.fn(), closeOverlay: vi.fn(), ...over } as unknown as ShellController;
}
const polled = <T,>(p: Partial<Polled<T>>): Polled<T> => ({ data: null, status: 'loading', error: null, reload: async () => {}, ...p });
const render = (node: React.ReactNode, ctl = stubCtl()) => renderToStaticMarkup(<ControllerContext.Provider value={ctl}>{node}</ControllerContext.Provider>);

describe('the list, in each state', () => {
  it('loading: says so, keeps Play now pinned on top (where a controller lands), and marks the list busy', () => {
    const html = render(<RoomList list={polled({ status: 'loading' })} />);
    expect(html).toContain('Finding rooms…');
    expect(html).toContain('Bots ready · join any time');
    expect(html).toMatch(/data-pad-first="true"[^>]*>.*Play now/);
    expect(html).toContain('aria-busy="true"');
  });

  it('nothing open: Play now is still there, and the line says how to open one', () => {
    const html = render(<RoomList list={polled({ status: 'ready', data: [] })} />);
    expect(html).toContain('No open rooms right now');
    expect(html).toContain('Bots ready · join any time');
    expect(html).toContain('set it to Public in its lobby');
  });

  it('failed with nothing to show: why, and Try again; failed on a refresh: the last list stays, marked', () => {
    const none = render(<RoomList list={polled({ status: 'error', error: "Can't reach the server" })} />);
    expect(none).toContain("Can&#x27;t reach the server");
    expect(none).toContain('Try again');
    const stale = render(<RoomList list={polled({ status: 'error', error: "Can't reach the server", data: [row('AAAAAA')] })} />);
    expect(stale).toContain('showing the last list');
    expect(stale).toContain('3 players · 4 bots');
  });

  it('a row: mode and map, the host and friend badge, people and bots, phase, seats, tag, language, friend inside, Join', () => {
    const html = render(<RoomList list={polled({ status: 'ready', data: [row('AAAAAA', { host: { name: 'Kemi', friend: true }, tag: 'sweaty', lang: 'en', friendInside: true, phase: 'playing', timeLeftS: 160 })] })} />);
    for (const text of ['Deathmatch', 'Street Market', 'Kemi', 'Friend', '3 players · 4 bots', 'In match · 2:40 left', '5 seats left', 'Sweaty', 'English', 'Friend inside', 'Join', '1 room open']) expect(html).toContain(text);
  });

  it('full rooms are hidden and counted; shown, they offer Watch instead of Join', () => {
    const data = [row('FULLRM', { seats: 0, people: 8, bots: 0 })];
    const hidden = render(<RoomList list={polled({ status: 'ready', data })} />);
    expect(hidden).toContain('1 full hidden');
    expect(hidden).toContain('Every open room is full');
    const shown = render(<RoomList list={polled({ status: 'ready', data })} initialFilters={{ ...DEFAULT_FILTERS, showFull: true }} />);
    expect(shown).toContain('Watch');
    expect(shown).toContain('8 players · no bots');
    expect(shown).not.toMatch(/>Join</);
  });

  it('phone: the same rows, tighter', () => {
    const html = render(<RoomList phone list={polled({ status: 'ready', data: [row('AAAAAA', { friendInside: true })] })} />);
    expect(html).toContain('rm-list-wrap--phone');
    expect(html).toContain('Friend inside');
  });

  it('offline, under 18 or suspended: an honest line and Training', () => {
    expect(closedLine({ offline: true })).toMatch(/Can't reach the server/);
    expect(closedLine({ offline: false, minor: true })).toMatch(/18 and over/);
    expect(closedLine({ offline: false, suspended: { until: null } })).toMatch(/can't play online/);
    expect(closedLine({ offline: false })).toBeNull();
    expect(render(<ClosedState line="Offline" phone={false} />)).toContain('Training');
  });
});

describe('Online now, in each state', () => {
  const data = (over: Partial<OnlineData> = {}): OnlineData => ({
    now: { counts: { online: 14, inMatches: 6, playedToday: 40 }, settings: { appearOffline: false, showToRecent: false }, lfg: null },
    recent: [],
    looking: [],
    ...over,
  });
  it('the counts (people only), Looking for a match off, empty lists said plainly, the privacy switches', () => {
    const html = render(<OnlinePanel online={polled({ status: 'ready', data: data() })} social={null} />);
    expect(html).toContain('14 players online · 6 in matches');
    expect(html).toContain('People only, never bots');
    expect(html).toContain('Lists you for 15 minutes');
    expect(html).toContain('Nobody else is looking right now.');
    expect(html).toContain('Appear offline');
    expect(html).toContain('Show me to people I played with');
  });

  it('few on: how many played today; someone looking with a room you may see: Join', () => {
    const html = render(
      <OnlinePanel
        online={polled({
          status: 'ready',
          data: data({ now: { counts: { online: 2, inMatches: 1, playedToday: 9 }, settings: { appearOffline: false, showToRecent: true }, lfg: { mode: 'teams', until: new Date(Date.now() + 600_000).toISOString() } }, looking: [{ id: 'u_x', nickname: 'Tunde', level: 7, look: null, friend: false, where: 'lobby', room: 'KMTXRA', mode: 'ffa' }] }),
        })}
        social={null}
      />,
    );
    expect(html).toContain('9 played today');
    expect(html).toContain('Tunde');
    expect(html).toContain('Level 7 · Deathmatch · in a lobby');
    expect(html).toMatch(/min left/);
    expect(html).toContain('>Join<');
  });

  it('loading and failed', () => {
    expect(render(<OnlinePanel online={polled({ status: 'loading' })} social={null} />)).toContain('…');
    const failed = render(<OnlinePanel online={polled({ status: 'error', error: "Can't reach the server" })} social={null} />);
    expect(failed).toContain('Try again');
  });
});

describe('joining from the list', () => {
  beforeAll(() => {
    const win = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval });
    vi.stubGlobal('window', win);
    vi.stubGlobal('history', { pushState: () => {}, replaceState: () => {}, state: null });
    vi.stubGlobal('location', { origin: 'https://abc.example', host: 'abc.example', protocol: 'https:', pathname: '/', search: '', hash: '' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === AGE_KEY ? JSON.stringify({ adult: true, birthYear: 1995, at: 0 }) : null), setItem: () => {}, removeItem: () => {} });
  });
  afterAll(() => vi.unstubAllGlobals());

  function setup(api: Partial<Api>) {
    const host = { local: null, online: null, lan: null, startTraining: vi.fn(), startOnline: vi.fn(), stop: vi.fn(), applySettings: vi.fn(), setInputBlocked: vi.fn() } as unknown as GameHost;
    const store = createShellStore();
    const ctl = new ShellController(store, host, api as Api);
    store.setState({ profile: { nickname: 'Ade', changeableAt: null, offline: false } });
    return { store, ctl, host };
  }

  it('asks the API as from the list, and enters the room', async () => {
    const joinRoom = vi.fn(async () => ({ code: 'KMTXRA', roomId: 'KMTXRA', gsUrl: null, ticket: 't' }));
    const { store, ctl } = setup({ joinRoom });
    expect(await ctl.joinListed('KMTXRA')).toBe('ok');
    expect(joinRoom).toHaveBeenCalledWith('KMTXRA', 'list');
    expect(store.getState().screen).toEqual({ name: 'room', code: 'KMTXRA' });
  });

  it('taken meanwhile: Play now instead, and it says so', async () => {
    const quickRoom = vi.fn(async () => ({ code: 'NEXTRM', roomId: 'NEXTRM', gsUrl: null, ticket: 't', joined: true }));
    const { store, ctl } = setup({ joinRoom: vi.fn(async () => Promise.reject(new ApiError(409, 'room_taken', 'Taken'))), quickRoom });
    expect(await ctl.joinListed('KMTXRA')).toBe('taken');
    expect(store.getState().notice).toBe('Taken. Joining the next best room');
    await vi.waitFor(() => expect(quickRoom).toHaveBeenCalled());
    await vi.waitFor(() => expect(store.getState().screen).toEqual({ name: 'room', code: 'NEXTRM' }));
  });
});

describe("Invite someone looking (no room yet: make one, then invite)", () => {
  it('invites once the new room has its lobby; gives up if the player ends up elsewhere', () => {
    const store = createShellStore();
    const invite = vi.fn(async () => true);
    inviteOnceInRoom(store, invite, [{ id: 'u_t', nickname: 'Tunde' }]);
    store.setState({ screen: { name: 'finding', code: null, creating: true } });
    store.setState({ screen: { name: 'room', code: 'KMTXRA' } });
    expect(invite).not.toHaveBeenCalled(); // no lobby yet
    store.setState({ lobby: { code: 'KMTXRA' } as never });
    expect(invite).toHaveBeenCalledWith({ id: 'u_t', nickname: 'Tunde' });
    store.setState({ lobby: null });
    store.setState({ lobby: { code: 'KMTXRA' } as never });
    expect(invite).toHaveBeenCalledTimes(1);

    const gaveUp = vi.fn(async () => true);
    store.setState({ screen: { name: 'home' }, lobby: null });
    inviteOnceInRoom(store, gaveUp, [{ id: 'u_t', nickname: 'Tunde' }]);
    store.setState({ overlay: null }); // Home closing the Rooms overlay: still on the way
    store.setState({ screen: { name: 'finding', code: null, creating: true } });
    store.setState({ screen: { name: 'error', alert: { kind: 'error', title: 'x', message: 'x', code: 'x', action: null }, retry: null } });
    store.setState({ screen: { name: 'room', code: 'OTHERX' }, lobby: { code: 'OTHERX' } as never });
    expect(gaveUp).not.toHaveBeenCalled();
  });
});
