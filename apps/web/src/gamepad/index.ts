/**
 * Game controllers (DualSense, DualShock 4, Xbox and other standard pads) through the Gamepad API:
 * play, the menus, rumble, and prompts in the pad's own buttons.
 *
 * Mount once (main.ts), after mountTouch: `mountGamepad({ sampler, camera, renderer })`. Like touch,
 * it wraps the sampler's `sample` (the pad's buttons join the keyboard's in the same `Input`, so the
 * sim, prediction and the wire never know) and `consumeWheel` (zoom), and the renderer's frames and
 * events (aim assist, rumble). Pages without a game (the Armory) call `mountPadMenus()` for the menus only.
 *
 * Shared notes: gamepad-interfaces.md.
 */
import type { Input, SimEvent } from '@military-forge/sim';
import type { Camera } from '../camera';
import type { ThrowLatch } from '../input';
import { appMenuScope, appOverlayScope, sendKey } from './menus';
import { PadManager, type PadFrame, type PadHost } from './manager';
import type { MapDef } from '@military-forge/content';
import { currentDevice, currentPadFamily, onInputDevice, setGlyphSetting, startDeviceTracking } from './device';
import { padGlyphSvg, padLabel } from './glyphs';
import { applyPadPreset, type PadPresetId, type PadSettings } from './settings';
import './pad.css';

export { currentDevice, currentPadFamily, onInputDevice, type InputDevice, type InputKind } from './device';
export { isPadCode } from './glyphs';
export type { PadSettings } from './settings';

let manager: PadManager | null = null;

/** The running manager (Settings' Controller section, the test page); null before a mount. */
export function padManager(): PadManager | null {
  return manager;
}

export interface GamepadDeps {
  sampler: {
    sample(camera: Camera, sx: number, sy: number, out?: Input): Input;
    consumeWheel(): number;
    mouseX: number;
    mouseY: number;
    blocked?: boolean;
    throwLatch?: ThrowLatch;
  };
  camera: Camera;
  renderer: {
    render(frame: PadFrame, ...rest: never[]): void;
    onEvents(events: readonly SimEvent[], localId: number): void;
  };
  /** the keyboard code that holds the scoreboard open (the HUD listens for it) */
  scoreboardCode?: () => string | undefined;
  /** the map being played (aim assist's line of sight: walls hide enemies) */
  map?: () => MapDef | null;
  /** View / Share double-tapped: the big map (minimap/) */
  toggleMap?: () => void;
}

const escape = () => sendKey(window, 'Escape');

/** Plays, drives the app's menus and rumbles: the one-line mount in main.ts. */
export function mountGamepad(d: GamepadDeps): PadManager {
  if (manager) return manager;
  startDeviceTracking();
  const host: PadHost = {
    sampler: d.sampler,
    camera: d.camera,
    menuScope: () => appMenuScope(),
    overlayScope: () => appOverlayScope(),
    back: escape,
    pause: escape,
    scoreboard: (down) => {
      const code = d.scoreboardCode?.() ?? 'Tab';
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: code === 'Tab' ? 'Tab' : code, code, bubbles: true, cancelable: true }));
    },
    map: d.map,
    ...(d.toggleMap ? { toggleMap: d.toggleMap } : {}),
  };
  const m = (manager = new PadManager(host));

  const sample = d.sampler.sample.bind(d.sampler);
  d.sampler.sample = (camera, sx, sy, out) => {
    const input = sample(camera, sx, sy, out);
    if (!d.sampler.blocked) m.apply(input, sx, sy);
    return input;
  };
  const wheel = d.sampler.consumeWheel.bind(d.sampler);
  d.sampler.consumeWheel = () => wheel() + m.takeZoom();
  const render = d.renderer.render.bind(d.renderer) as (...args: unknown[]) => void;
  d.renderer.render = ((frame: Parameters<GamepadDeps['renderer']['render']>[0], ...rest: unknown[]) => {
    m.onFrame(frame);
    render(frame, ...rest);
  }) as GamepadDeps['renderer']['render'];
  const onEvents = d.renderer.onEvents.bind(d.renderer);
  d.renderer.onEvents = (events, localId) => {
    onEvents(events, localId);
    m.onEvents(events, localId);
  };

  mountHints(m);
  m.start();
  // dev builds: the manager, the device, and a layout switch for scripts (pad-check.mjs)
  if (import.meta.env.DEV) Object.assign(window, { __pad: { manager: m, device: currentDevice, layout: (id: PadPresetId) => m.applySettings(applyPadPreset(m.settings, id), false) } });
  return m;
}

