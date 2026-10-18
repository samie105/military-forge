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
 *   /?map=flux-lab   local mode on another map: lunar-outpost, storm-front, flux-lab (map mechanics demos,
 *                    docs/02 §20), mechanics-test, movement-test (default). Online, the server picks (--map=).
 *   /?time=60&kills=5&countdown=3       local match rules (0 = no limit); /?sandbox: free play, no match
 *   /?render=2d  the canvas-2D view instead (3D is the default, online too); ?gfx=low|medium|high;
 *                ?softgl accepts software WebGL for 3D (automated browsers always do; players on it get 2D)
 *   /?online     joins the dev room on ws://<host>:9001 (open in two tabs to play each other)
 *   /?server=ws://host:port&name=Ade   explicit server and name
 *   /?online&rtt=150&loss=2&jitter=5    network conditioner (or ?netsim=up.lat=20,down.lat=120,…)
 *   /?online&lowbw                      low-bandwidth mode (30 Hz inputs, 15 Hz snapshots)
 *   /?online&transport=ws|wt            force WebSocket / WebTransport (default: WT when the server has a gateway)
 */
import { DEMO_MAPS, defaultTuning, getMap, maps, type MapDef } from '@military-forge/content';
import { createConditionerSettings, parseNetSim } from '@military-forge/netcode';
import { GAME_NAME } from '@military-forge/shared';
import type { Input } from '@military-forge/sim';
import { Camera } from './camera';
import { fxFrame, setReduceFlashes } from './fx';
import { InputSampler } from './input';
import { localBots } from './localBots';
import { LocalMode } from './localMode';
import { OnlineMode } from './onlineMode';
import { Renderer, type RenderOptions } from './render';
import { localMatchRules, mountShell, registerRoute, type GameHost, type Settings } from './shell';
import { toKeyBindings, uiCodes } from './shell/controls';
import { PlaneCamera, create3d, online3d, parsePreset, softwareGl } from './render3d';
import { mountTouch } from './touch';
import type { Frame } from './view';

const params = new URLSearchParams(location.search);
/** the player-facing app, or (dev builds at `/`) the Phase 0 debug client */
const appMode = !import.meta.env.DEV || params.has('app') || params.has('room') || location.pathname.startsWith('/r/');
const online = !appMode && (params.has('online') || params.has('server'));
const serverUrl = params.get('server') ?? `ws://${location.hostname || 'localhost'}:9001`;
const name = (params.get('name') ?? `Pilot-${Math.floor(Math.random() * 9000 + 1000)}`).slice(0, 16);
const shorthand = ['rtt', 'loss', 'jitter', 'dup']
  .filter((k) => params.has(k))
  .map((k) => `${k}=${params.get(k)}`)
  .join(',');
const netSim = parseNetSim(params.get('netsim') ?? shorthand) ?? createConditionerSettings(false);

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
  blocked = false;
  override sample(camera: Camera, sx: number, sy: number, out?: Input): Input {
    const input = super.sample(camera, sx, sy, out);
    if (this.blocked) {
      input.buttons = 0;
      input.weaponSelect = 0;
    }
    return input;
  }
}

/** local mode's map (the debug client's map links, or `?map=` for training); online, the server's */
const requestedMap = params.get('map');
const localMapId = requestedMap && maps[requestedMap] ? requestedMap : 'movement-test';

// local mode: the ?map= map; online mode: the server's, from WELCOME (followed in frame())
let map: MapDef = getMap(online ? 'movement-test' : localMapId);
let mode: LocalMode | OnlineMode | null = null;

// 3D draws the world under the 2D canvas, which becomes the HUD + debug overlay (H/B). Online games
// too (the owner's decision, 18 Oct): 3D unless ?render=2d, and the 2D view where WebGL can't start
// (create3d gives null) or, in frame(), while its context is lost
const planeCamera = online3d(params) ? new PlaneCamera() : null;
const view3d = planeCamera
  ? create3d(view3dCanvas, planeCamera, map, parsePreset(params.get('gfx')), (import.meta.env.DEV && !appMode) || params.has('perf'), undefined, softwareGl(params))
  : null;
const use3d = view3d !== null;
const camera = view3d ? planeCamera! : new Camera();
const sampler = new GameInput(canvas);
// double-tap a direction to dash (docs/02 §21): ?dashtap in the debug client; the app's Controls settings set it
sampler.doubleTapDash = params.has('dashtap');
const options: RenderOptions = { showHitboxes: false, showGrid: !use3d, showNet: online, overlay: use3d };
if (appMode) Object.assign(options, { showGrid: false, hud: 'basic' });

const renderer = new Renderer(canvas, camera, map, () => mode?.tuning() ?? defaultTuning);
void view3d?.load(map.spawns[0]!);
view3d?.attach(renderer, () => (mode instanceof OnlineMode ? mode.net : null)); // sim events → 3D effects; online: remotePose (render3d)
mountTouch({ sampler, camera, renderer, view3d }); // phones and tablets: twin sticks + buttons (apps/web/src/touch)

let settings: Settings | null = null;
/** page-level keys from the Controls settings (the debug client keeps N) */
let netGraphKeys: readonly string[] = ['KeyN'];

