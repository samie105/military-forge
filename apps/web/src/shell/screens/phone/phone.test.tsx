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
import { PhoneLobby } from './PhoneLobby';
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
  it('a phone held sideways (a finger, landscape, up to 500 px high); tablets and desktops keep theirs', () => {
    expect(PHONE_QUERY).toBe('(orientation: landscape) and (max-height: 500px) and (pointer: coarse)');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === PHONE_QUERY }));
    expect(isPhoneLayout()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(isPhoneLayout()).toBe(false);
  });
});

describe('the share sheet', () => {
  it('the system sheet when there is one; the link copied when not; a cancelled sheet says nothing', async () => {
    const data = { title: 'Military Forge', text: 'Join my room:', url: 'https://x/r/KMTXRA' };
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
    expect(resultText(view(), results, 0)).toBe('Kemi won on Lunar Outpost in Military Forge: I came 2nd with 6 kills.');
    const draw: MatchResults = { ...results, standings: [standing(1, 'Kemi', 1, { score: 3 }), standing(0, 'Ade', 2, { score: 3, kills: 1 })] };
    expect(resultText(view(), draw, 0)).toBe('A draw on Lunar Outpost in Military Forge: I came 2nd with 1 kill.');
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
  });

  it('offline: Create room and Join wait, Training still works', () => {
    const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: true } as never });
    const html = withCtl(ctl(), <PhoneHome store={store} />);
    expect(html).toContain('Offline');
    expect(html).toMatch(/<button type="button" class="btn btn--ink pm-create m-p8" data-tour="create" disabled="">/);
    expect(html).toMatch(/<button type="button" class="ticket rivets pm-tk m-p3 m-p8" style="--i:3">/); // Training, enabled
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

  it('the host: the code, the share poster first with the QR, the roster (bots ready, no [BOT] tag), the rules, Ready and Start', () => {
    const html = withCtl(ctl(), <PhoneLobby lobby={lobby(true)} />);
    expect(html).toContain('data-screen="m-lobby"');
    expect(html).toMatch(/data-active-state="host not-ready link-idle"/);
    expect(html).toMatch(/pm-code[^>]*>KMTXRA</);
    expect(textOf(html)).toContain('Share room link');
    expect(html).toContain('abc.trycloudflare.com/r/KMTXRA');
    expect(html).toMatch(/<svg viewBox="0 0 \d+ \d+"/); // a real QR
    expect(html).toContain('>Kestrel<');
    expect(html).not.toContain('[BOT]');
    expect(html.match(/prow__ready is-ready/g)).toHaveLength(2); // Kemi, and the bot
    expect(html).toContain('5 min · 20 kills');
    expect(html).toContain('Start');
    // the LAN link and time of day aren't known to the app: not shown (no fake 192.168…)
    expect(html).not.toContain('Same Wi-Fi');
  });

  it('a guest: no Start; the rules read-only', () => {
    const html = withCtl(ctl(), <PhoneLobby lobby={lobby(false)} />);
    expect(html).toMatch(/data-active-state="guest not-ready link-idle"/);
    expect(html).not.toContain('>Start<');
  });

  it('the rules and Ready/Start share one footer (it sticks to the bottom at large text, so the rules stay on screen)', () => {
    const html = withCtl(ctl(), <PhoneLobby lobby={lobby(true)} />);
    const foot = html.slice(html.indexOf('class="pm-roster__foot"'));
    expect(foot).toMatch(/^class="pm-roster__foot"><div class="pm-mission">[\s\S]*class="pm-rules[\s\S]*class="pm-bar"[\s\S]*Ready[\s\S]*Start/);
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

  it('P0 · home: the Local room ticket, lit up offline (Create room says Local works without internet)', () => {
    const online = withCtl(ctl(), <PhoneHome store={createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } as never })} />);
    expect(online).toContain('Local room');
    expect(online).toContain('Works with no internet');
    expect(online).not.toContain('is-hot');
    const offline = withCtl(ctl(), <PhoneHome store={createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: true } as never })} />);
    expect(offline).toContain('pm-tk--local m-p3 m-p8 is-hot');
    expect(offline).toContain('Local room works without it');
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
    expect(html).toContain('Scan host&#x27;s QR');
  });

  it('P2 · lobby: the code to type on the same Wi-Fi, the host\'s QR way in, the LAN ping (real: the lobby\'s own)', () => {
    const host = withCtl(ctl(), <PhoneLobby lobby={local(true)} />);
    expect(textOf(host)).toContain('On this Wi-Fi · Join with code');
    expect(host).toMatch(/pm-lan__how-code[^>]*>KMTXRA</);
    expect(textOf(host)).toContain('Add a player by QR');
    expect(textOf(host)).toContain('Share room link');
    expect(host).not.toContain('Scan to join');
    expect(host).toMatch(/LAN<\/span><span class="num">1 ms/);
    const guest = withCtl(ctl(), <PhoneLobby lobby={local(false)} />);
    expect(textOf(guest)).not.toContain('Add a player by QR');
    expect(textOf(guest)).toContain('Same Wi-Fi only: friends type this code in Join.');
    // no internet at all: no code to type or share, friends join by QR
    const offline = withCtl(ctl(), <PhoneLobby lobby={local(true, '')} />);
    expect(textOf(offline)).not.toContain('Share room link');
    expect(offline).not.toContain('pm-code');
    expect(offline).toContain('Friends join by QR');
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

  it('training: no invitation, "Training still running"', () => {
    const html = withCtl(ctl(), <PhonePause store={store(false)} />);
    expect(html).not.toContain('Invite friends');
    expect(html).toContain('Training still running');
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
    expect(html).not.toContain('pm-hls');
    expect(html).toContain('Lobby');
    expect(html.match(/<i class="on m-p7"><\/i>/g)).toHaveLength(1);
  });

  it('voted: the stamp instead of the button; a guest has no Lobby; no MVP: no card', () => {
    const guest = renderToStaticMarkup(<PhoneResults view={view({ voted: true, votes: 2 })} results={results} actions={actions} room={{ isHost: false, hostId: 1, leave: vi.fn() }} />);
    expect(guest).toContain('Voted');
    expect(guest).not.toContain('>Lobby<');
    const noMvp: MatchResults = { ...results, mvpKey: -1, standings: results.standings.map((s) => ({ ...s, mvp: false })) };
    expect(renderToStaticMarkup(<PhoneResults view={view()} results={noMvp} actions={actions} training={{ leave: vi.fn() }} />)).not.toContain('pm-mvp');
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
    expect(touchTips({ handed: 'right', fire: 'button', swipeDash: true })[1]!.how).toBe('Aim. Hold FIRE to shoot.');
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

  it('the first time in Training the drill teaches instead: the card steps aside', () => {
    const html = withCtl(ctl({ closeTips: vi.fn(), store: createShellStore({ screen: { name: 'training' } }) }), <PhoneTips />);
    expect(html).toBe('');
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

  it('Edit name: the current name, Save allowed as is, Cancel; over Home', () => {
    const store = createShellStore({ profile: { nickname: 'Ade', changeableAt: null, offline: false } as never });
    const html = withCtl(ctl({ checkName: vi.fn(), setName: vi.fn() }), <PhoneNameEntry store={store} first={false} />);
    expect(html).toContain('data-active-state="same"');
    expect(html).toContain('value="Ade"');
    expect(html).toMatch(/pm-id__name[^>]*>Ade</);
    expect(html).toMatch(/<button type="submit"(?![^>]*disabled)[^>]*>Save/);
    expect(html).toContain('Cancel');
    expect(html).toContain('mf-fit--modal');
  });
});
