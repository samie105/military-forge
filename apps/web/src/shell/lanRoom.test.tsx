/** Local rooms (same Wi-Fi, lan/) in the shell: the flows, the lobby's note, the QR panels. */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, type Api } from './api';
import { ControllerContext } from './App';
import { ShellController, type GameHost } from './controller';
import type { LobbyView } from './onlineView';
import { lobbyView } from './onlineView';
import { LanAddPlayer, LanJoin, OFFER_PREFIX, REPLY_PREFIX, codeProblem, sentence } from './screens/LanPanels';
import { LocalRoomNote } from './screens/Lobby';
import { createShellStore } from './store';

vi.mock('../lan/guest', () => ({ lanRoomExists: vi.fn(async (code: string) => code === 'KMTXRA') }));

function setup(api: Partial<Api> = {}, offline = false) {
  const host = {
    local: null,
    online: null,
    lan: null,
    startTraining: vi.fn(),
    startOnline: vi.fn(),
    startLocalHost: vi.fn(async () => 'QWERTY'),
    startLocalJoin: vi.fn(),
    stop: vi.fn(),
    applySettings: vi.fn(),
    setInputBlocked: vi.fn(),
  } as unknown as GameHost & { startLocalHost: ReturnType<typeof vi.fn>; startLocalJoin: ReturnType<typeof vi.fn> };
  const store = createShellStore();
  const ctl = new ShellController(store, host, api as Api);
  store.setState({ profile: { nickname: 'Ade', changeableAt: null, offline } });
  return { store, ctl, host };
}

const lobby = (over: Partial<LobbyView> = {}): LobbyView => ({
  code: 'QWERTY',
  local: true,
  players: [{ id: 0, name: 'Ade', ready: false, host: true, you: true, isBot: false, pingMs: 2 }],
  isHost: true,
  ready: false,
  minPlayers: 2,
  timeLimit: 300,
  killLimit: 20,
  mapId: 'street-market',
  mapName: 'Street Market',
  bots: 4,
  botLevel: 'normal',
  ...over,
});

