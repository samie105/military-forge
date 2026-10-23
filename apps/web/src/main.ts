/**
 * Web client entry point. Two faces:
 *
 * The app (production builds; in dev at /r/CODE, ?room=CODE or ?app): the shell's home screen,
 * names, rooms by code with friends, training, settings. The shell starts and stops game modes
 * through the GameHost below; the map turns slowly behind the menus. Everything, online games
 * included, is drawn in 3D where WebGL runs; ?render=2d keeps the 2D view, and so do machines
 * whose WebGL can't start or only runs in software, and any while its context is lost.
 *
 * The Phase 0 debug client (dev builds at /):
 *   /            local mode: a deathmatch against three Normal bots (results, Play again) + live tuning, rendered in 3D;
 *                ?bots=<0-12>&botlevel=easy|normal|hard (?bots=0: the dummy targets)
 *   /?map=flux-lab   local mode on another map: street-market (W8's kit, drawn by render3d/environment),
 *                    lunar-outpost, storm-front, flux-lab (map mechanics demos, docs/02 §20), mechanics-test,
 *                    movement-test (default). Online, the server picks (--map=).
 *   /?time=60&kills=5&countdown=3       local match rules (0 = no limit); /?sandbox: free play, no match
 *   /?render=2d  the canvas-2D view instead (3D is the default, online too); ?gfx=low|medium|high;
 *                ?softgl accepts software WebGL for 3D (automated browsers always do; players on it get 2D)
 *   /?online     joins the dev room on ws://<host>:9001 (open in two tabs to play each other)
 *   /?server=ws://host:port&name=Ade   explicit server and name
 *   /?online&rtt=150&loss=2&jitter=5    network conditioner (or ?netsim=up.lat=20,down.lat=120,…)
 *   /?online&lowbw                      low-bandwidth mode (30 Hz inputs, 15 Hz snapshots)
 *   /?online&transport=ws|wt            force WebSocket / WebTransport (default: WT when the server has a gateway)
 */
import { DEFAULT_LOADOUT, DEMO_MAPS, cosmeticLoadoutWireIds, defaultTuning, getMap, maps, weapons, type MapDef } from '@military-forge/content';
import { createConditionerSettings, parseNetSim } from '@military-forge/netcode';
import { GAME_NAME } from '@military-forge/shared';
import { Btn, MatchPhase, type Input, type SimEvent } from '@military-forge/sim';
import { audio, startAudio } from './audio';
import { Camera } from './camera';
import { fxFrame, fxState, setReduceFlashes } from './fx';
import { autoPreset, deviceHints, gpuRenderer } from './gfxAuto';
import { createHostTuning, tuningOffered } from './hostTuning';
import { splitTuneChange, tuneChanges, tuneToastParts } from './shell/tune';
import { InputSampler } from './input';
import { localBots } from './localBots';
import { warmNavGraph } from './navWarm';
import { Minimap } from './minimap/minimap';
import { capText } from './ui/icons';
import { LoadoutSync } from './locker/accountSync';
import { PresenceBeat } from './presence';
import { LocalMode } from './localMode';
import { OnlineMode } from './onlineMode';
import { mountHud, type ScoreRow } from './hud';
import { LanHost } from './lan/host';
import { connectAnswered, joinByCode, lanSignalUrl, normalizeLanCode } from './lan/guest';
import { Renderer, type RenderOptions } from './render';
import { localMatchRules, mountShell, registerRoute, type GameHost, type Settings } from './shell';
import { loadSettings } from './shell/controller';
import type { GraphicsSetting } from './shell/store';
import { toKeyBindings, uiCodes } from './shell/controls';
import { PlaneCamera, create3d, online3d, parsePreset, softwareGl, type PresetName } from './render3d';
import { LoadoutDirectory } from './render3d/character';
import { followLooks, lookBook } from './looks/book';
import { CharacterAssembler } from './character';
import { getAvatar, getPortrait, installPortraits, portraits, setPortraitPolicy, type PortraitPolicy } from './portrait';
import { warmRoomPortraits } from './presentation/warm';
import { posterUp } from './presentation/state';
import { countFrame, framesPerSecond, recordNet } from './stats';
import { isTouchDevice, mountTouch } from './touch';
import { applyPadSettings, currentDevice, mountGamepad, onInputDevice } from './gamepad';
import { mountAdClicks } from './ads';
import { padShownBindings } from './gamepad/prompts';
import { startLandscape } from './ui/landscape';
import { startMultiTouchTaps } from './ui/multiTouchTap';
import type { Frame } from './view';
import { DefaultLoadingManager } from 'three';
import { assetLoad } from './assetLoad';
import { creatorSeen } from './creator/model';
import { titleWanted } from './shell/title';
import { startTourMemory, type TourMemory } from './tour';
import { mountTourReadout } from './tour/readout';
import { BackdropPacer } from './ui/backdrop';
import { releaseLanding } from './ui/landing';
import { startLowEnd } from './ui/lowEnd';
import './ui/lowend.css';
import { Spotlight } from './ui/spotlight';
import { voiceChat } from './voice';
import { SpectateDirector, ZOOM_LEVELS, type SpectateView } from './spectate/director';
import { SpectateInput } from './spectate/input';
import { SpectatePicker } from './spectate/picker';

