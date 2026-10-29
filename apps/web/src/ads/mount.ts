/**
 * Tap-to-save in the game (one line in main.ts, after the touch and pad mounts): listens for the
 * save gestures (gesture.ts), asks the boards being drawn which creative is under the point
 * (render3d/ads drawnBoards().pickAt), saves it to the queue (saved.ts) and says so on the quiet
 * toast. It wraps the sampler's `sample` (read only: it notes which samples fired) and the 3D view's
 * `render` (the frame: who is where, what is underfoot). Nothing here changes an Input.
 */
import type { Input } from '@military-forge/sim';
import type { Camera } from '../camera';
import { padManager, currentDevice, currentPadFamily } from '../gamepad';
import { padLabel } from '../gamepad/glyphs';
import { SELECT_DOUBLE_TAP_MS } from '../gamepad/manager';
import { typingInto, type KeyBindings } from '../input';
import type { SavedPick } from '../render3d/ads';
// three-free: tap-to-save mounts at boot, before the 3D view's chunk (audit 28 Oct)
import { drawnBoards } from '../render3d/ads/drawn';
import { keyLabel } from '../shell/controls';
import { logicalPoint, logicalRect } from '../ui/landscape';
import type { Frame } from '../view';
import { weaponUnderfoot } from '../weaponItems';
import { FIRE_SETTLE_MS, FireLog, PadTap, TapTracker, decide, keySaves, middleClickSaves, type Pending } from './gesture';
import { savedAds, type SavedAds } from './saved';
import { AdToast, savedLine } from './toast';

export interface AdClickDeps {
  sampler: {
    sample(camera: Camera, sx: number, sy: number, out?: Input): Input;
    mouseX: number;
    mouseY: number;
    blocked: boolean;
    bindings: KeyBindings;
  };
  camera: Camera;
  /** the canvas the camera's screen space is measured on (#game) */
  canvas: HTMLElement;
  view3d: { render(frame: Frame, dt: number): void } | null;
  queue?: SavedAds;
}

export const HINT_KEY = 'mf.ads.hint.v1';
/** a savable board in view this long (ms) before the one-time hint */
const HINT_AFTER_MS = 2500;

export interface AdClicks {
  /** for tests and dev builds: try a save at a page point (as a tap would) */
  saveAtPage(x: number, y: number): SavedPick | null;
  toast: AdToast;
}

