/** The phone menus (m-home, m-lobby, m-pause, m-results): what they show from the store, the share sheet, when they apply. */
import { MatchEndReason, MatchPhase, ticks, type MatchResults, type MatchStanding } from '@military-forge/sim';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ControllerContext } from '../../context';
import type { ShellController } from '../../controller';
import type { MatchView } from '../../matchView';
import type { LobbyView } from '../../onlineView';
import { createShellStore } from '../../store';
import { PHONE_QUERY, isPhoneLayout } from './layout';
import { PhoneHome } from './PhoneHome';
import { PhoneJoin } from './PhoneJoin';
import { PhoneLanAddPlayer, PhoneLanJoin } from './PhoneLan';
import { PhoneLobby, phoneOrder } from './PhoneLobby';
import { PhoneNameEntry } from './PhoneNameEntry';
import { PhonePause } from './PhonePause';
import { PhoneResults, resultText } from './PhoneResults';
import { PhoneSettings, phoneTab } from './PhoneSettings';
import { PhoneTips, touchTips } from './PhoneTips';
import { shareData } from './parts';

beforeAll(() => vi.stubGlobal('location', { origin: 'https://abc.trycloudflare.com', host: 'abc.trycloudflare.com', protocol: 'https:', search: '' }));
afterAll(() => vi.unstubAllGlobals());

const actions = { playAgain: vi.fn(), backToLobby: vi.fn(), ready: vi.fn() };
const ctl = (over: Partial<Record<keyof ShellController, unknown>> = {}) =>
  ({ store: createShellStore({ screen: { name: 'home' } }), host: { online: null }, go: vi.fn(), openOverlay: vi.fn(), openSettings: vi.fn(), closeOverlay: vi.fn(), leave: vi.fn(), canTune: () => false, openTuning: vi.fn(), api: { ping: () => Promise.resolve(30) }, ...over }) as unknown as ShellController;
const withCtl = (c: ShellController, node: React.ReactNode) => renderToStaticMarkup(<ControllerContext.Provider value={c}>{node}</ControllerContext.Provider>);
/** The words a screen reads, without its markup (a label may be split for large text). */
const textOf = (html: string) => html.replace(/<[^>]+>/g, '');

const view = (over: Partial<MatchView> = {}): MatchView => ({
  phase: MatchPhase.Ending,
  number: 1,
  secondsLeft: 0,
  untimed: false,
  secondsElapsed: 0,
  killLimit: 10,
  timeLimit: 300,
  countdownTotal: 3,
  mapName: 'Lunar Outpost',
  localId: 0,
  myScore: 6,
  leaderScore: 10,
  leaderName: 'Kemi',
  ready: false,
  votes: 1,
  humans: 3,
  voted: false,
  results: null,
  ...over,
});
const standing = (id: number, name: string, placement: number, over: Partial<MatchStanding> = {}): MatchStanding => ({
  placement,
  id,
  key: id + 100,
  name,
  isBot: false,
  left: false,
  score: 0,
  kills: 0,
  deaths: 0,
  suicides: 0,
  assists: 0,
  damageDealt: 0,
  damageTaken: 0,
  headshots: 0,
  bestStreak: 0,
  rating: 0,
  mvp: false,
  ...over,
});
const results: MatchResults = {
  number: 1,
  reason: MatchEndReason.KillLimit,
  durationTicks: ticks(222),
  winnerKey: 101,
  mvpKey: 101,
  standings: [standing(1, 'Kemi', 1, { score: 10, kills: 10, deaths: 3, bestStreak: 5, mvp: true }), standing(0, 'Ade', 2, { score: 6, kills: 6, deaths: 4 }), standing(2, '[BOT] Kestrel', 3, { isBot: true, kills: 1 })],
};

describe('when the phone menus apply', () => {
  it('a phone held sideways (a finger, landscape, up to 500 px high); a desktop keeps its own (tablets: test/readable.test.ts)', () => {
    expect(PHONE_QUERY).toBe('(orientation: landscape) and (max-height: 500px) and (pointer: coarse)');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === PHONE_QUERY }));
    expect(isPhoneLayout()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(isPhoneLayout()).toBe(false);
  });
});