const params = new URLSearchParams(location.search);
/** the player-facing app, or (dev builds at `/`) the Phase 0 debug client */
const appMode = !import.meta.env.DEV || params.has('app') || params.has('room') || location.pathname.startsWith('/r/');
/** the debug client in a local room (lan/): `?lanhost` hosts one, `?lanjoin=CODE` joins one (the app has its own screens) */
const lanHostParam = !appMode && params.has('lanhost');
const lanJoinParam = appMode ? null : params.get('lanjoin');
const online = !appMode && (params.has('online') || params.has('server') || lanHostParam || lanJoinParam !== null);
const serverUrl = params.get('server') ?? `ws://${location.hostname || 'localhost'}:9001`;
const name = (params.get('name') ?? `Pilot-${Math.floor(Math.random() * 9000 + 1000)}`).slice(0, 16);
const shorthand = ['rtt', 'loss', 'jitter', 'dup']
  .filter((k) => params.has(k))
  .map((k) => `${k}=${params.get(k)}`)
  .join(',');
const netSim = parseNetSim(params.get('netsim') ?? shorthand) ?? createConditionerSettings(false);

// phones play in landscape whichever way they're held: before anything measures the window
startLandscape();
// the low-end tier (ui/lowEnd.ts): a device that can't afford the interface's decoration drops it
const lowEnd = startLowEnd();
// a tap on a menu button while a thumb rests on a dial: the browser sends no click, so this does
if (navigator.maxTouchPoints > 0) startMultiTouchTaps();

const canvas = document.getElementById('game') as HTMLCanvasElement;
const view3dCanvas = document.getElementById('view3d') as HTMLCanvasElement;
const bar = document.getElementById('bar')!;
const panelEl = document.getElementById('panel')!;
const toast = document.getElementById('toast')!;

function showToast(message: string): void {
  toast.textContent = message;
  toast.style.display = 'block';
}

/** Gameplay input that menus can switch off (aim still follows the mouse). */
class GameInput extends InputSampler {
  /** the buttons of the last sample (the empty click listens for Fire) */
  lastButtons = 0;
  override sample(camera: Camera, sx: number, sy: number, out?: Input): Input {
    const input = super.sample(camera, sx, sy, out);
    if (this.blocked) {
      input.buttons = 0;
      input.weaponSelect = 0;
    }
    this.lastButtons = input.buttons;
    return input;
  }
}

// the map loading screen's real progress: every GLTF, texture and KTX2 the 3D view loads, from the start
assetLoad.attach(DefaultLoadingManager);

/** local mode's map (the debug client's map links, or `?map=` for training); online, the server's */
const requestedMap = params.get('map');
const localMapId = requestedMap && maps[requestedMap] ? requestedMap : 'movement-test';

// local mode: the ?map= map; online mode: the server's, from WELCOME (followed in frame())
let map: MapDef = getMap(online ? 'movement-test' : localMapId);
let mode: LocalMode | OnlineMode | null = null;
// dev builds: the running mode for measuring scripts in the browser (net stats, the local room's ping)
if (import.meta.env.DEV) (window as unknown as { __mfMode: () => unknown }).__mfMode = () => mode;

// Graphics quality (Settings → Graphics): a preset, or Auto, which starts as high as the device
// should hold (gfxAuto.ts, worked out once, when first needed) and then adapts to the measured
// frames in the 3D view (Renderer3D.setAutoTier); Settings shows the tier it is on now
let autoGraphicsStart: PresetName | null = null;
let autoGraphicsNow: PresetName | null = null;
const autoStart = (): PresetName => (autoGraphicsStart ??= autoPreset({ touch: isTouchDevice(), gpu: gpuRenderer(), ...deviceHints() }));
const autoGraphics = (): PresetName => autoGraphicsNow ?? autoStart();
const graphicsPreset = (setting: GraphicsSetting): PresetName => (setting === 'auto' ? autoGraphics() : setting);
/** whether the 3D view's Auto is adapting (set once per switch to or from Auto, not on every settings change) */
let autoAdapting = false;
function applyGraphics(setting: GraphicsSetting): void {
  if (setting === 'auto') {
    if (!autoAdapting) view3d?.setAutoTier(autoGraphics());
    autoAdapting = true;
    return;
  }
  autoAdapting = false;
  view3d?.setAutoTier(null);
  view3d?.setPreset(setting);
}

// 3D draws the world under the 2D canvas, which becomes the HUD + debug overlay (H/B). Online games
// too (the owner's decision, 18 Oct): 3D unless ?render=2d, and the 2D view where WebGL can't start
// (create3d gives null) or, in frame(), while its context is lost. It starts on the saved quality
// (?gfx= overrides): antialiasing is fixed when the WebGL context is made.
const planeCamera = online3d(params) ? new PlaneCamera() : null;
const firstPreset = parsePreset(params.get('gfx') ?? graphicsPreset(appMode ? loadSettings().graphics : 'auto'));
// who wears what in 3D (v19): the room's looks from the look book, the saved look for us until the room says
const loadouts3d = new LoadoutDirectory();
followLooks(lookBook, loadouts3d);
// one assembler for the 3D view and the portraits: they share its geometry and part caches
const soldiers = new CharacterAssembler();
const view3d = planeCamera
  ? create3d(view3dCanvas, planeCamera, map, firstPreset, (import.meta.env.DEV && !appMode) || params.has('perf'), soldiers, softwareGl(params), loadouts3d)
  : null;
