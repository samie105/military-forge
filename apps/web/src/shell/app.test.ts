/**
 * The app shell's pure parts: links and room URLs, saved settings and key bindings, the online
 * match/lobby views from MATCH_STATE, the API client's session handling, and the QR encoder.
 */
import type { MatchStateMsg } from '@military-forge/protocol';
import { Btn, MatchPhase } from '@military-forge/sim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiError } from './api';
import { ACTIONS, defaultBindings, keyLabel, rebind, sanitizeBindings, toKeyBindings, uiCodes, unbind } from './controls';
import { SETTINGS_REV, intentFromLocation, roomSocketUrl, sanitizeSettings } from './controller';
import { DEFAULT_SETTINGS } from './store';
import { lobbyView, onlineMatchView, sameLobby, type OnlineSource } from './onlineView';
import { encodeQr, qrSvgPath } from './qr';

describe('links', () => {
  it('reads /r/CODE and ?room=CODE; anything else is home', () => {
    expect(intentFromLocation({ pathname: '/r/KQXMZP', search: '' })).toEqual({ to: 'join', code: 'KQXMZP' });
    expect(intentFromLocation({ pathname: '/r/kqxmzp/', search: '' })).toEqual({ to: 'join', code: 'KQXMZP' });
    expect(intentFromLocation({ pathname: '/', search: '?room=kqx-mzp' })).toEqual({ to: 'join', code: 'KQXMZP' });
    expect(intentFromLocation({ pathname: '/r/NOPE0', search: '' })).toEqual({ to: 'home' });
    expect(intentFromLocation({ pathname: '/', search: '?app' })).toEqual({ to: 'home' });
    // the Armory's Try it in training
    expect(intentFromLocation({ pathname: '/', search: '?app&try=k47' })).toEqual({ to: 'training' });
    expect(intentFromLocation({ pathname: '/', search: '?try=<script>' })).toEqual({ to: 'home' });
  });

  it("a room's socket is the API's gsUrl, else this site's own /ws/<code>", () => {
    expect(roomSocketUrl({ code: 'KQXMZP', gsUrl: null }, { protocol: 'https:', host: 'abc.trycloudflare.com' })).toBe('wss://abc.trycloudflare.com/ws/KQXMZP');
    expect(roomSocketUrl({ code: 'KQXMZP', gsUrl: null }, { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws/KQXMZP');
    expect(roomSocketUrl({ code: 'KQXMZP', gsUrl: 'wss://gs.example.com/ws/KQXMZP' })).toBe('wss://gs.example.com/ws/KQXMZP');
  });
});

describe('settings and controls', () => {
  it('saved settings are checked field by field', () => {
    const s = sanitizeSettings({ graphics: 'ultra', netGraph: true, lowBandwidth: 'yes', reduceFlashes: true, bindings: { fire: ['Mouse2'], fire2: ['Mouse2'] } });
    expect(s).toMatchObject({ graphics: 'auto', netGraph: true, lowBandwidth: false, reduceFlashes: true, doubleTapDash: true, blood: false });
    // a code is used once: the first action (in list order) keeps it
    expect(s.bindings.fire).toEqual(['Mouse2']);
    expect(s.bindings.fire2).toEqual([]);
    expect(sanitizeSettings(null)).toEqual(sanitizeSettings({}));
    expect(sanitizeBindings({ jet: ['Escape', 'KeyW', '<script>', 42, 'KeyW'] }).jet).toEqual(['KeyW']);
  });

  it('new defaults: Auto graphics, double-tap dash on, no blood; settings saved before them take them once', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ graphics: 'auto', doubleTapDash: true, blood: false });
    // saved before rev 2: Low and double-tap off were the old defaults, not choices
    expect(sanitizeSettings({ graphics: 'low', doubleTapDash: false, showFps: true })).toMatchObject({ graphics: 'auto', doubleTapDash: true, showFps: true });
    expect(sanitizeSettings({ graphics: 'high' })).toMatchObject({ graphics: 'high' });
    // saved since: every choice stays
    expect(sanitizeSettings({ rev: SETTINGS_REV, graphics: 'low', doubleTapDash: false, blood: true })).toMatchObject({ graphics: 'low', doubleTapDash: false, blood: true });
    // rev 2 (rev 1's choices kept): only the rev 3 move happens
    expect(sanitizeSettings({ rev: 2, graphics: 'low' })).toMatchObject({ graphics: 'low' });
  });

  it('rev 3: V is push to talk (voice chat); a saved V on melee moves to C, or just goes when C is taken', () => {
    expect(defaultBindings()).toMatchObject({ talk: ['KeyV'], melee: ['KeyC', 'Mouse3'] });
    const moved = sanitizeSettings({ rev: 2, bindings: { melee: ['KeyV', 'Mouse3'] } }).bindings;
    expect(moved.melee).toEqual(['KeyC', 'Mouse3']);
    expect(moved.talk).toEqual(['KeyV']);
    const cTaken = sanitizeSettings({ rev: 2, bindings: { melee: ['KeyV'], reload: ['KeyC'] } }).bindings;
    expect(cTaken.melee).toEqual([]);
    expect(cTaken.talk).toEqual(['KeyV']);
    // chosen after rev 3: V on melee stays, and talk gives way (each key does one thing)
    expect(sanitizeSettings({ rev: SETTINGS_REV, bindings: { melee: ['KeyV'] } }).bindings.melee).toEqual(['KeyV']);
  });

  it('defaults cover every action, each key once', () => {
    const d = defaultBindings();
    const codes = ACTIONS.flatMap((a) => d[a.id]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const a of ACTIONS) expect(d[a.id].length, a.id).toBeGreaterThan(0);
    expect(d.cycleGrenade).toEqual(['KeyT', 'Mouse4']);
    expect(d.dash).toEqual(['ShiftLeft', 'ShiftRight']);
  });

  it("rebinding takes the key off its old action and keeps two at most (the kit's Key 1 and Key 2)", () => {
    let b = defaultBindings();
    const { bindings, took } = rebind(b, 'reload', 'KeyQ', 0);
    expect(took).toBe('swap');
    expect(bindings.reload).toEqual(['KeyQ']);
    expect(bindings.swap).toEqual([]);
    const mouse = rebind(bindings, 'reload', 'Mouse4', 1);
    expect([mouse.took, mouse.bindings.cycleGrenade]).toEqual(['cycleGrenade', ['KeyT']]);
    b = rebind(mouse.bindings, 'reload', 'KeyY', 2).bindings;
    expect(b.reload).toEqual(['KeyQ', 'Mouse4']);
    b = rebind(b, 'reload', 'KeyZ', 1).bindings;
    expect(b.reload).toEqual(['KeyQ', 'KeyZ']);
    expect(rebind(b, 'reload', 'Escape', 0).bindings).toBe(b);
    expect(unbind(b, 'reload', 1).reload).toEqual(['KeyQ']);
  });

  it('turns bindings into the sampler’s keys, mouse buttons and weapon slots', () => {
    const kb = toKeyBindings(rebind(defaultBindings(), 'melee', 'Mouse1', 1).bindings);
    expect(kb.keys.KeyA).toBe(Btn.Left);
    expect(kb.keys.Space).toBe(Btn.Jet);
    expect(kb.keys.KeyT).toBe(Btn.CycleGrenade);
    expect(kb.mouse[0]).toBe(Btn.Fire);
    expect(kb.mouse[1]).toBe(Btn.Melee);
    expect(kb.slots).toEqual({ Digit1: 1, Digit2: 2 });
    expect(kb.keys.Tab).toBeUndefined(); // page-level: the scoreboard
    expect(uiCodes(defaultBindings(), 'netGraph')).toEqual(['KeyN']);
    expect([kb.keys.ShiftLeft, kb.keys.ShiftRight, kb.keys.KeyX]).toEqual([Btn.Dash, Btn.Dash, Btn.Shield]);
    expect(kb.mouse[4]).toBe(Btn.CycleGrenade); // mouse 5 (forward)
  });

  it('↑ jets as it always did (the Controls table has two keys a row: W and Space), unless it is given another action', () => {
    expect(toKeyBindings(defaultBindings()).keys.ArrowUp).toBe(Btn.Jet);
    // saved before: only W and Space for jet
    expect(toKeyBindings(sanitizeBindings({ jet: ['KeyW', 'Space'] })).keys.ArrowUp).toBe(Btn.Jet);
    // ↑ bound to something else: that, and no jet
    expect(toKeyBindings(rebind(defaultBindings(), 'dash', 'ArrowUp', 1).bindings).keys.ArrowUp).toBe(Btn.Dash);
    expect(toKeyBindings(rebind(defaultBindings(), 'scoreboard', 'ArrowUp', 1).bindings).keys.ArrowUp).toBeUndefined();
    // jet moved off W and Space: ↑ still jets
    const moved = rebind(rebind(defaultBindings(), 'jet', 'KeyK', 0).bindings, 'jet', 'KeyL', 1).bindings;
    expect([toKeyBindings(moved).keys.ArrowUp, toKeyBindings(moved).keys.Space]).toEqual([Btn.Jet, undefined]);
  });

  it('labels keys, with the keyboard layout when the browser has it', () => {
    expect([keyLabel('KeyA'), keyLabel('Digit1'), keyLabel('Space'), keyLabel('Mouse0'), keyLabel('ArrowUp'), keyLabel('Numpad5')]).toEqual(['A', '1', 'Space', 'Left click', '↑', 'Num 5']);
    expect(keyLabel('KeyQ', new Map([['KeyQ', 'a']]))).toBe('A');
  });
});