describe('the share sheet', () => {
  it('the system sheet when there is one; the link copied when not; a cancelled sheet says nothing', async () => {
    const data = { title: 'Forged Force', text: 'Join my room:', url: 'https://x/r/KMTXRA' };
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
    expect(await shareData(data, { share: () => Promise.resolve(), clipboard } as never)).toBe('shared');
    const abort = Object.assign(new Error('no'), { name: 'AbortError' });
    expect(await shareData(data, { share: () => Promise.reject(abort), clipboard } as never)).toBe('cancelled');
    expect(await shareData(data, { clipboard } as never)).toBe('copied');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('Join my room: https://x/r/KMTXRA');
    // a sheet that fails for another reason falls back to copying
    expect(await shareData(data, { share: () => Promise.reject(new Error('denied')), clipboard } as never)).toBe('copied');
    expect(await shareData(data, { clipboard: { writeText: () => Promise.reject(new Error('blocked')) } } as never)).toBe('failed');
  });

  it('a shared result says who won, where, and how you did', () => {
    expect(resultText(view(), results, 0)).toBe('Kemi won on Lunar Outpost in Forged Force: I came 2nd with 6 kills.');
    const draw: MatchResults = { ...results, standings: [standing(1, 'Kemi', 1, { score: 3 }), standing(0, 'Ade', 2, { score: 3, kills: 1 })] };
    expect(resultText(view(), draw, 0)).toBe('A draw on Lunar Outpost in Forged Force: I came 2nd with 1 kill.');
  });
});

describe('m-home', () => {
  it("the kit's home: the brand once, Create room, Join, Training, your name, the nav", () => {
    // (server rendering reads a store's initial state: the state goes in at creation)
    const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } as never });
    const html = withCtl(ctl(), <PhoneHome store={store} />);
    expect(html).toContain('data-screen="m-home"');
    expect(html).toContain('mf-fit--phone kit-v2');
    expect(html.match(/data-bind="brand\.name"/g)).toHaveLength(1);
    for (const t of ['Create room', 'Join', 'Training', 'Locker', 'Armory', 'Settings', '>Ade<']) expect(html).toContain(t);
    // Quick match's key art: a fight from the game itself, decoration only (owner 31 Oct)
    expect(html).toMatch(/pm-poster mf-qm[^>]*><span class="mf-qm__art" aria-hidden="true"><img class="mf-qm__img" src="\/assets\/posters\/quick-match\.webp" srcSet="[^"]*quick-match@2x\.webp 1520w"/);
  });

  it('offline: Training is the poster (UX-15), Create room waits and says why, Join and First flight still work', () => {
    const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: true } as never });
    const html = withCtl(ctl(), <PhoneHome store={store} />);
    expect(html).toContain('Offline');
    // the one primary is Training (offline, Play now would only train anyway); Create room the smaller second, waiting
    expect(html).toMatch(/<button type="button" class="btn btn--ink pm-create pm-play m-p8" data-tour="play" data-pad-first="true" data-home-primary="">.*?Training<\/button>/);
    expect(textOf(html)).not.toContain('Play now');
    expect(html).toMatch(/<button type="button" class="btn btn--ghost btn--sm pm-create-room m-p8" data-tour="create" disabled="" aria-description="Needs a connection">/);
    expect(html).toMatch(/<button type="button" class="ticket rivets pm-tk m-p3 m-p8" style="--i:2" data-tour="join">/); // Join, enabled (a local room's code)
    expect(textOf(html)).toContain('First flight');
  });
});