// avatars and the VS poster's renders: the players' real soldiers, through the game's own WebGL context
// (portrait/, research §7); a page without 3D shows silhouettes
if (view3d) installPortraits(view3d.renderer, soldiers);
setPortraitPolicy(portraitPolicy);
// the room's avatars and VS poster renders, warmed whenever its looks change (the countdown only shows pictures)
if (view3d) warmRoomPortraits(lookBook);
if (import.meta.env.DEV) (window as unknown as { __mfPortraits: unknown }).__mfPortraits = { portraits, getAvatar, getPortrait, lookBook };
const use3d = view3d !== null;
if (view3d) {
  view3d.onAutoTier = (tier) => {
    autoGraphicsNow = tier;
    lowEnd.noteTier(tier);
  };
  // Auto from the start (no ?gfx=): adapting to the frames before Settings is ever opened
  if (!params.get('gfx') && (!appMode || loadSettings().graphics === 'auto')) applyGraphics('auto');
}
const camera = view3d ? planeCamera! : new Camera();
const sampler = new GameInput(canvas);
// double-tap a direction to dash (docs/02 §21), on by default: ?dashtap=0 turns it off in the debug
// client; the app's Controls settings set it
sampler.doubleTapDash = params.get('dashtap') !== '0';
const options: RenderOptions = { showHitboxes: false, showGrid: !use3d, showNet: online, overlay: use3d };
// the app's HUD is DOM (hud/), reticle and hit markers included: the canvas keeps the world effects.
// The canvas HUD, its reticle and the help line stay in the debug client (dev `/`) only.
if (appMode) Object.assign(options, { showGrid: false, hud: 'none', reticle: false });
const hud = appMode ? mountHud() : null;
// the minimap (minimap/): every map, every tier; enemies only as seen or heard
const minimap = appMode ? new Minimap() : null;

// spectating (v20): the death cam and watching a room; its controls listen only while it runs
const spectate = new SpectateDirector();
const spectateInput = new SpectateInput(sampler, canvas);
const spectatePicker = hud ? new SpectatePicker(document.querySelector('#hud .mf-hud-desktop .hud') ?? document.body) : null;
if (import.meta.env.DEV) Object.assign(window, { __spectate: spectate });

/** The onboarding's memory (tour/): on-device facts and the event log; the app only (set once the shell is up). */
let tourMemory: TourMemory | null = null;

/** The 2D renderer, also feeding the HUD the events and names every mode already reports. */
class GameRenderer extends Renderer {
  override onEvents(events: readonly SimEvent[], localId: number): void {
    super.onEvents(events, localId);
    hud?.onEvents(events, localId);
    minimap?.onEvents(events, localId);
    tourMemory?.onEvents(events, localId);
    audio.onEvents(events, localId); // the game's sound (apps/web/src/audio): lazy, after the first tap or key
  }
  override onSounds(sounds: readonly { x: number; y: number }[]): void {
    minimap?.onSounds(sounds);
  }
  override setNames(names: Map<number, string>, bots: ReadonlySet<number> = new Set()): void {
    super.setNames(names, bots);
    hud?.setNames(names, bots);
  }
}

const renderer = new GameRenderer(canvas, camera, map, () => mode?.tuning() ?? defaultTuning);
void view3d?.load(map.spawns[0]!);
view3d?.attach(renderer, () => (mode instanceof OnlineMode ? mode.net : null)); // sim events → 3D effects; online: remotePose (render3d)
// phones and tablets: twin sticks + buttons (apps/web/src/touch); the app's Settings → Touch has "Edit layout"
mountTouch({ sampler, camera, renderer, view3d, editButton: !appMode, tuning: () => mode?.tuning() ?? null, map: () => map });
// game controllers (apps/web/src/gamepad): play, the menus, rumble, prompts in the pad's buttons
// (on a phone the touch buttons step aside while a pad plays: gamepad/pad.css)
mountGamepad({ sampler, camera, renderer, scoreboardCode: () => scoreboardKeys[0], map: () => map, toggleMap: () => minimap?.toggleBig() });
// tap-to-save billboard ads (apps/web/src/ads): after touch and the pad, so it sees their shots too
mountAdClicks({ sampler, camera, canvas, view3d });

// the room host's live tuning panel (the in-match menu's "Tune the game"), where the page offers it:
// pnpm playtest --tune flags the page; the game server then lets the host (only) tune the room
const hostTuning = appMode && tuningOffered() ? createHostTuning(() => mode) : null;

let settings: Settings | null = null;
/** the game server's host while online (Settings → Network) */
let serverHost = '';
/** page-level keys from the Controls settings (the debug client keeps N) */
let netGraphKeys: readonly string[] = ['KeyN'];
let scoreboardKeys: readonly string[] = ['Tab'];
let mapKeys: readonly string[] = ['KeyM'];

/** The HUD's keycaps: the player's keys, or a controller's buttons while one plays (gamepad/prompts.ts). */
function applyHudKeys(): void {
  if (!settings || !hud) return;
  const b = currentDevice().kind === 'pad' ? padShownBindings(settings.pad) : settings.bindings;
  const key = (action: keyof typeof b) => b[action][0];
  hud.setKeys({ dash: key('dash'), grenade: key('grenade'), cycleGrenade: key('cycleGrenade'), shield: key('shield'), swap: key('swap'), reload: key('reload'), scoreboard: key('scoreboard'), interact: key('interact'), fire: key('fire') });
}
onInputDevice(applyHudKeys);

/** the room code of the online match in play (presence), null otherwise */
let onlineRoom: string | null = null;
let presence: PresenceBeat | null = null;

/** the local room hosted on this device (lan/), while its mode runs */
let lanHost: LanHost | null = null;

function setMode(next: LocalMode | OnlineMode | null): void {
  hostTuning?.close(); // it tunes the mode it was opened for
  if (mode instanceof OnlineMode) mode.dispose();
  // the host leaving its local room closes it for everyone
  lanHost?.close();
  lanHost = null;
  mode = next;
  audio.reset();
  if (!(next instanceof OnlineMode)) onlineRoom = null;
  // voice chat (v18): in online rooms only
  voiceChat.attach(next instanceof OnlineMode ? next : null);
  presence?.update();
  camera.setZoom(0, 1);
  if (next instanceof OnlineMode && settings?.lowBandwidth) next.net.setLowBandwidth(true);
}