const state = (over: Partial<MatchStateMsg> = {}): MatchStateMsg => ({
  type: 0x23,
  phase: MatchPhase.Waiting,
  phaseStartTick: 1000,
  number: 0,
  endReason: 0,
  rules: { timeLimit: 300, killLimit: 20, countdown: 5, ending: 10, postgame: 15, minPlayers: 2, onNoRematch: 'lobby', bots: 4, botLevel: 'normal' },
  mapId: 'movement-test',
  hostId: 2,
  lobby: [
    { id: 2, ready: true, rematch: false, pingMs: 40 },
    { id: 5, ready: false, rematch: false, pingMs: -1 },
  ],
  standings: [
    { id: 5, key: 1, name: 'Kemi', isBot: false, left: false, mvp: false, score: 3, kills: 3, deaths: 1, suicides: 0, assists: 0, damageDealt: 300, damageTaken: 80, headshots: 1, bestStreak: 2 },
    { id: 2, key: 0, name: 'Ade', isBot: false, left: false, mvp: false, score: 1, kills: 1, deaths: 3, suicides: 0, assists: 1, damageDealt: 150, damageTaken: 300, headshots: 0, bestStreak: 1 },
  ],
  results: null,
  ...over,
});

const source = (s: MatchStateMsg, localId = 5, serverTick = 1000): OnlineSource => ({ room: 'KQXMZP', localId, matchState: s, serverTickNow: () => serverTick });