describe('m-lobby', () => {
  const lobby = (isHost: boolean): LobbyView => ({
    code: 'KMTXRA',
    players: [
      { id: 0, name: 'Ade', ready: false, host: true, you: isHost, isBot: false, pingMs: 24 },
      { id: 1, name: 'Kemi', ready: true, host: false, you: !isHost, isBot: false, pingMs: 60 },
      { id: 2, name: '[BOT] Kestrel', ready: false, host: false, you: false, isBot: true, pingMs: -1 },
    ],
    isHost,
    ready: false,
    minPlayers: 2,
    timeLimit: 300,
    killLimit: 20,
    mapId: 'lunar-outpost',
    mapName: 'Lunar Outpost',
    bots: 4,
    botLevel: 'normal',
  });

  it('the host: the code, a compact share card (Share link, the QR behind Show QR), the roster (bots ready, no [BOT] tag), the rules, Start now', () => {
    const html = withCtl(ctl(), <PhoneLobby lobby={lobby(true)} />);
    expect(html).toContain('data-screen="m-lobby"');
    expect(html).toMatch(/data-active-state="host not-ready link-idle"/);
    expect(html).toMatch(/pm-code[^>]*>KMTXRA</);
    // UX-23: the left column's card has the code as its headline, Share link in volt, the QR folded away
    const side = html.slice(html.indexOf('class="pm-lobby__side"'), html.indexOf('pm-roster'));
    expect(side).toMatch(/<b class="display pm-sharecard__code num"[^>]*>KMTXRA<\/b>/);
    expect(side).toMatch(/<button type="button" class="btn btn--volt pm-sharecard__share m-p8">(?:(?!<\/button>).)*Share link<\/button>/);
    expect(side).toMatch(/aria-pressed="false" aria-controls="pm-room-qr" aria-label="Show QR"/);
    expect(side).not.toContain('class="qr"');
    expect(html).toContain('>Kestrel<');
    expect(html).not.toContain('[BOT]');
    // the host starts it, so reads Ready (UX-21): Ade, Kemi and the bot
    expect(html.match(/prow__ready is-ready/g)).toHaveLength(3);
    expect(textOf(html)).toContain('2 of 2 players ready · bots are always ready');
    expect(html).toContain('5 min · 20 kills');
    // the room's map by its poster beside its name
    expect(html).toMatch(/<img class="mapart pm-mission__art" src="\/assets\/posters\/lunar-outpost-card\.webp"[^>]*><b data-bind="lobby\.map\.name">Lunar Outpost</);
    // the LAN link and time of day aren't known to the app: not shown (no fake 192.168…)
    expect(html).not.toContain('Same Wi-Fi');
  });

  it('the host has one action, Start now, volt and across the column; no Ready (UX-21)', () => {
    const html = withCtl(ctl(), <PhoneLobby lobby={lobby(true)} />);
    const bar = html.slice(html.indexOf('class="pm-bar pm-bar--go"'));
    expect(bar).toMatch(/^class="pm-bar pm-bar--go"><button type="button" class="btn btn--volt m-p8 mf-glow" data-pad-first="true"[^>]*>(?:(?!<\/button>).)*Start now<\/button><\/div>/);
    expect(textOf(html)).not.toMatch(/Ready(?! ·)(?!Kemi|Kestrel|Lunar)/);
    expect(html).not.toMatch(/>(Ready|Not ready|Wait)<\/button>/);
    expect(html).not.toContain('>Wait<');
  });

  it('a guest: Ready (volt), then the "You\'re ready" stamp with Not ready; no Start; the same words as the desktop', () => {
    const html = withCtl(ctl(), <PhoneLobby lobby={lobby(false)} />);
    expect(html).toMatch(/data-active-state="guest not-ready link-idle"/);
    expect(html).not.toContain('Start now');
    expect(html).toMatch(/<div class="pm-bar pm-bar--go"><button type="button" class="btn btn--volt m-p8" data-pad-first="true">(?:(?!<\/button>).)*Ready<\/button><\/div>/);
    const notReady = withCtl(ctl(), <PhoneLobby lobby={{ ...lobby(false), players: lobby(false).players.map((p) => (p.you ? { ...p, ready: false } : p)) }} />);
    expect(notReady).toContain('Not ready</span>');
    expect(textOf(notReady)).toContain('1 of 2 players ready · bots are always ready');
    const ready = withCtl(ctl(), <PhoneLobby lobby={{ ...lobby(false), ready: true }} />);
    expect(ready).toMatch(/<span class="stamp stamp--ok pm-ready m-p7" role="status">(?:(?!<\/span>).)*You&#x27;re ready<\/span><button type="button" class="btn btn--ghost btn--sm pm-unready m-p8" data-pad-first="true">Not ready<\/button>/);
  });

  it('the roster puts the host, then you, then the other people, then the bots (a guest sees their own row)', () => {
    const bot = { id: 3, name: '[BOT] Mantis', ready: false, host: false, you: false, isBot: true, pingMs: -1 };
    const other = { id: 4, name: 'Tobi', ready: false, host: false, you: false, isBot: false, pingMs: 40 };
    const players = [...lobby(false).players.slice(0, 2), lobby(false).players[2]!, other, bot];
    // Ade hosts, Kemi is you, Kestrel a bot that joined before Tobi
    expect(phoneOrder([players[2]!, players[4]!, players[3]!, players[1]!, players[0]!]).map((p) => p.name)).toEqual(['Ade', 'Kemi', 'Tobi', '[BOT] Kestrel', '[BOT] Mantis']);
  });

  it('the rules and the one action share one footer (it sticks to the bottom at large text, so the rules stay on screen)', () => {
    const html = withCtl(ctl(), <PhoneLobby lobby={lobby(true)} />);
    const foot = html.slice(html.indexOf('class="pm-roster__foot"'));
    expect(foot).toMatch(/^class="pm-roster__foot"><div class="pm-mission"><button type="button" class="pm-rules[\s\S]*class="pm-bar pm-bar--go"[\s\S]*Start now/);
  });

  it('a spectator (v20): Join next round in Ready\'s place, Stay watching once in line, no warm-up', () => {
    // (a server render reads the store's first state: a fresh store for each)
    const store = createShellStore({ spectating: true, spectateQueue: 0 });
    const watched = { ...lobby(false), players: lobby(false).players.map((p) => ({ ...p, you: false })) };
    const html = withCtl(ctl({ store }), <PhoneLobby lobby={watched} />);
    expect(html).toMatch(/data-active-state="guest not-ready link-idle watching"/);
    const bar = textOf(html.slice(html.indexOf('class="pm-bar"')));
    expect(bar).toContain("You're watching · you'll play when a slot opens".replace(/'/g, '&#x27;'));
    expect(bar).toContain('Join next round');
    expect(bar).not.toContain('Ready');
    expect(html).not.toContain('Warm up');
    const queued = textOf(withCtl(ctl({ store: createShellStore({ spectating: true, spectateQueue: 1 }) }), <PhoneLobby lobby={watched} />));
    expect(queued).toContain('Stay watching');
    expect(queued).not.toContain('Join next round');
  });
});

describe('local rooms (the Pen board P0–P5)', () => {
  const local = (isHost: boolean, code = 'KMTXRA'): LobbyView => ({
    code,
    local: true,
    players: [
      { id: 0, name: 'Ade', ready: false, host: true, you: isHost, isBot: false, pingMs: 1 },
      { id: 1, name: 'Kemi', ready: true, host: false, you: !isHost, isBot: false, pingMs: 3 },
    ],
    isHost,
    ready: false,
    minPlayers: 2,
    timeLimit: 300,
    killLimit: 20,
    mapId: 'lunar-outpost',
    mapName: 'Lunar Outpost',
    bots: 4,
    botLevel: 'normal',
  });

  it('P0 · home: the Local room ticket, lit up offline; the poster says the one offline line (audit 28 Oct)', () => {
    const online = withCtl(ctl(), <PhoneHome store={createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } as never })} />);
    expect(online).toContain('Local room');
    expect(online).toContain('Works with no internet');
    expect(online).not.toContain('is-hot');
    const offline = withCtl(ctl(), <PhoneHome store={createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: true } as never })} />);
    expect(offline).toContain('pm-tk--local m-p3 m-p8 is-hot');
    // one offline line on Home (audit 28 Oct); the local room's ticket says it works with no internet
    expect(offline).toContain("Can&#x27;t reach the server. Training with bots still works.");
    expect(offline).toContain('Works with no internet');
  });

  it('P1 · Join with code: six boxes the keyboard Go submits, none focused on arrival; the no-internet card', () => {
    const html = withCtl(ctl(), <PhoneJoin />);
    expect(html).toContain('data-screen="m-join"');
    expect(html.match(/<input [^>]*enterKeyHint="go"/g)).toHaveLength(6);
    expect(html).not.toContain('autofocus');
    expect(html).toMatch(/<button type="button" class="btn btn--volt m-p8 pm-join__go" disabled=""/);
    // Watch beside Join: the same code as a spectator, waiting for the same six letters
    expect(html).toMatch(/<button type="button" class="btn btn--ghost m-p8 pm-join__paste pm-join__watch" data-hook="watch" disabled=""/);
    expect(html).toContain('No internet?');
    expect(html).toContain('Swap QR codes');
  });

  it("P2 · lobby: ONE QR (the room link: a phone's camera lands in the room) and the code; the QR swap a fallback; the LAN ping (real: the lobby's own)", () => {
    const host = withCtl(ctl(), <PhoneLobby lobby={local(true)} />);
    expect(textOf(host)).toContain('Scan to join');
    expect(host).toMatch(/pm-lan__how-code[^>]*>KMTXRA</);
    expect(host).toMatch(/class="qr pm-lan__qr"[^>]*aria-label="QR code for room KMTXRA/);
    expect(textOf(host)).toContain('Same Wi-Fi: phone camera at the code, or type it in Join.');
    expect(textOf(host)).toContain('No internet? Swap QR codes');
    expect(textOf(host)).toContain('Share room link');
    expect(host).toMatch(/LAN<\/span><span class="num">1 ms/);
    const guest = withCtl(ctl(), <PhoneLobby lobby={local(false)} />);
    expect(textOf(guest)).toContain('Scan to join');
    expect(textOf(guest)).not.toContain('Swap QR codes');
    // no internet at all: no code to type or share, friends join by QR
    const offline = withCtl(ctl(), <PhoneLobby lobby={local(true, '')} />);
    expect(textOf(offline)).not.toContain('Share room link');
    expect(offline).not.toContain('pm-lan__qr');
    expect(offline).toContain('Friends join by QR');
    expect(textOf(offline)).toContain('Add a player by QR');
  });

  it('P3 · add a player: the code on paper, their reply (no camera here: the paste row says why), 48 px targets', () => {
    expect(withCtl(ctl(), <PhoneLanAddPlayer />)).toContain('Only the room&#x27;s host');
    const lan = { newOffer: vi.fn(() => new Promise(() => {})), acceptAnswer: vi.fn() };
    const html = withCtl(ctl({ host: { online: null, lan } }), <PhoneLanAddPlayer />);
    expect(html).toContain('data-screen="m-lan"');
    expect(html).toContain('1 · They scan this');
    expect(html).toContain('Making a code…');
    expect(html).toContain('can&#x27;t read QR codes');
    expect(html).toContain('Let in');
    expect(html).toContain('aria-label="Paste"');
  });

  it('P4 · join: the steps (1 Scan on), the host\'s code pasted when there is no camera', () => {
    const html = withCtl(ctl(), <PhoneLanJoin />);
    expect(html).toContain('data-screen="m-lan"');
    expect(html).toMatch(/<li class="is-on" aria-current="step"><span class="num">1<\/span>Scan<\/li>/);
    expect(html).toContain('Scan the host&#x27;s QR');
    expect(html).toContain('placeholder="…or paste the host&#x27;s code"');
    expect(html).toContain('can&#x27;t read QR codes');
  });
});