/** Mounts tap-to-save once; null without a 3D view (the boards are 3D only). */
export function mountAdClicks(d: AdClickDeps): AdClicks | null {
  if (!d.view3d) return null;
  const { sampler, camera, canvas } = d;
  const queue = d.queue ?? savedAds();
  const toast = new AdToast();
  const fire = new FireLog();
  const taps = new TapTracker();
  const padTap = new PadTap();
  let pending: Pending | null = null;
  /** what was under the gesture when it happened (the camera may move before the verdict) */
  let pendingHit: SavedPick | null = null;
  /** the waiting gesture is the pad's tap (a second tap soon after is the big map, not a save) */
  let pendingPad = false;
  let lastSaveAt = -Infinity;
  let frame: Frame | null = null;
  let hintSince = -1;

  // every sample, after keyboard, touch and pad: did it fire?
  const sample = sampler.sample.bind(sampler);
  sampler.sample = (cam, sx, sy, out) => {
    const input = sample(cam, sx, sy, out);
    fire.note(input.buttons, performance.now());
    return input;
  };

  const render = d.view3d.render.bind(d.view3d);
  d.view3d.render = (f, dt) => {
    frame = f;
    render(f, dt);
    tick(performance.now());
  };

  /** in play: no menu over the game, the boards on screen */
  const playing = () => !sampler.blocked && !document.querySelector('#shell .screen--menu, #shell .mf-fit--modal') && drawnBoards() !== null;

  /** Page px → the gameplay plane (m), through the camera's screen space (the #game canvas). */
  const planeAt = (sx: number, sy: number) => ({ x: camera.toWorldX(sx), y: camera.toWorldY(sy) });
  const pickScreen = (sx: number, sy: number): SavedPick | null => {
    const b = drawnBoards();
    if (!b) return null;
    const p = planeAt(sx, sy);
    const hit = b.pickAt(p.x, p.y);
    return hit?.frame.click ? hit : null;
  };
  const pagePoint = (x: number, y: number) => {
    const r = logicalRect(canvas);
    return { x: x - r.left, y: y - r.top };
  };

  const save = (hit: SavedPick, now: number) => {
    const click = hit.frame.click!;
    const result = queue.save(click, hit.frame.c, hit.title, hit.image);
    lastSaveAt = now;
    toast.show(savedLine(click.name, result === 'again'));
    markHinted();
  };

  /** A gesture at screen point (sx, sy): waits for the samples after it, then saves if nothing fired. */
  const queueAt = (sx: number, sy: number, since: number, settle: number) => {
    const hit = playing() ? pickScreen(sx, sy) : null;
    if (!hit) return;
    pending = { x: sx, y: sy, since, at: performance.now() + settle };
    pendingHit = hit;
    pendingPad = false;
  };

  function tick(now: number): void {
    // the pad: a tap of the scoreboard button with the reticle on a board
    const pad = padManager();
    if (pad && currentDevice().kind === 'pad') {
      const gp = pad.active;
      const held = !!gp && (pad.settings.bindings.scoreboard ?? []).some((i) => gp.buttons[i]?.pressed);
      const tapAt = padTap.poll(held, now);
      if (tapAt !== null && pending && pendingPad) {
        // a double tap: the big map (gamepad/manager.ts), never a save
        pending = pendingHit = null;
        pendingPad = false;
      } else if (tapAt !== null && !pad.state.overlay && pad.state.mode === 'play') {
        // decided once a second tap can no longer come
        queueAt(sampler.mouseX, sampler.mouseY, tapAt, Math.max(FIRE_SETTLE_MS, SELECT_DOUBLE_TAP_MS));
        pendingPad = pending !== null;
      }
    }
    if (pending) {
      const verdict = decide(pending, now, fire, lastSaveAt);
      if (verdict !== 'wait') {
        const hit = pendingHit;
        pending = pendingHit = null;
        // still in play (no menu came up meanwhile)
        if (verdict === 'save' && hit && playing()) save(hit, now);
      }
    }
    hintTick(now);
  }

  // ---- mouse and keyboard

  window.addEventListener('keydown', (e) => {
    if (e.repeat || typingInto(e.target) || !keySaves(e.code, sampler.bindings) || fire.held || !playing()) return;
    // E takes a gun underfoot (the sim's): then it does that, and saves nothing
    const me = frame?.players.find((p) => p.id === frame!.localId);
    if (me?.alive && weaponUnderfoot(frame!.pickups, me)) return;
    queueAt(sampler.mouseX, sampler.mouseY, performance.now(), 0);
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!middleClickSaves(e.button, sampler.bindings) || fire.held || !playing()) return;
    queueAt(sampler.mouseX, sampler.mouseY, performance.now(), 0);
  });

  // ---- touch and pen (window, capture: the touch layer claims these touches too, and keeps doing so)

  const eligible = (t: EventTarget | null) => {
    const el = t as Element | null;
    if (!document.documentElement.hasAttribute('data-touch-playing')) return false;
    if (el?.closest?.('[data-mf-control], [data-mf-edit], .mf-bay-ui, .mf-bay-back, button, a[href], [role="button"], input, #shell')) return false;
    return el === document.documentElement || el === document.body || el instanceof HTMLCanvasElement || !!el?.closest?.('.mf-touch');
  };
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return;
      const at = logicalPoint(e);
      taps.down(e.pointerId, at.x, at.y, performance.now(), eligible(e.target));
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'mouse') return;
      const at = logicalPoint(e);
      taps.move(e.pointerId, at.x, at.y);
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'pointerup',
    (e) => {
      if (e.pointerType === 'mouse') return;
      const at = logicalPoint(e);
      const tap = taps.up(e.pointerId, at.x, at.y, performance.now());
      if (!tap) return;
      const p = pagePoint(tap.x, tap.y);
      queueAt(p.x, p.y, tap.downAt, FIRE_SETTLE_MS);
    },
    { capture: true, passive: true },
  );
  window.addEventListener('pointercancel', (e) => taps.cancel(e.pointerId), { capture: true, passive: true });
  window.addEventListener('blur', () => {
    taps.clear();
    pending = null;
  });

  // ---- the one-time hint: how to save, the first time a savable board has been in view a while

  let hinted = readHinted();
  function markHinted(): void {
    if (hinted) return;
    hinted = true;
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // blocked storage: the hint may come back next visit
    }
  }
  function hintTick(now: number): void {
    if (hinted || !playing()) {
      hintSince = -1;
      return;
    }
    const kind = currentDevice().kind;
    // touch and pad: a board in view; mouse: the cursor resting on one
    const b = drawnBoards();
    const looking = kind === 'keys' ? !!pickScreen(sampler.mouseX, sampler.mouseY) : !!b && b.litOnScreenSavable();
    if (!looking) {
      if (kind === 'keys') hintSince = -1;
      return;
    }
    if (hintSince < 0) hintSince = now;
    if (now - hintSince < HINT_AFTER_MS) return;
    toast.show(hintLine(kind, sampler.bindings, padManager()?.settings.bindings.scoreboard?.[0]), 5000);
    markHinted();
  }

  const api: AdClicks = {
    toast,
    saveAtPage(x, y) {
      const p = pagePoint(x, y);
      const hit = playing() ? pickScreen(p.x, p.y) : null;
      if (hit) save(hit, performance.now());
      return hit;
    },
  };
  // dev builds: the queue, the fire log and a board probe (screen px → the creative there, savable or not)
  if (import.meta.env.DEV) {
    const probe = (sx: number, sy: number) => {
      const p = planeAt(sx, sy);
      return drawnBoards()?.pickAt(p.x, p.y) ?? null;
    };
    (window as unknown as { __ads: unknown }).__ads = { ...api, queue, fire, pickScreen, probe };
  }
  return api;
}

function readHinted(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** How to save, in the player's own controls. */
export function hintLine(kind: 'keys' | 'touch' | 'pad', bindings: KeyBindings, padButton = 8): string {
  if (kind === 'touch') return 'Like a billboard? Tap it to save the ad for after the match';
  if (kind === 'pad') return `Like a billboard? Aim at it and tap ${padLabel(`Pad${padButton}`, currentPadFamily()) || 'View'} to save the ad for after the match`;
  const key = Object.entries(bindings.keys).find(([code]) => keySaves(code, bindings))?.[0];
  return `Like a billboard? Point at it and press ${key ? keyLabel(key) : 'middle-click'} to save the ad for after the match`;
}