describe('online match and lobby views', () => {
  it('counts down from the phase start the server sent', () => {
    const cd = state({ phase: MatchPhase.Countdown, number: 0 });
    expect(onlineMatchView(source(cd, 5, 1000 + 61))).toMatchObject({ phase: MatchPhase.Countdown, number: 1, secondsLeft: 4 });
    const play = state({ phase: MatchPhase.InProgress, number: 1 });
    expect(onlineMatchView(source(play, 5, 1000 + 60 * 30))).toMatchObject({ secondsLeft: 270, myScore: 3, leaderScore: 3, ready: false, untimed: false });
    const untimed = state({ phase: MatchPhase.InProgress, rules: { ...state().rules, timeLimit: 0 } });
    expect(onlineMatchView(source(untimed, 5, 1000 + 60 * 75))).toMatchObject({ untimed: true, secondsElapsed: 75, secondsLeft: 0 });
  });

  it('results come from ENDING on, the same object while nothing changes', () => {
    const ended = state({ phase: MatchPhase.Ending, results: { number: 1, reason: 1, durationTicks: 3600, winnerKey: 1, mvpKey: 1 } });
    const a = onlineMatchView(source(ended));
    const b = onlineMatchView(source(ended));
    expect(a!.results).toBe(b!.results);
    expect(a!.results!.standings.map((s) => [s.placement, s.name])).toEqual([
      [1, 'Kemi'],
      [2, 'Ade'],
    ]);
    expect(onlineMatchView(source(state({ results: ended.results })))!.results).toBeNull(); // back in the lobby
  });

  it('the lobby: host first, you marked, names from the standings', () => {
    const view = lobbyView(source(state()))!;
    expect(view.players.map((p) => [p.name, p.host, p.you, p.ready, p.pingMs])).toEqual([
      ['Ade', true, false, true, 40],
      ['Kemi', false, true, false, -1],
    ]);
    expect(view).toMatchObject({ isHost: false, ready: false, timeLimit: 300, killLimit: 20, mapName: 'Proving Ground', code: 'KQXMZP' });
    expect(lobbyView(source(state(), 2))!.isHost).toBe(true);
    expect(sameLobby(view, lobbyView(source(state())))).toBe(true);
    expect(sameLobby(view, lobbyView(source(state({ hostId: 5 }))))).toBe(false);
  });

  it("the lobby carries the room's bots, and a change to them is a change (v17)", () => {
    const view = lobbyView(source(state()))!;
    expect(view).toMatchObject({ bots: 4, botLevel: 'normal' });
    const off = lobbyView(source(state({ rules: { ...state().rules, bots: 0 } })))!;
    expect(off.bots).toBe(0);
    expect(sameLobby(view, off)).toBe(false);
    expect(sameLobby(view, lobbyView(source(state({ rules: { ...state().rules, botLevel: 'hard' } }))))).toBe(false);
  });

  it('the lobby: bots filling the room are marked as bots (they never ready up, and needn’t)', () => {
    const withBot = state({
      lobby: [...state().lobby, { id: 7, ready: false, rematch: false, pingMs: -1 }],
      standings: [
        ...state().standings,
        { id: 7, key: 2, name: '[BOT] Badger', isBot: true, left: false, mvp: false, score: 0, kills: 0, deaths: 0, suicides: 0, assists: 0, damageDealt: 0, damageTaken: 0, headshots: 0, bestStreak: 0 },
      ],
    });
    const view = lobbyView(source(withBot))!;
    expect(view.players.map((p) => [p.name, p.isBot])).toEqual([
      ['Ade', false],
      ['Kemi', false],
      ['[BOT] Badger', true],
    ]);
    expect(sameLobby(view, lobbyView(source(state())))).toBe(false);
    expect(onlineMatchView(source(withBot))!.humans).toBe(2);
    // a bot leading: the HUD's leader line names it without the "[BOT]" tag (review M3)
    const botLeads = state({ standings: [{ ...withBot.standings[2]!, score: 9 }, ...state().standings] });
    expect(onlineMatchView(source(botLeads))!.leaderName).toBe('Badger');
  });
});