describe('m-pause', () => {
  const store = (room: boolean) => createShellStore({ screen: room ? { name: 'room', code: 'KMTXRA' } : { name: 'training' }, match: view({ phase: MatchPhase.InProgress, secondsLeft: 222 }) });

  it('in a room: Resume, Invite friends, Settings, Leave, and the sitrep; Tune the game only where the host may tune', () => {
    const html = withCtl(ctl(), <PhonePause store={store(true)} />);
    expect(html).toContain('data-screen="m-pause"');
    for (const t of ['Resume', 'Invite friends', 'Settings', 'Leave', 'Sitrep · Lunar Outpost', '3:42', 'Lead · Kemi']) expect(html).toContain(t);
    expect(html).not.toContain('Tune the game');
    expect(withCtl(ctl({ canTune: () => true }), <PhonePause store={store(true)} />)).toContain('Tune the game');
  });

  it('training: no invitation; it really pauses, so it says "Paused" (audit 28 Oct)', () => {
    const html = withCtl(ctl(), <PhonePause store={store(false)} />);
    expect(html).not.toContain('Invite friends');
    expect(html).toContain('Training on hold');
    expect(html).toMatch(/pm-pause__t[^>]*>Paused</);
  });

  it("an online match can't pause: it says so, and Leave sits under the list, outside its scroll (audit 28 Oct)", () => {
    const html = withCtl(ctl(), <PhonePause store={store(true)} />);
    expect(html).toContain('Online play can&#x27;t pause');
    expect(html).toMatch(/pm-pause__t[^>]*>Match continues</);
    expect(html).not.toContain('>Paused<');
    expect(html).toMatch(/pm-pause__list.*<\/div><button[^>]*pm-pause__leave[^>]*>.*Leave match/);
  });
});