/** The Armory's "Try it in training" (?try=<weapon id>): the gun the first training starts with. */
let tryWeapon = weapons.find((w) => w.id === params.get('try')) ?? null;

/** The online mode's notices for the shell: tuning changes (who made them) and a new host. */
function watchOnline(online: OnlineMode): void {
  // who changed what, for a moment: the owner's admin page ("Admin", everyone hears it) or the
  // room's host retuning the room (Tune the game; its guests hear it)
  online.onTuning((before, after, live, adminKeys) => {
    if (!live) return;
    const lobby = shell.store.getState().lobby;
    const split = splitTuneChange(before, after, adminKeys);
    const note =
      tuneToastParts('Admin', tuneChanges(before, split.admin)) ??
      (lobby?.isHost ? null : tuneToastParts(lobby?.players.find((p) => p.host)?.name ?? 'The host', tuneChanges(before, split.host)));
    if (note) shell.controller?.showTuneNote(note);
  });
  // the host left (or its connection went quiet): say who runs the room now
  online.onHostChange((_was, now) => {
    const name = now === online.localId ? null : (online.net.names.get(now) ?? 'another player');
    shell.controller?.notify(name ? `Host left: ${name} is the host now` : "Host left: you're the host now");
  });
}

/** The app's game modes, driven by the shell (shell/controller.ts). */
const host: GameHost = {
  get local() {
    return mode instanceof LocalMode ? mode : null;
  },
  get online() {
    return mode instanceof OnlineMode ? mode : null;
  },
  startTraining(nickname) {
    // training: a deathmatch against three Normal bots (?bots= / ?botlevel=, ?sandbox for the range dummies)
    const rules = localMatchRules(params);
    const local = new LocalMode(sampler, camera, renderer, nickname, rules, localMapId, localBots(params, rules !== null));
    setMode(local);
    // the Armory's "Try it in training": that gun in your hand (the second slot as usual), once
    const tryGun = tryWeapon;
    tryWeapon = null;
    if (tryGun) local.setLoadout([tryGun.index, tryGun.index === DEFAULT_LOADOUT[1] ? DEFAULT_LOADOUT[0] : DEFAULT_LOADOUT[1]]);
    else if (loadoutSync) local.setLoadout(loadoutSync.savedGunIndices()); // the player's saved pair (the default until they pick one)
  },
  startOnline(url, nickname, room, ticket, refreshTicket, opts) {
    try {
      serverHost = new URL(url).host;
    } catch {
      serverHost = '';
    }
    // WebTransport where the server routes it by room (/health webtransport.rooms), else WebSocket
    // v20: `spectate` watches the room (no slot) instead of playing in it
    const online = new OnlineMode(url, nickname, sampler, camera, renderer, () => {}, createConditionerSettings(false), 'auto', {
      room,
      ...(ticket ? { ticket } : {}),
      ...(refreshTicket ? { refreshTicket } : {}),
      ...(opts?.spectate ? { spectate: true } : {}),
    });
    onlineRoom = room;
    setMode(online);
    watchOnline(online);
  },
  get lan() {
    return lanHost;
  },
  async startLocalHost(nickname) {
    serverHost = '';
    // bots fill it to 4 like the live server's rooms (the lobby's Bots setting turns them off)
    const lan = new LanHost({ signalUrl: lanSignalUrl('host'), fillBots: { target: 4, level: 'normal' } });
    const code = await lan.whenCoded();
    const online = new OnlineMode(`lan://${code || 'local'}`, nickname, sampler, camera, renderer, () => {}, createConditionerSettings(false), 'auto', {
      room: code,
      local: true,
      connect: (h) => lan.hostTransport(h),
    });
    setMode(online);
    lanHost = lan; // after setMode: it closes the one before
    watchOnline(online);
    return code;
  },
  startLocalJoin(nickname, how) {
    serverHost = '';
    const code = 'code' in how ? how.code : '';
    const online = new OnlineMode(`lan://${code || 'local'}`, nickname, sampler, camera, renderer, () => {}, createConditionerSettings(false), 'auto', {
      room: code,
      local: true,
      connect: 'code' in how ? (h) => joinByCode(code, h) : connectAnswered(how.answered),
    });
    setMode(online);
    watchOnline(online);
  },
  stop() {
    setMode(null);
  },
  applySettings(next) {
    settings = next;
    options.showNet = next.netGraph;
    applyGraphics(next.graphics);
    // blood when soldiers are hit (Settings → Graphics, off by default): render3d's setBlood (#96)
    view3d?.setBlood(next.blood);
    if (mode instanceof OnlineMode && mode.net.lowBandwidth !== next.lowBandwidth) mode.net.setLowBandwidth(next.lowBandwidth);
    sampler.bindings = toKeyBindings(next.bindings);
    sampler.doubleTapDash = next.doubleTapDash;
    netGraphKeys = uiCodes(next.bindings, 'netGraph');
    scoreboardKeys = uiCodes(next.bindings, 'scoreboard');
    hud?.setScoreboardKeys(scoreboardKeys);
    mapKeys = uiCodes(next.bindings, 'map');
    minimap?.setKey(mapKeys[0] ? capText(mapKeys[0]) : null);
    minimap?.setColorBlind(next.colorBlind);
    minimap?.setReducedMotion(next.reduceMotion);
    voiceChat.talkKeys = uiCodes(next.bindings, 'talk');
    voiceChat.padButtons = next.pad.enabled ? next.pad.bindings.talk : [];
    applyHudKeys();
    // controllers: their settings, and no rumble under Reduce flashes
    applyPadSettings(next.pad, next.reduceFlashes);
    // the sound: bus volumes and mutes, and Accessibility's "Soften loud bursts"
    audio.applySettings(next.audio, next.softBursts);
    // Reduce flashes: the flashbang effect (fx, which remembers it) and the UI (the kit's html.reduce-flashes)
    setReduceFlashes(next.reduceFlashes);
    const html = document.documentElement;
    html.toggleAttribute('data-reduce-flashes', next.reduceFlashes);
    html.classList.toggle('reduce-flashes', next.reduceFlashes);
    // the kit's Reduce motion and Text size (every font-size token multiplies --text-scale)
    html.classList.toggle('reduce-motion', next.reduceMotion);
    // frosted glass (ui/frost.css): solid under Reduce transparency, and on Low graphics (blur costs GPU)
    html.classList.toggle('reduce-transparency', next.reduceTransparency);
    html.classList.toggle('gfx-low', graphicsPreset(next.graphics) === 'low');
    // …and the 3D view's: no camera shake or kick, a softer gun kick, a dimmer blast light (render3d)
    view3d?.setReducedMotion(next.reduceMotion);
    html.style.setProperty('--text-scale', String(next.textScale));
    // big text: the menus tighten their largest pieces the way they do in a laptop's smaller box
    html.classList.toggle('mf-big-text', next.textScale >= 1.3);
  },
  setInputBlocked(blocked) {
    sampler.blocked = blocked;
    if (blocked) sampler.releaseAll();
    hud?.setBlocked(blocked);
  },
  tuning: hostTuning,
  get autoGraphics() {
    return autoGraphics();
  },
};

