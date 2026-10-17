/**
 * Phase 0 debug client entry point.
 *   /            local mode: a deathmatch against the dummy targets (results, Play again) + live tuning, rendered in 3D
 *   /?time=60&kills=5&countdown=3       local match rules (0 = no limit); /?sandbox: free play, no match
 *   /?render=2d  the canvas-2D view instead (?render=3d opts online mode into 3D); ?gfx=low|medium|high
 *   /?online     joins the dev room on ws://<host>:9001 (open in two tabs to play each other)
 *   /?server=ws://host:port&name=Ade   explicit server and name
 *   /?online&rtt=150&loss=2&jitter=5    network conditioner (or ?netsim=up.lat=20,down.lat=120,…)
 *   /?online&lowbw                      low-bandwidth mode (30 Hz inputs, 15 Hz snapshots)
 *   /?online&transport=ws|wt            force WebSocket / WebTransport (default: WT when the server has a gateway)
 */
import { getMap } from '@military-forge/content';
import { createConditionerSettings, parseNetSim } from '@military-forge/netcode';
import { GAME_NAME } from '@military-forge/shared';
import { Camera } from './camera';
import { InputSampler } from './input';
import { LocalMode } from './localMode';
import { OnlineMode } from './onlineMode';
import { Renderer, type RenderOptions } from './render';
import { localMatchRules, mountShell } from './shell';
import { PlaneCamera, Renderer3D, parsePreset } from './render3d';
import { createTuningPanel } from './tuningPanel';

const params = new URLSearchParams(location.search);
const online = params.has('online') || params.has('server');
const serverUrl = params.get('server') ?? `ws://${location.hostname || 'localhost'}:9001`;
const name = (params.get('name') ?? `Pilot-${Math.floor(Math.random() * 9000 + 1000)}`).slice(0, 16);
const shorthand = ['rtt', 'loss', 'jitter', 'dup']
  .filter((k) => params.has(k))
  .map((k) => `${k}=${params.get(k)}`)
  .join(',');
const netSim = parseNetSim(params.get('netsim') ?? shorthand) ?? createConditionerSettings(false);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const bar = document.getElementById('bar')!;
const panelEl = document.getElementById('panel')!;
const toast = document.getElementById('toast')!;

function showToast(message: string): void {
  toast.textContent = message;
  toast.style.display = 'block';
}

document.title = `${GAME_NAME} · Phase 0 prototype`;
bar.innerHTML = `
  <strong>${GAME_NAME.toUpperCase()} · Phase 0</strong>
  <a href="/" class="${online ? '' : 'active'}">Local + dummies</a>
  <a href="/?online" class="${online ? 'active' : ''}">Online (${serverUrl.replace(/^wss?:\/\//, '')})</a>
  <a href="/?online" target="_blank">+ 2nd tab</a>
  <a href="/locker.html">Locker</a>
`;

// 3D draws the world under the 2D canvas, which becomes the HUD + debug overlay (H/B)
const use3d = (params.get('render') ?? (online ? '2d' : '3d')) === '3d' && Renderer3D.supported();
const planeCamera = use3d ? new PlaneCamera() : null;
const camera = planeCamera ?? new Camera();
const sampler = new InputSampler(canvas);
const options: RenderOptions = { showHitboxes: false, showGrid: !use3d, showNet: online, overlay: use3d };

const map = getMap('movement-test');
let mode: LocalMode | OnlineMode;
const renderer = new Renderer(canvas, camera, map, () => mode.tuning());
const view3d = planeCamera
  ? new Renderer3D(document.getElementById('view3d') as HTMLCanvasElement, planeCamera, map, parsePreset(params.get('gfx')), import.meta.env.DEV || params.has('perf'))
  : null;
void view3d?.load(map.spawns[0]!);

if (online) {
  const prefer = params.get('transport');
  mode = new OnlineMode(serverUrl, name, sampler, camera, renderer, showToast, netSim, prefer === 'ws' || prefer === 'wt' ? prefer : 'auto');
} else {
  mode = new LocalMode(sampler, camera, renderer, name, localMatchRules(params));
}

// App shell (W4): screens over the canvas. Other workstreams plug in with one line each, e.g.
// registerRoute({ id: 'locker', title: 'Locker', mount }) from './shell' (opens at #/locker).
const shell = mountShell();

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

const panel = createTuningPanel(panelEl, options, {
  getTuning: () => mode.tuning(),
  onTuningChanged: (t) => {
    if (mode instanceof OnlineMode) mode.setTuning(t);
  },
  respawn: () => mode.respawn(),
  ...(mode instanceof LocalMode
    ? {
        toggleRecording: () => (mode as LocalMode).toggleRecording(),
        downloadReplay,
        loadout: mode.loadout,
        setLoadout: (l: [number, number]) => (mode as LocalMode).setLoadout(l),
      }
    : { netSim, lowBandwidth: { get: () => (mode as OnlineMode).net.lowBandwidth, set: (on: boolean) => (mode as OnlineMode).net.setLowBandwidth(on) } }),
});
if (mode instanceof OnlineMode) {
  mode.onTuningFromServer = () => panel.refresh();
}

const HELP =
  'A/D move · W/Space jet · S crouch (hold on a platform to drop) · LMB fire · V melee · R reload · Q swap · F dual · G frag · wheel zoom · H hitboxes · B grid · N net · ` panel' +
  (online ? '' : ' · P record · O download replay');

function resize(): void {
  renderer.resize();
  view3d?.resize();
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;

  // UI toggles (not gameplay inputs)
  let toggled = false;
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
  if (sampler.consumePress('KeyK')) mode.respawn();
  if (sampler.consumePress('Backquote')) panelEl.style.display = panelEl.style.display === 'none' ? '' : 'none';
  if (mode instanceof LocalMode) {
    if (sampler.consumePress('KeyP')) mode.toggleRecording();
    if (sampler.consumePress('KeyO')) downloadReplay();
  }
  sampler.clearPresses();
  if (toggled) panel.pane.refresh();

  const wheel = sampler.consumeWheel();
  if (wheel !== 0) camera.setZoom(camera.zoom + wheel, mode.zoomMax());
  else camera.setZoom(camera.zoom, mode.zoomMax());

  const f = mode.update(dt);
  const me = f.players.find((p) => p.id === f.localId);
  const mouse = sampler.mouseWorld(camera);
  if (me) camera.follow(me.x, me.y, mouse.x, mouse.y, dt, map);
  renderer.mouse.x = sampler.mouseX;
  renderer.mouse.y = sampler.mouseY;
  renderer.render(f, dt, options, HELP);
  shell.update(mode instanceof LocalMode ? mode : null);
  view3d?.render(f, dt);
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