describe('m-results', () => {
  it('the MVP card, your place, who won and why, Share, the vote; the kit highlight tiles stay out (no data yet)', () => {
    const html = renderToStaticMarkup(<PhoneResults view={view({ results })} results={results} actions={actions} room={{ isHost: true, hostId: 0, leave: vi.fn() }} code="KMTXRA" />);
    expect(html).toContain('data-screen="m-results"');
    expect(html).toMatch(/data-active-state="kill-limit host not-voted mvp"/);
    expect(html).toMatch(/mvp__name[^>]*>Kemi</);
    expect(html).toMatch(/<b class="num">10<\/b>kills/);
    expect(html).toMatch(/<b class="num">5<\/b>streak/);
    expect(html).toMatch(/stamp stamp--paper[^>]*>2nd</);
    expect(html).toContain('Kill limit reached · 10 kills');
    expect(html).toContain('Kemi wins');
    expect(html).toContain('Share the result');
    // Play again is the one primary action, the vote inside it; the headline comes first; sharing is paper (UX-40, UX-41)
    expect(html.match(/btn--volt/g)).toHaveLength(1);
    expect(html).toMatch(/<button type="button" class="btn btn--volt btn--block[^"]*"[^>]*data-pad-first="true">.*?Play again<span class="pm-res__votes">.*?results\.votes/);
    expect(html).toMatch(/btn--paper btn--block btn--sm[^"]*"[^>]*>.*?Share the result/);
    expect(html.indexOf('results.winner')).toBeLessThan(html.indexOf('Play again'));
    expect(html.indexOf('Play again')).toBeLessThan(html.indexOf('Share the result'));
    expect(html).not.toContain('Play again?');
    expect(html).not.toContain('pm-hls');
    expect(html).toContain('Lobby');
    expect(html.match(/<i class="on m-p7"><\/i>/g)).toHaveLength(1);
  });

  it('voted: the stamp instead of the button; a guest has no Lobby; no MVP: no card', () => {
    const guest = renderToStaticMarkup(<PhoneResults view={view({ voted: true, votes: 2 })} results={results} actions={actions} room={{ isHost: false, hostId: 1, leave: vi.fn() }} />);
    expect(guest).toMatch(/btn--volt btn--block[^"]*"[^>]*disabled="">.*?Voted<span class="pm-res__votes">/);
    expect(guest).toContain('role="status">2 of 3 voted to play again</span>');
    expect(guest).not.toContain('>Lobby<');
    const noMvp: MatchResults = { ...results, mvpKey: -1, standings: results.standings.map((s) => ({ ...s, mvp: false })) };
    expect(renderToStaticMarkup(<PhoneResults view={view()} results={noMvp} actions={actions} training={{ leave: vi.fn() }} />)).not.toContain('pm-mvp');
    // a 0–0 match decorates nobody (UX-41)
    const blank: MatchResults = { ...results, standings: [standing(1, 'Kemi', 1, { mvp: true }), standing(0, 'Ade', 2)] };
    expect(renderToStaticMarkup(<PhoneResults view={view()} results={blank} actions={actions} room={{ isHost: true, hostId: 0, leave: vi.fn() }} />)).not.toContain('pm-mvp');
  });

  it("training (solo): no vote, Play again leads and Leave below, and a bot's MVP card doesn't take the screen (audit 28 Oct, audit 2 P-03)", () => {
    const html = renderToStaticMarkup(<PhoneResults view={view({ humans: 1 })} results={results} actions={actions} training={{ leave: vi.fn() }} />);
    expect(html).not.toContain('Play again?');
    expect(html).not.toContain('results.votes');
    expect(html).toMatch(/btn--volt btn--block[^"]*"[^>]*>.*?Play again.*Share the result.*pm-res__more.*Leave/);
    expect(html).toContain('XP counts in online matches only.');
    expect(html).not.toContain('>Lobby<');
    expect(html).not.toContain('pm-mvp');
    expect(html).toMatch(/results\.winner">2nd place · Kemi won</);
  });
});

describe('m-results alone against bots (audit 2 P-02, P-03)', () => {
  const alone: MatchResults = { ...results, standings: [standing(2, '[BOT] Kestrel', 1, { isBot: true, score: 9, kills: 9, mvp: true }), standing(0, 'Ade', 2, { score: 2, kills: 2 }), standing(3, '[BOT] Mantis', 3, { isBot: true, score: 1 })] };
  it('the player is the headline, no bot MVP card, Play again leads (no vote to count)', () => {
    const html = renderToStaticMarkup(<PhoneResults view={view({ humans: 1 })} results={alone} actions={actions} room={{ isHost: true, hostId: 0, code: 'KMTXRA', leave: vi.fn() }} code="KMTXRA" />);
    // the bot that won says it is one: its avatar's badge and the Bot tag before its name (UX-40)
    expect(html).toMatch(/results\.winner">2nd place · <span class="tag tag--bot pm-result__bot">.*?Bot<\/span>Kestrel won</);
    expect(html).toMatch(/pm-result__av[^>]*>.*?avatar__bot/);
    expect(html).not.toContain('pm-mvp');
    expect(html).not.toContain('results.votes');
    expect(html).toMatch(/btn--volt btn--block[^"]*"[^>]*>.*?Play again/);
    expect(html).toMatch(/btn--ghost btn--block btn--sm[^"]*"[^>]*>.*?Share the result/);
  });
});

describe('phone settings', () => {
  it('Touch first with Edit and Reset layout; Graphics, Audio, Access, Network; no key bindings on a phone', () => {
    const store = createShellStore({ settingsTab: 'touch' });
    const c = ctl({ back: vi.fn(), setSettingsTab: vi.fn(), updateSettings: vi.fn(), host: { online: null, autoGraphics: 'low' } });
    const html = withCtl(c, <PhoneSettings store={store} />);
    expect(html).toContain('data-screen="m-settings"');
    for (const t of ['Touch', 'Graphics', 'Audio', 'Access', 'Network', 'Edit', 'Reset', 'Left-handed', 'Aim assist', 'Done']) expect(html).toContain(t);
    expect(html).not.toContain('Controls');
    expect(phoneTab('controls')).toBe('touch');
    expect(phoneTab('audio')).toBe('audio');
    const access = withCtl(c, <PhoneSettings store={createShellStore({ settingsTab: 'accessibility' })} />);
    for (const t of ['Text size', 'Reduce motion', 'Reduce flashes', 'Soften loud bursts', 'Colour-blind teams']) expect(access).toContain(t);
  });
});

describe('touch tips (the first-run card on a phone)', () => {
  it('what each thumb does, in the player\'s own touch settings', () => {
    const right = touchTips({ handed: 'right', fire: 'pull', swipeDash: true });
    expect(right.map((t) => t.what)).toEqual(['Left dial', 'Right dial', 'Grenade']);
    expect(right[0].how).toBe('Move. Up flies, down crouches, a flick dashes.');
    expect(right[1].how).toBe('Aim. Push past the ring to fire.');
    expect(touchTips({ handed: 'right', fire: 'auto', swipeDash: true })[1]!.how).toBe('Aim. It fires by itself at someone in your sights.');
    expect(touchTips({ handed: 'right', fire: 'button', swipeDash: true })[1]!.how).toBe('Aim. Hold Fire to shoot.');
    expect(right[2].how).toBe('Tap: throw. Swipe ↑↓: switch. Hold and drag: aim.');
    expect(touchTips({ handed: 'right', fire: 'pull', swipeDash: true, gestures: false })[2]!.how).toBe('Hold to aim, let go to throw.');
    const left = touchTips({ handed: 'left', fire: 'release', swipeDash: false });
    expect(left.map((t) => t.what)).toEqual(['Right dial', 'Left dial', 'Grenade']);
    expect(left[0].how).not.toContain('dash');
    expect(left[1].how).toBe('Aim, then lift to fire.');
  });

  it('no keys, no mouse: the dials, Got it and Learn (the drill)', () => {
    const html = withCtl(ctl({ closeTips: vi.fn() }), <PhoneTips />);
    expect(html).toContain('data-screen="m-tips"');
    for (const t of ['Left dial', 'Right dial', 'Grenade', 'Got it', 'aria-label="Learn the controls"']) expect(html).toContain(t);
    for (const t of ['kbd', 'Mouse', 'Esc', 'Change keys', 'SHIFT', 'Space']) expect(html).not.toContain(t);
    expect(html).not.toContain('autofocus');
  });

  it('in Training the card shows too: the drill never starts by itself (the owner, 24 Oct), only from Learn', () => {
    const html = withCtl(ctl({ closeTips: vi.fn(), store: createShellStore({ screen: { name: 'training' } }) }), <PhoneTips />);
    expect(html).toContain('data-screen="m-tips"');
    expect(html).toContain('aria-label="Learn the controls"');
  });
});

describe('phone name entry', () => {
  it('first visit: the card, the name field (not focused: the keyboard waits for a tap), Continue held until the name checks out, Pick one for me', () => {
    const html = withCtl(ctl({ checkName: vi.fn(), setName: vi.fn() }), <PhoneNameEntry store={createShellStore()} first />);
    expect(html).toContain('data-screen="m-name"');
    expect(html).toContain('data-active-state="empty"');
    expect(html).toContain('aria-label="Your name"');
    expect(html).toContain('enterKeyHint="go"');
    expect(html).not.toContain('autofocus');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Continue/);
    expect(html).toContain('Pick one for me');
    expect(html).not.toContain('Cancel');
    expect(html).not.toContain('mf-fit--modal');
    expect(html).not.toMatch(/kbd|Enter/);
  });

  it('Edit name: the current name, its own headline, Save off until the name changes (UX-07), Cancel; over Home', () => {
    const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } as never });
    const html = withCtl(ctl({ checkName: vi.fn(), setName: vi.fn() }), <PhoneNameEntry store={store} first={false} />);
    expect(html).toContain('data-active-state="same"');
    expect(html).toContain('value="Ade"');
    expect(html).toMatch(/pm-id__name[^>]*>Ade</);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save/);
    expect(html).toContain('Change your name');
    expect(html).not.toContain('What do we call you?');
    expect(html).toContain('maxLength="16"');
    expect(html).toContain('Cancel');
    expect(html).toContain('mf-fit--modal');
  });
});