describe('API client', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const session = (n: number) => ({
    accessToken: `access-${n}`,
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken: `refresh-${n}`,
    user: { id: 'u_1', nickname: 'Ade', isGuest: true, createdAt: '', nicknameChangeableAt: null, level: 1, xp: 0 },
  });

  it('keeps the refresh token in shared storage, refreshes it before authed calls, and says when there is none', async () => {
    const calls: { url: string; body: unknown; auth?: string }[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined, auth: headers.authorization });
      if (url.endsWith('/auth/guest') || url.endsWith('/auth/refresh')) return new Response(JSON.stringify(session(++n)), { status: 201 });
      if (url.endsWith('/rooms')) return new Response(JSON.stringify({ code: 'KQXMZP', roomId: 'KQXMZP', gsUrl: null, ticket: null }), { status: 201 });
      return new Response(JSON.stringify({ error: { code: 'room_not_found', message: 'No room' } }), { status: 404 });
    });
    const api = new Api('/api', fetchImpl as unknown as typeof fetch);
    expect(await api.restore()).toBeNull();
    await api.guest('Ade');
    expect(store.get('session.refreshToken.v1')).toBe('refresh-1');
    expect((await api.createRoom()).code).toBe('KQXMZP');
    expect(calls.at(-1)).toMatchObject({ url: '/api/rooms', auth: 'Bearer access-1' });
    const err = await api.joinRoom('ZZZZZZ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('room_not_found');

    // a new tab: nothing in memory, the stored refresh token restores the session
    const tab = new Api('/api', fetchImpl as unknown as typeof fetch);
    expect((await tab.restore())?.nickname).toBe('Ade');
    expect(calls.at(-1)).toMatchObject({ url: '/api/auth/refresh', body: { refreshToken: 'refresh-1' } });
    expect(store.get('session.refreshToken.v1')).toBe('refresh-2');
  });

  it('a rejected refresh token is forgotten; a network failure is not', async () => {
    store.set('session.refreshToken.v1', 'old');
    const rejected = new Api('/api', (async () => new Response(JSON.stringify({ error: { code: 'session_revoked', message: 'x' } }), { status: 401 })) as unknown as typeof fetch);
    expect(await rejected.restore()).toBeNull();
    expect(store.has('session.refreshToken.v1')).toBe(false);
    store.set('session.refreshToken.v1', 'kept');
    const offline = new Api('/api', (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    const e = (await offline.restore().catch((x: unknown) => x)) as ApiError;
    expect(e.offline).toBe(true);
    expect(store.get('session.refreshToken.v1')).toBe('kept');
  });
});