/**
 * The menus only (a page without a game: the Armory, the standalone Locker): the whole page is the
 * menu; Circle / B and Options press its Back button (`[data-action="exit"]`), or go back a page.
 */
export function mountPadMenus(root: Element = document.body): PadManager {
  if (manager) return manager;
  startDeviceTracking();
  const back = () => {
    const exit = root.querySelector<HTMLElement>('[data-action="exit"], [aria-label="Back"]');
    if (exit) exit.click();
    else sendKey(window, 'Escape');
  };
  const m = (manager = new PadManager({ menuScope: () => appMenuScope() ?? root, back, pause: back }));
  mountHints(m);
  m.start();
  if (import.meta.env.DEV) Object.assign(window, { __pad: { manager: m, device: currentDevice } });
  return m;
}

/** Settings → Controls → Controller (and the shell's applySettings): the pad's settings and "Reduce flashes". */
export function applyPadSettings(settings: PadSettings, reduceFlashes: boolean): void {
  setGlyphSetting(settings.glyphs);
  manager?.applySettings(settings, reduceFlashes);
}

// ------------------------------------------------------------------ the hint bar

/** A glyph and its words, as markup for the hint bar. */
function hint(code: string, words: string): string {
  const f = currentPadFamily();
  return `<span class="mf-pad-hints__i"><span class="mf-padglyph" aria-hidden="true">${padGlyphSvg(code, f)}</span><span class="mf-pad-hints__t" aria-hidden="true">${words}</span><span class="mf-sr">${padLabel(code, f, { dualSense: currentDevice().dualSense })}: ${words}</span></span>`;
}

/**
 * A small bar in the bottom-right corner while a pad drives the menus: what Cross / A, Circle / B
 * and L1 / R1 do here; over play, that Share / View reaches the buttons on screen. The pad's own
 * element (not the HUD's or the shell's); `html[data-input="pad"]` shows it.
 */
function mountHints(m: PadManager): void {
  const bar = document.createElement('div');
  bar.className = 'mf-pad-hints';
  // a landmark of its own (a note outside every landmark is lost to a screen reader's landmark list)
  bar.setAttribute('role', 'complementary');
  bar.setAttribute('aria-label', 'Controller buttons');
  document.body.appendChild(bar);
  let last = '';
  const draw = () => {
    let html = '';
    const s = currentDevice().kind === 'pad' ? m.state : null;
    if (s?.connected) {
      if (s.mode === 'capture') html = `<span class="mf-pad-hints__i"><span class="mf-pad-hints__t">Press the button you want…</span></span>`;
      else if (s.mode === 'menu') html = hint('Pad0', 'Select') + hint('Pad1', 'Back') + (s.tabs ? hint('Pad4', '') + hint('Pad5', 'Tabs') : '');
      else if (s.overlay) html = hint('Pad8', 'Buttons on screen');
    }
    if (html !== last) {
      last = html;
      bar.innerHTML = html;
      bar.hidden = html === '';
    }
  };
  bar.hidden = true;
  m.onChange(draw);
  onInputDevice(draw);
  // overlays come and go without the pad's mode changing (the warm-up bar, the controls card)
  setInterval(draw, 400);
}
