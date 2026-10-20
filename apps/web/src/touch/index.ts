/**
 * Touch controls for phones and tablets (docs/01 §4): twin sticks and buttons that produce the same
 * `Input` the keyboard does, so local play, prediction and the wire don't change.
 *
 * Mount once (main.ts): `mountTouch({ sampler, camera, renderer, view3d })`. The controls come up on
 * touch devices (a coarse pointer) or as soon as the screen is touched, and Settings can force them
 * on or off. Only this small module loads up front; the HUD itself (controller.ts) is a separate
 * chunk fetched when it's first needed, so desktop players never download it.
 *
 * Settings and the HUD layout are saved on the device (localStorage). The API below is what the
 * Settings screen calls (touch-interfaces.md in the shared notes).
 */
import { defaultTuning, type Tuning } from '@military-forge/content';
import type { Input, SimEvent } from '@military-forge/sim';
import type { Camera } from '../camera';
import type { ThrowLatch } from '../input';
import type { TouchController, TouchFrame } from './controller';
import { clearLayout, loadSettings, saveSettings, sanitizeSettings, type KeyValueStore, type TouchSettings } from './settings';
import { drillSeen, markDrillSeen, saveSeen } from './teach';

export type { FireMode, Handed, TouchMode, TouchSettings } from './settings';

/** Phones: sharp on a small, dense screen; dynamic resolution still drops the render scale when slow. */
export const MOBILE_DPR_CAP = 1.5;

/** What the touch layer hooks into. Only the members it uses, so any sampler/renderer shape fits. */
export interface TouchDeps {
  sampler: {
    sample(camera: Camera, sx: number, sy: number, out?: Input): Input;
    consumeWheel(): number;
    mouseX: number;
    mouseY: number;
    /** set by the app shell while menus are open (GameInput in main.ts) */
    blocked?: boolean;
    /** the grenade throw latch (input.ts): the touch button taps and holds through it like the G key */
    throwLatch?: ThrowLatch;
  };
  camera: Camera;
  renderer: {
    render(frame: TouchFrame, ...rest: never[]): void;
    onEvents(events: readonly SimEvent[], localId: number): void;
  };
  /**
   * The 3D view. setShakeScale (0–1: Settings → Touch → Camera shake) is render3d-b's to add; until it
   * exists the setting is saved and waits (touch-interfaces.md, the shared notes).
   */
  view3d?: { setDprCap?(cap: number | null): void; setTouchDevice?(on: boolean): void; setShakeScale?(k: number): void } | null;
  /** a ✎ button on the controls opens the HUD editor (off once a Settings screen offers it) */
  editButton?: boolean;
  /** the room's tuning (the dash's flick mapping reads it); null or absent: the defaults */
  tuning?: () => Pick<Tuning, 'dashFlickFull'> | null;
}

let settings: TouchSettings = loadSettings(null);
let controller: TouchController | null = null;
let loading: Promise<void> | null = null;
let deps: TouchDeps | null = null;
let touchedOnce = false;
/** "Learn the controls" was asked for before the controls were up (Settings, the controls card) */
let drillPending = false;
const listeners = new Set<() => void>();