function setMode(next: LocalMode | OnlineMode | null): void {
  if (mode instanceof OnlineMode) mode.dispose();
  mode = next;
  camera.setZoom(0, 1);
  if (next instanceof OnlineMode && settings?.lowBandwidth) next.net.setLowBandwidth(true);
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
    setMode(new LocalMode(sampler, camera, renderer, nickname, rules, localMapId, localBots(params, rules !== null)));
  },
  startOnline(url, nickname, room, ticket, refreshTicket) {
    // WebTransport where the server routes it by room (/health webtransport.rooms), else WebSocket
    setMode(new OnlineMode(url, nickname, sampler, camera, renderer, () => {}, createConditionerSettings(false), 'auto', { room, ...(ticket ? { ticket } : {}), ...(refreshTicket ? { refreshTicket } : {}) }));
  },
  stop() {
    setMode(null);
  },
  applySettings(next) {
    settings = next;
    options.showNet = next.netGraph;
    view3d?.setPreset(parsePreset(next.graphics).name);
    if (mode instanceof OnlineMode && mode.net.lowBandwidth !== next.lowBandwidth) mode.net.setLowBandwidth(next.lowBandwidth);
    sampler.bindings = toKeyBindings(next.bindings);
    sampler.doubleTapDash = next.doubleTapDash;
    netGraphKeys = uiCodes(next.bindings, 'netGraph');
    // Reduce flashes: the flashbang effect (fx, which remembers it) and the HUD (the attribute)
    setReduceFlashes(next.reduceFlashes);
    document.documentElement.toggleAttribute('data-reduce-flashes', next.reduceFlashes);
  },
  setInputBlocked(blocked) {
    sampler.blocked = blocked;
    if (blocked) sampler.releaseAll();
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
    <a href="/?app">App</a>
    <span class="maps">maps: ${[...DEMO_MAPS, 'mechanics-test']
      .map((id) => `<a href="/?map=${id}" class="${!online && localMapId === id ? 'active' : ''}">${maps[id]!.name}</a>`)
      .join(' ')}</span>
  `;
  if (requestedMap && !maps[requestedMap]) {
    showToast(`Unknown map "${requestedMap}". Maps: ${Object.keys(maps).join(', ')}`);
    setTimeout(() => (toast.style.display = 'none'), 4000);
  }
  if (online) {
    const prefer = params.get('transport');
    mode = new OnlineMode(serverUrl, name, sampler, camera, renderer, showToast, netSim, prefer === 'ws' || prefer === 'wt' ? prefer : 'auto');
  } else {
    const rules = localMatchRules(params);
    mode = new LocalMode(sampler, camera, renderer, name, rules, localMapId, localBots(params, rules !== null));
  }
}

// The Locker as a shell route (#/locker); loaded on first use.
registerRoute({
  id: 'locker',
  title: 'Locker',
  mount: (el, close) => {
    let cleanup: (() => void) | null = null;
    let closed = false;
    void import('./locker').then(({ mountLockerRoute }) => {
      if (!closed) cleanup = mountLockerRoute(el, { onExit: close });
    });
    return () => {
      closed = true;
      cleanup?.();
    };
  },
});

// App shell (W4): screens over the canvas. Other workstreams plug in with one line each, e.g.
// registerRoute({ id: 'locker', title: 'Locker', mount }) from './shell' (opens at #/locker).
const shell = mountShell(document.body, appMode ? { host } : {});

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
  'A/D move · W/Space jet · S crouch (hold on a platform to drop) · Shift dash (+ WASD: 8-way) · LMB fire · V melee · R reload · Q swap · F dual · G grenade · T next grenade · wheel zoom · H hitboxes · B grid · N net · ` panel' +
  (online ? '' : ' · P record · O download replay');

function resize(): void {
  renderer.resize();
  view3d?.resize();
}
window.addEventListener('resize', resize);
resize();

const EMPTY_FRAME: Frame = { tick: 0, localId: -1, players: [], grenades: [] };

/** The menus' backdrop: the camera drifts along the map. */
function drawMenuBackdrop(now: number, dt: number): void {
  const b = map.bounds;
  const mid = (b.minX + b.maxX) / 2;
  const x = mid + (b.maxX - b.minX) * 0.3 * Math.sin(now / 1000 / 24);
  const y = map.spawns[0]!.y + 2;
  camera.follow(x, y, x, y, dt, map);
  options.overlay = view3d?.drawing ?? false;
  view3dCanvas.style.visibility = options.overlay ? 'visible' : 'hidden';
  renderer.render(EMPTY_FRAME, dt, { ...options, hud: 'none', reticle: false }, '');
  view3d?.render(EMPTY_FRAME, dt);
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;

  // UI toggles (not gameplay inputs); the app keeps only the net graph, on its bound keys
  let toggled = false;
  if (appMode) {
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
  sampler.clearPresses();
  if (toggled) panel?.pane.refresh();

  if (!mode) {
    drawMenuBackdrop(now, dt);
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
  const me = f.players.find((p) => p.id === f.localId);
  const mouse = sampler.mouseWorld(camera);
  if (me) camera.follow(me.x, me.y, mouse.x, mouse.y, dt, map);
  renderer.mouse.x = sampler.mouseX;
  renderer.mouse.y = sampler.mouseY;
  renderer.render(f, dt, options, HELP);
  fxFrame(f, dt); // flashbang white-out / gas edge over the view (arsenal B, apps/web/src/fx)
  shell.update(mode instanceof LocalMode ? mode : null);
  shell.setMapEvent(f.mapEvent);
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
  if (now - lastRaf > 100) frame(now);
}, 16);