describe('local rooms in the shell', () => {
  beforeAll(() => {
    const win = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
    vi.stubGlobal('window', win);
    vi.stubGlobal('history', { pushState: () => {}, replaceState: () => {}, state: null });
    vi.stubGlobal('location', { origin: 'https://abc.example', host: 'abc.example', protocol: 'https:', pathname: '/', search: '' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('Local room hosts one here, with no API needed (offline too), and lands in its lobby', async () => {
    const { store, ctl, host } = setup({}, true);
    ctl.go({ to: 'local' });
    await vi.waitFor(() => expect(store.getState().screen).toEqual({ name: 'room', code: 'QWERTY', local: true }));
    expect(host.startLocalHost).toHaveBeenCalledWith('Ade');
  });

  it("Join with code: a code that isn't one of the server's rooms joins the local room with it", async () => {
    const notFound = new ApiError(404, 'room_not_found', 'no room');
    const { store, ctl, host } = setup({ joinRoom: vi.fn(async () => Promise.reject(notFound)) });
    expect(await ctl.joinByCode('KMTXRA')).toBe('ok');
    expect(host.startLocalJoin).toHaveBeenCalledWith('Ade', { code: 'KMTXRA' });
    expect(store.getState().screen).toEqual({ name: 'room', code: 'KMTXRA', local: true });
    // and no local room either: "No room with that code", as before
    expect(await ctl.joinByCode('ZZZZZZ')).toBe('not_found');
  });

  it('offline (no API), Join goes straight to the local room', () => {
    const { ctl, host } = setup({}, true);
    ctl.go({ to: 'join', code: 'KMTXRA' });
    expect(host.startLocalJoin).toHaveBeenCalledWith('Ade', { code: 'KMTXRA' });
  });

  it('the lobby says "same Wi-Fi only"; its host gets the QR way in; with no code, so does the note', () => {
    const { ctl } = setup();
    const render = (v: LobbyView) =>
      renderToStaticMarkup(
        <ControllerContext.Provider value={ctl}>
          <LocalRoomNote lobby={v} />
        </ControllerContext.Provider>,
      );
    const hostView = render(lobby());
    expect(hostView).toContain('Same Wi-Fi only');
    expect(hostView).toContain('Join with code');
    expect(hostView).toContain('mf-lan__how-code">QWERTY<');
    expect(hostView).toContain('Add a player by QR');
    expect(render(lobby({ isHost: false }))).not.toContain('Add a player');
    // no internet at all: no code; the paper card says friends join by QR, the host's button says how
    const offline = render(lobby({ code: '' }));
    expect(offline).toContain('Friends join by QR');
    expect(offline).toContain('Add each player');
    expect(render(lobby({ code: '', isHost: false }))).toContain('The host adds each friend');
  });

  it('lobbyView carries the local flag from the online mode', () => {
    const state = {
      phase: 0,
      phaseStartTick: 0,
      number: 0,
      endReason: 0,
      rules: { timeLimit: 300, killLimit: 20, countdown: 3, ending: 3, postgame: 10, minPlayers: 2, onNoRematch: 'lobby', bots: 4, botLevel: 'normal' },
      mapId: 'street-market',
      hostId: 0,
      lobby: [{ id: 0, ready: false, rematch: false, pingMs: 2 }],
      standings: [],
      results: null,
    };
    const v = lobbyView({ room: 'QWERTY', local: true, localId: 0, matchState: state as never, serverTickNow: () => 0 })!;
    expect(v.local).toBe(true);
    expect(lobbyView({ room: 'QWERTY', localId: 0, matchState: state as never, serverTickNow: () => 0 })!.local).toBe(false);
  });

  it('the QR panels render (the host with no local room is told so; a guest gets both steps)', () => {
    const { ctl } = setup();
    const wrap = (el: React.ReactElement) => renderToStaticMarkup(<ControllerContext.Provider value={ctl}>{el}</ControllerContext.Provider>);
    expect(wrap(<LanAddPlayer />)).toContain('can add players this way');
    const join = wrap(<LanJoin />);
    expect(join).toContain('Join a local room');
    expect(join).toContain('Same Wi-Fi only');
    // no BarcodeDetector here (as on an iPhone): no camera, the paste row says why
    expect(join).toContain('can&#x27;t read QR codes');
    expect(join).toContain('placeholder="L1.o… the host&#x27;s code"');
    expect(join).toContain('enterKeyHint="go"'); // the phone keyboard's Go key
    expect(join).toContain('The host scans this');
    expect(join).toContain('Your reply appears here once you have the host&#x27;s code');
  });

  it("the host's panel: step 1 their code on paper (being made), step 2 their reply, both ways", () => {
    const { ctl } = setup();
    const lan = { newOffer: vi.fn(() => new Promise(() => {})), acceptAnswer: vi.fn() };
    (ctl.host as { lan: unknown }).lan = lan;
    const html = renderToStaticMarkup(
      <ControllerContext.Provider value={ctl}>
        <LanAddPlayer />
      </ControllerContext.Provider>,
    );
    expect(html).toContain('They scan this');
    expect(html).toContain('Making a code…');
    expect(html).toContain('Scan their reply');
    expect(html).toContain('Let them in');
    expect(html).toContain('mf-lan__glass');
    (ctl.host as { lan: unknown }).lan = null;
  });

  it('a pasted code of the wrong kind says which it is, before the lan module sees it', () => {
    expect(codeProblem('L1.a.xyz', REPLY_PREFIX)).toBeNull();
    expect(codeProblem('  L1.o.xyz ', OFFER_PREFIX)).toBeNull();
    expect(codeProblem('L1.o.xyz', REPLY_PREFIX)).toContain("this room's own code");
    expect(codeProblem('L1.a.xyz', OFFER_PREFIX)).toContain('a reply code');
    expect(codeProblem('https://example.com', OFFER_PREFIX)).toContain("isn't a local room code");
    expect(sentence('could not reach the other device: are you on the same Wi-Fi?')).toBe('Could not reach the other device: are you on the same Wi-Fi?');
    expect(sentence('not a local room code')).toBe('Not a local room code.');
  });
});