describe('QR codes', () => {
  it('picks the smallest version, draws finder patterns and a quiet zone', () => {
    const short = encodeQr('https://a.example/r/KQXMZP'); // 26 bytes: exactly version 2-M's capacity
    expect(short.version).toBe(2);
    expect(short.size).toBe(25);
    expect(encodeQr('https://ab.example/r/KQXMZP').version).toBe(3);
    const long = encodeQr(`https://tasks-muscle-adipex-peterson.trycloudflare.com/r/KQXMZP`);
    expect(long.version).toBe(5);
    // finder pattern corners: dark ring, light ring, dark centre
    const at = (x: number, y: number) => long.modules[y * long.size + x];
    for (const [cx, cy] of [
      [3, 3],
      [long.size - 4, 3],
      [3, long.size - 4],
    ])
      expect([at(cx! - 3, cy!), at(cx! - 2, cy!), at(cx!, cy!), at(cx! + 3, cy!)]).toEqual([true, false, true, true]);
    expect(at(8, long.size - 8)).toBe(true); // the dark module
    const svg = qrSvgPath(short);
    expect(svg.viewBox).toBe('0 0 33 33');
    expect(svg.path.startsWith('M4,4h1v1h-1z')).toBe(true);
  });

  it('is stable: this exact code was decoded by a real scanner (macOS Vision) when written', () => {
    let h = 0x811c9dc5;
    for (const m of encodeQr('https://abc-def.trycloudflare.com/r/KQXMZP').modules) h = Math.imul(h ^ (m ? 1 : 0), 0x01000193);
    expect(h >>> 0).toMatchInlineSnapshot(`3876071400`);
  });
});