if (appMode) {
  document.title = GAME_NAME;
  bar.remove();
  panelEl.remove();
} else {
  document.title = `${GAME_NAME} · Phase 0 prototype`;
  bar.innerHTML = `
    <strong>${GAME_NAME.toUpperCase()} · Phase 0</strong>
    <a href="/" class="${online || requestedMap ? '' : 'active'}">Local + dummies</a>
    <a href="/?online" class="${online ? 'active' : ''}">Online (${serverUrl.replace(/^wss?:\/\//, '')})</a>
    <a href="/?online" target="_blank">+ 2nd tab</a>
    <a href="/locker.html">Locker</a>
    <a href="/armory.html">Armory</a>
    <a href="/gamepad.html">Pad check</a>
    <a href="/sounds.html">Sounds</a>
    <a href="/?app">App</a>
    <span class="maps">maps: ${['street-market', ...DEMO_MAPS, 'mechanics-test', 'vertical-test']
      .map((id) => `<a href="/?map=${id}" class="${!online && localMapId === id ? 'active' : ''}">${maps[id]!.name}</a>`)
      .join(' ')}</span>
  `;
  if (requestedMap && !maps[requestedMap]) {
    showToast(`Unknown map "${requestedMap}". Maps: ${Object.keys(maps).join(', ')}`);
    setTimeout(() => (toast.style.display = 'none'), 4000);
  }
  if (lanHostParam) {
    const lan = new LanHost({ signalUrl: lanSignalUrl('host'), fillBots: params.has('bots') ? { target: Number(params.get('bots')) || 4, level: 'normal' } : null });
    lan.onChange(() => showToast(lan.code ? `Local room ${lan.code}: ${lan.connectedGuests} joined (?lanjoin=${lan.code})` : lan.signalError || 'local room: waiting for a code…'));
    mode = new OnlineMode('lan://host', name, sampler, camera, renderer, showToast, netSim, 'auto', { connect: (h) => lan.hostTransport(h) });
  } else if (lanJoinParam !== null) {
    const code = normalizeLanCode(lanJoinParam) ?? '';
    mode = new OnlineMode(`lan://${code}`, name, sampler, camera, renderer, showToast, netSim, 'auto', { connect: (h) => joinByCode(code, h) });
  } else if (online) {
    const prefer = params.get('transport');
    mode = new OnlineMode(serverUrl, name, sampler, camera, renderer, showToast, netSim, prefer === 'ws' || prefer === 'wt' ? prefer : 'auto');
  } else {
    const rules = localMatchRules(params);
    mode = new LocalMode(sampler, camera, renderer, name, rules, localMapId, localBots(params, rules !== null));
  }
}

// training's bots need the map's nav graph: build it in idle time while the player is in the menus
// (navWarm.ts), not on training's first frame. Dev builds log how long it took (tall-map perf script).
if (appMode && !online) {
  void warmNavGraph(getMap(localMapId)).then((r) => {
    if (import.meta.env.DEV) (window as unknown as { __navWarm: typeof r }).__navWarm = r;
  });
}

// The Locker as a shell route (#/locker); loaded on first use.
registerRoute({
  id: 'locker',
  title: 'Locker',
  ownExit: true, // the Locker has its own Back button
  mount: (el, close) => {
    let cleanup: (() => void) | null = null;
    let closed = false;
    void import('./locker/route').then(({ mountLockerRoute }) => {
      if (!closed)
        cleanup = mountLockerRoute(el, {
          onExit: close,
          onCreator: () => openCreator('locker'),
          ...(loadoutSync ? { store: loadoutSync.store, guns: loadoutSync.guns } : {}),
        });
    });
    return () => {
      closed = true;
      cleanup?.();
    };
  },
});