function storage(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A phone or tablet: the primary pointer is a finger (a touchscreen laptop's is still the mouse). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !window.matchMedia('(any-pointer: fine)').matches);
}

function wanted(): boolean {
  if (settings.mode === 'on') return true;
  if (settings.mode === 'off') return false;
  return isTouchDevice() || touchedOnce;
}

function notify(): void {
  for (const fn of listeners) fn();
}

/** Brings the controls up or down to match the settings (loading the HUD the first time). */
function sync(): void {
  if (!deps) return;
  if (wanted() && !controller) {
    loading ??= Promise.all([import('./controller'), import('./layout')]).then(([{ TouchController }, { loadLayout }]) => {
      const d = deps!;
      const host = {
        get mouseX() {
          return d.sampler.mouseX;
        },
        set mouseX(v: number) {
          d.sampler.mouseX = v;
        },
        get mouseY() {
          return d.sampler.mouseY;
        },
        set mouseY(v: number) {
          d.sampler.mouseY = v;
        },
        camera: d.camera,
        blocked: () => d.sampler.blocked === true,
        throwLatch: d.sampler.throwLatch ?? null,
        dashFlickFull: () => (d.tuning?.() ?? defaultTuning).dashFlickFull,
      };
      controller = new TouchController(host, settings, loadLayout(storage()), storage(), setTouchSettings, d.editButton ?? true);
      if (drillPending) controller.startDrill();
      drillPending = false;
      if (import.meta.env.DEV) controller.onAction((a) => (window as unknown as { __touch?: { actions: string[] } }).__touch?.actions.push(a));
      controller.setActive(wanted());
      notify();
    });
    return;
  }
  controller?.setActive(wanted());
  notify();
}

/**
 * The one-line mount (main.ts). Wraps the sampler (touch input joins the keyboard's), the renderer
 * (aim-assist targets, hit vibration) and picks phone graphics settings on touch devices.
 */
export function mountTouch(d: TouchDeps): void {
  if (deps) return;
  deps = d;
  settings = loadSettings(storage());

  const sample = d.sampler.sample.bind(d.sampler);
  d.sampler.sample = (camera, sx, sy, out) => {
    const input = sample(camera, sx, sy, out);
    if (controller && !d.sampler.blocked) controller.apply(input, sx, sy);
    return input;
  };
  const wheel = d.sampler.consumeWheel.bind(d.sampler);
  d.sampler.consumeWheel = () => wheel() + (controller?.takeZoom() ?? 0);
  const render = d.renderer.render.bind(d.renderer) as (...args: unknown[]) => void;
  d.renderer.render = ((frame: Parameters<TouchDeps['renderer']['render']>[0], ...rest: unknown[]) => {
    controller?.onFrame(frame);
    render(frame, ...rest);
  }) as TouchDeps['renderer']['render'];
  const onEvents = d.renderer.onEvents.bind(d.renderer);
  d.renderer.onEvents = (events, localId) => {
    onEvents(events, localId);
    controller?.onEvents(events, localId);
  };

  // dev builds: the API on window for automated checks (scripts/touch-check.mjs) and console poking
  if (import.meta.env.DEV)
    Object.assign(window, {
      __touch: {
        getTouchSettings,
        setTouchSettings,
        openTouchEditor,
        resetTouchLayout,
        touchActive,
        requestDrill,
        resetTouchHints,
        sticks: () => controller?.debugState() ?? null,
        /** what the player did, newest last (the v3 checks) */
        actions: [] as string[],
      },
    });
  applyShake();

  // phones and tablets: the presets' touch pixel-ratio caps (up to 3× on High: render3d presets.ts);
  // dynamic resolution stays on
  if (isTouchDevice()) d.view3d?.setTouchDevice?.(true);

  // auto: the first finger on the screen brings the controls up (a touchscreen laptop, say)
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch' || touchedOnce) return;
      touchedOnce = true;
      if (settings.mode === 'auto') sync();
    },
    { capture: true },
  );
  sync();
}

export function getTouchSettings(): TouchSettings {
  return { ...settings };
}

/** Changes and saves touch settings; the controls follow at once (mode on/off/auto included). */
export function setTouchSettings(patch: Partial<TouchSettings>): void {
  settings = sanitizeSettings({ ...settings, ...patch });
  saveSettings(storage(), settings);
  controller?.applySettings(settings);
  applyShake();
  sync();
}

/** Camera shake (Settings → Touch): the 3D view's, on touch devices only (the desktop keeps its own). */
function applyShake(): void {
  if (deps && isTouchDevice()) deps.view3d?.setShakeScale?.(settings.shake);
}

/**
 * "Learn the controls" (touch-controls-v3.md §3): the drill starts as soon as the player is in a game
 * with the touch controls up (now, if they are).
 */
export function requestDrill(): void {
  if (controller) controller.startDrill();
  else drillPending = true;
}

/** The drill was finished or closed on this phone (it no longer starts by itself in Training). */
export function drillDone(): boolean {
  return drillSeen(storage());
}

/** Settings → Touch → Show hints again: the first-time hints show again, and the drill starts by itself again. */
export function resetTouchHints(): void {
  controller?.resetHints();
  if (!controller) saveSeen(storage(), new Set());
  markDrillSeen(storage(), false);
}

/** The touch controls are on screen (or would be, outside the menus). */
export function touchActive(): boolean {
  return controller?.isActive ?? false;
}

/** Opens the HUD editor (drag, resize, fade each control), bringing the controls up if needed. */
export function openTouchEditor(): void {
  if (settings.mode === 'off') setTouchSettings({ mode: 'on' });
  touchedOnce = true;
  sync();
  void (loading ?? Promise.resolve()).then(() => controller?.openEditor());
}

/** Back to the default layout (sizes, places, opacity) for this device. */
export function resetTouchLayout(): void {
  clearLayout(storage());
  controller?.applySettings(settings, { placements: {} });
}

/**
 * The HUD's values and state tokens for this frame (hud.ts calls it once per update): the controls
 * wear them (the HP and fuel arcs, the ammo ring, the counts; skin.ts). A no-op until the controls
 * are up, so the desktop pays one function call.
 */
export function feedTouchHud(values: Readonly<Record<string, string>>, tokens: readonly string[]): void {
  if (controller?.isActive) controller.feed(values, tokens);
}

/** Called when the settings or the controls' visibility change. Returns an unsubscribe. */
export function onTouchChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