// The character creator (#/creator; owner, 22 Oct): body first, then the look. It follows the name
// screen once on this device (first: "Skip for now"), and the Locker opens it again (Back returns there).
let creatorFrom: 'first' | 'locker' | null = null;
function storageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
function openCreator(from: 'first' | 'locker'): void {
  creatorFrom = from;
  location.hash = '#/creator';
}
registerRoute({
  id: 'creator',
  title: 'Create your soldier',
  ownExit: true,
  mount: (el, close) => {
    let cleanup: (() => void) | null = null;
    let closed = false;
    const from = creatorFrom;
    creatorFrom = null;
    void import('./creator/route').then(({ mountCreatorRoute }) => {
      if (!closed)
        cleanup = mountCreatorRoute(el, {
          first: from === 'first',
          onExit: (how) => {
            if (how === 'saved') tourMemory?.fact({ k: 'soldier-saved' });
            if (from === 'locker') location.hash = '#/locker';
            else close();
          },
          ...(loadoutSync ? { store: loadoutSync.store } : {}),
        });
    });
    return () => {
      closed = true;
      cleanup?.();
    };
  },
});

// App shell (W4): screens over the canvas. Other workstreams plug in with one line each, e.g.
// registerRoute({ id: 'locker', title: 'Locker', mount }) from './shell' (opens at #/locker).
// the title screen opens the app (not for invite links, the debug client or automation: shell/title.ts)
const shell = mountShell(document.body, appMode ? { host, title: titleWanted({ appMode, path: location.pathname, params, webdriver: navigator.webdriver === true }) } : {});
// sound starts on the first tap or key (browsers allow it only then); the shell's store drives the
// interface cues and the music
startAudio(shell.store);
// the saved loadout (look + guns) follows the account: read at sign-in, kept on this device as the offline cache
const loadoutSync = shell.controller ? new LoadoutSync(shell.controller.api) : null;
// "here" to the API every 30 s while visible, with the room when in an online match (presence.ts)
presence = shell.controller ? new PresenceBeat(shell.controller.api, () => onlineRoom) : null;
if (loadoutSync) document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void loadoutSync.flush());
// the onboarding's memory (docs/design/onboarding-research.md phase 1): facts and the event log, on this
// device only; ?tourlog shows them on the page
if (appMode) {
  tourMemory = startTourMemory({ store: shell.store, storage: storageOrNull(), invited: location.pathname.startsWith('/r/') });
  tourMemory.setDevice(isTouchDevice() ? 'touch' : 'keyboard');
  onInputDevice((d) => tourMemory?.setDevice(d.kind === 'pad' ? 'pad' : d.kind === 'touch' ? 'touch' : 'keyboard'));
  if (params.has('tourlog')) mountTourReadout(tourMemory);
  if (import.meta.env.DEV) Object.assign(window, { __tour: tourMemory });
}
// first time here: the name screen, then "Create your soldier" (once on this device; Skip counts), unless
// the name was for a room link (then the room comes first)
if (appMode)
  shell.store.subscribe((now, before) => {
    if (before.screen.name === 'name' && now.screen.name === 'home' && !creatorSeen(storageOrNull())) openCreator('first');
  });
// v19: a look saved while playing (the Locker, the creator) reaches the 3D view and the room we're in at once
loadoutSync?.onLook((look) => {
  loadouts3d.setLocal(look);
  if (mode instanceof OnlineMode) mode.setLook(cosmeticLoadoutWireIds(look));
});

// dev builds: the spotlight for checks and tinkering (scripts/spotlight-check.mjs)
if (import.meta.env.DEV) Object.assign(window, { __Spotlight: Spotlight });

// the HTML loading screen (index.html) stays until the shell has its first real screen (the API
// answered or gave up), so nothing flashes in between; the landing (ui/landing.ts) goes under the app then
const splash = document.getElementById('boot-splash');
if (splash) {
  const hide = () => {
    splash.classList.add('gone');
    setTimeout(() => splash.remove(), 400);
    releaseLanding();
  };
  // the title screen covers the wait itself (its prompt turns into a loading line if pressed early)
  if (!appMode || shell.store.getState().screen.name !== 'boot' || shell.store.getState().title !== 'off') hide();
  else {
    const stop = shell.store.subscribe((s) => {
      if (s.screen.name === 'boot') return;
      stop();
      hide();
    });
  }
}

// Dev-only debug hook for automated playtests and console poking (stripped from production builds).
if (import.meta.env.DEV) {
  Object.assign(window, {
    __game: {
      get mode() {
        return mode;
      },
      camera,
      options,
      view3d,
      shell,
      hud,
    },
  });
}

function downloadReplay(): void {
  if (!(mode instanceof LocalMode) || !mode.lastReplay) {
    showToast('No replay recorded yet: press P to start, P again to stop.');
    setTimeout(() => (toast.style.display = 'none'), 2500);
    return;
  }
  const blob = new Blob([JSON.stringify(mode.lastReplay)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${mode.lastReplay.name}.replay.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// before the panel reads it, so its checkbox starts right; applied on WELCOME if not yet connected
if (mode instanceof OnlineMode && params.has('lowbw')) mode.net.setLowBandwidth(true);

// the live tuning panel is a dev tool: the debug client only (and not in the production bundle)
let panel: { pane: { refresh(): void }; refresh(): void } | null = null;
if (!appMode && import.meta.env.DEV) {
  const debugMode = mode!;
  void import('./tuningPanel').then(({ createTuningPanel }) => {
    panel = createTuningPanel(panelEl, options, {
      getTuning: () => debugMode.tuning(),
      onTuningChanged: (t) => {
        if (debugMode instanceof OnlineMode) debugMode.setTuning(t);
      },
      respawn: () => debugMode.respawn(),
      ...(debugMode instanceof LocalMode
        ? {
            toggleRecording: () => debugMode.toggleRecording(),
            downloadReplay,
            loadout: debugMode.loadout,
            setLoadout: (l: [number, number]) => debugMode.setLoadout(l),
          }
        : { netSim, lowBandwidth: { get: () => debugMode.net.lowBandwidth, set: (on: boolean) => debugMode.net.setLowBandwidth(on) } }),
    });
    if (debugMode instanceof OnlineMode) debugMode.onTuningFromServer = () => panel?.refresh();
  });
}

const HELP =
  'A/D move · W/Space jet · S crouch (hold on a platform to drop) · Shift dash (alone: the way you face; + WASD: 8-way; or double-tap A/D/S) · LMB fire · V melee · R reload · Q swap · F dual · G grenade · T next grenade · wheel zoom · H hitboxes · B grid · N net · ` panel' +
  (online ? '' : ' · P record · O download replay');

function resize(): void {
  renderer.resize();
  view3d?.resize();
}
window.addEventListener('resize', resize);
resize();

const EMPTY_FRAME: Frame = { tick: 0, localId: -1, players: [], grenades: [] };

/**
 * When portraits may render (research §7.3.3): freely in menus and lobbies; in the countdown only under
 * the VS poster; never mid-fight; one at a time while we're dead.
 */
function portraitPolicy(): PortraitPolicy {
  if (!mode) return 'menus';
  const phase = mode instanceof LocalMode ? mode.match?.phase : mode.matchState?.phase;
  // the countdown: only while the VS poster covers the world (training has no lobby to warm them in)
  if (phase === MatchPhase.Countdown) return posterUp() ? 'idle' : 'busy';
  if (phase !== MatchPhase.InProgress && phase !== undefined) return 'menus';
  const me = mode instanceof LocalMode ? mode.me : mode.net.predictor?.player;
  return me && !me.alive ? 'idle' : 'busy';
}

/** The Tab scoreboard: the local match's standings, or the room's from MATCH_STATE (with pings). */
function scoreRows(): ScoreRow[] | null {
  if (mode instanceof LocalMode) {
    const me = mode.localId;
    return (
      mode.match?.standings().map((s) => ({ key: s.key, id: s.id, name: s.name, score: s.score, kills: s.kills, deaths: s.deaths, assists: s.assists, ping: -1, you: s.id === me && !s.left, host: false, bot: s.isBot, left: s.left })) ?? null
    );
  }
  const st = mode?.matchState;
  if (!st || !mode) return null;
  const me = mode.localId;
  const pings = new Map(st.lobby.map((p) => [p.id, p.pingMs]));
  return st.standings.map((s) => ({
    key: s.key,
    id: s.id,
    name: s.name,
    score: s.score,
    kills: s.kills,
    deaths: s.deaths,
    assists: s.assists,
    ping: s.left ? -1 : (pings.get(s.id) ?? -1),
    you: s.id === me && !s.left,
    host: s.id === st.hostId && !s.left,
    bot: s.isBot,
    left: s.left,
  }));
}

const screenPoint = { x: 0, y: 0 };
const toScreen = (x: number, y: number) => {
  screenPoint.x = camera.toScreenX(x);
  screenPoint.y = camera.toScreenY(y);
  return screenPoint;
};

/** The menus' backdrop: the camera drifts along the map (once a second while a screen covers it: ui/backdrop.ts). */
const backdropPacer = new BackdropPacer();
function drawMenuBackdrop(now: number, dt: number): void {
  if (appMode && !backdropPacer.shouldDraw(now)) return;
  const b = map.bounds;
  const mid = (b.minX + b.maxX) / 2;
  const x = mid + (b.maxX - b.minX) * 0.3 * Math.sin(now / 1000 / 24);
  const y = map.spawns[0]!.y + 2;
  camera.flightVy = 0;
  camera.follow(x, y, x, y, dt, map);
  options.overlay = view3d?.drawing ?? false;
  view3dCanvas.style.visibility = options.overlay ? 'visible' : 'hidden';
  renderer.render(EMPTY_FRAME, dt, { ...options, hud: 'none', reticle: false }, '');
  view3d?.render(EMPTY_FRAME, dt);
}

const pointer = { x: 0, y: 0 };
/** what's on screen (world rect), for the minimap */
const minimapView = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;
  countFrame(now);
  pointer.x = sampler.mouseX;
  pointer.y = sampler.mouseY;

  // UI toggles (not gameplay inputs); the app keeps only the net graph, on its bound keys
  let toggled = false;
  if (appMode) {
    if (!sampler.blocked && mapKeys.some((code) => sampler.consumePress(code))) minimap?.toggleBig();
    if (!sampler.blocked && netGraphKeys.some((code) => sampler.consumePress(code))) {
      options.showNet = !options.showNet;
      toggled = true;
    }
  } else {
    for (const [code, key] of [
      ['KeyH', 'showHitboxes'],
      ['KeyB', 'showGrid'],
      ['KeyN', 'showNet'],
    ] as const) {
      if (sampler.consumePress(code)) {
        options[key] = !options[key];
        toggled = true;
      }
    }
  }
  if (!appMode) {
    if (sampler.consumePress('KeyK')) mode?.respawn();
    if (sampler.consumePress('Backquote')) panelEl.style.display = panelEl.style.display === 'none' ? '' : 'none';
    if (mode instanceof LocalMode) {
      if (sampler.consumePress('KeyP')) mode.toggleRecording();
      if (sampler.consumePress('KeyO')) downloadReplay();
    }
  }
  // spectating's keys (Q / E, F, Enter) before the frame's presses are dropped
  const spectateActions = spectateInput.poll(camera, now);
  sampler.clearPresses();
  if (toggled) panel?.pane.refresh();

  // a full-screen route (the Locker) covers the game: no drawing behind it
  const covered = shell.store.getState().route !== null;
  if (!mode) {
    hud?.setVisible(false);
    minimap?.setVisible(false);
    if (!covered) drawMenuBackdrop(now, dt);
    audio.onFrame(null, dt, null);
    voiceChat.frame(null);
    shell.update();
    shell.setMapEvent(null);
    return;
  }

  // 3D draws the world, online games too, unless its WebGL context is lost: the 2D view meanwhile
  if (view3d) {
    options.overlay = view3d.drawing;
    view3dCanvas.style.visibility = options.overlay ? 'visible' : 'hidden';
  }

  const wheel = sampler.consumeWheel();
  if (wheel !== 0) camera.setZoom(camera.zoom + wheel, mode.zoomMax());
  else camera.setZoom(camera.zoom, mode.zoomMax());

  const f = mode.update(dt);
  if (mode.map !== map) {
    map = mode.map;
    renderer.setMap(map);
    view3d?.setMap(map);
  }
  minimap?.setMap(map);
  const me = f.players.find((p) => p.id === f.localId);
  const mouse = sampler.mouseWorld(camera);
  // v20: watching (a spectator) or the death cam: the camera goes where spectating says
  const online = mode instanceof OnlineMode ? mode : null;
  const spec: SpectateView | null = spectate.update(
    f,
    { spectating: online?.spectating ?? false, state: online?.spectateState ?? null, delay: online?.spectateDelay ?? 0 },
    online ?? { follow: () => {}, play: () => {} },
    spectateActions,
    dt,
    map,
    camera,
  );
  spectateInput.active = spec !== null;
  spectateInput.free = spec?.free === true;
  document.documentElement.classList.toggle('mf-spectating', spec !== null);
  document.documentElement.classList.toggle('mf-spec-free', spec?.free === true);
  spectatePicker?.update(spec);
  if (spec) {
    camera.flightVy = 0;
    camera.setZoom(spec.zoom, ZOOM_LEVELS);
    camera.follow(spec.x, spec.y, spec.x, spec.y, dt, map);
  } else if (me) {
    camera.flightVy = me.alive ? me.vy : 0; // tall maps: the view leans the way you fly (camera.ts)
    camera.follow(me.x, me.y, mouse.x, mouse.y, dt, map);
  }
  renderer.mouse.x = sampler.mouseX;
  renderer.mouse.y = sampler.mouseY;
  shell.update(mode instanceof LocalMode ? mode : null);
  shell.setMapEvent(f.mapEvent);
  if (minimap) {
    minimap.setVisible(!covered && shell.store.getState().overlay === null);
    const { halfW, halfH } = camera.halfExtents;
    minimapView.minX = camera.x - halfW;
    minimapView.maxX = camera.x + halfW;
    minimapView.minY = camera.y - halfH;
    minimapView.maxY = camera.y + halfH;
    minimap.update(f, minimapView, now);
  }
  if (covered) return; // the mode keeps running (online: inputs and heartbeats), nothing is drawn
  renderer.render(f, dt, options, appMode ? '' : HELP);
  audio.onFrame(f, dt, { fuelMax: mode.tuning().fuelMax, fireHeld: (sampler.lastButtons & Btn.Fire) !== 0, map });
  // voice chat: voices follow their soldiers; menus over the game take push to talk's key
  voiceChat.blocked = shell.store.getState().overlay !== null;
  voiceChat.frame(f, toScreen);
  fxFrame(f, dt); // flashbang white-out / gas edge over the view (arsenal B, apps/web/src/fx)
  if (f.net && mode instanceof OnlineMode) recordNet(now, f.net.rttMs, f.net.prediction?.snapshotLossPct ?? 0, serverHost);
  if (hud) {
    hud.setVisible(true);
    const state = shell.store.getState();
    hud.update({
      frame: f,
      tuning: mode.tuning(),
      // "Tuned by host" names what the host changed from the room's own (the admin's values aren't its)
      ...(mode instanceof OnlineMode ? { tuningBase: mode.tuningBase() } : {}),
      match: state.match,
      zoom: camera.zoom + 1,
      toScreen,
      // no reticle until the pointer (or the touch aim) has been somewhere
      pointer: sampler.blocked || (pointer.x === 0 && pointer.y === 0) ? null : pointer,
      showNet: options.showNet,
      showFps: settings?.showFps ?? false,
      fps: framesPerSecond(),
      reduceFlashes: settings?.reduceFlashes ?? false,
      flash: fxState().flash,
      scoreRows,
      adminTuned: mode instanceof OnlineMode && mode.net.adminTuned,
      throwAim: sampler.throwAim,
      quickThrowAt: sampler.quickThrowAt,
      blood: settings?.blood ?? false,
      spectate: spec,
    });
  }
  if (options.overlay) view3d?.render(f, dt);
}

let lastRaf = performance.now();
function rafLoop(now: number): void {
  lastRaf = performance.now();
  frame(now);
  requestAnimationFrame(rafLoop);
}
requestAnimationFrame(rafLoop);

// Watchdog: hidden tabs/panes stop requestAnimationFrame. Once rAF has been silent for 100 ms, drive
// frames from a timer so the sim and the online input heartbeat continue (docs/06 §4 tab-away
// behaviour). Browsers throttle timers in background tabs to ~1 Hz, which is fine.
setInterval(() => {
  const now = performance.now();
  // in the menus there's nothing to keep alive while hidden (the backdrop, the shell): only a mode
  if (now - lastRaf > 100 && mode) frame(now);
}, 16);
