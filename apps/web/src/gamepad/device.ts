/**
 * Which input the player used last (keyboard and mouse, touch, or a controller), so prompts show
 * that device's buttons and phones put their thumb dials away while a pad plays. Small and eager:
 * the HUD's keycaps (ui/icons.ts capText) read it.
 *
 * Writes `<html data-input="keys|touch|pad">` and, while a pad is the device, `data-pad="playstation|
 * xbox|nintendo|generic"`, so CSS can show pad hints. Synthetic events (the pad's own Escape and Tab,
 * the touch buttons') never switch it: only trusted ones do.
 */
import { glyphFamily, type GlyphFamily } from './glyphs';
import type { GlyphSetting } from './settings';
import type { PadFamily } from './standard';

export type InputKind = 'keys' | 'touch' | 'pad';

export interface InputDevice {
  kind: InputKind;
  /** the last pad used (its family), even after switching back to keys: what Settings shows */
  pad: PadFamily | null;
  /** a DualSense (the Create button) */
  dualSense: boolean;
}

/** The pure part: the device after an event, or the same object when nothing changes (unit-tested). */
export function nextDevice(d: InputDevice, kind: InputKind, pad?: { family: PadFamily; dualSense: boolean }): InputDevice {
  if (kind === 'pad' && pad) {
    if (d.kind === 'pad' && d.pad === pad.family && d.dualSense === pad.dualSense) return d;
    return { kind, pad: pad.family, dualSense: pad.dualSense };
  }
  return d.kind === kind ? d : { ...d, kind };
}

/** The glyph family prompts draw: the setting's, or the pad's own. */
export function promptFamily(d: InputDevice, setting: GlyphSetting): GlyphFamily {
  if (setting !== 'auto') return setting;
  return glyphFamily(d.pad ?? 'xbox');
}

/** A real mouse move this far (px, since the last pad use) counts as switching to the mouse; a nudge doesn't. */
export const MOUSE_SWITCH_PX = 24;

let device: InputDevice = { kind: 'keys', pad: null, dualSense: false };
let glyphSetting: GlyphSetting = 'auto';
const listeners = new Set<(d: InputDevice) => void>();
let started = false;
let mouseTravel = 0;

export function currentDevice(): InputDevice {
  return device;
}

/** The family pad prompts use now (Settings' choice, or the pad's own). */
export function currentPadFamily(): GlyphFamily {
  return promptFamily(device, glyphSetting);
}

export function setGlyphSetting(s: GlyphSetting): void {
  if (s === glyphSetting) return;
  glyphSetting = s;
  publish();
}

/** Called when the device or the glyph setting changes. Returns an unsubscribe. */
export function onInputDevice(fn: (d: InputDevice) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(): void {
  if (typeof document !== 'undefined') {
    const html = document.documentElement;
    html.dataset.input = device.kind;
    if (device.kind === 'pad') html.dataset.pad = currentPadFamily();
    else delete html.dataset.pad;
  }
  for (const fn of listeners) fn(device);
}

function set(next: InputDevice): void {
  if (next === device) return;
  device = next;
  if (next.kind === 'pad') mouseTravel = 0;
  publish();
}

/** A pad was used (a button or a stick past half-way). */
export function notePad(family: PadFamily, dualSense = false): void {
  set(nextDevice(device, 'pad', { family, dualSense }));
}

export function noteKeys(): void {
  set(nextDevice(device, 'keys'));
}

export function noteTouch(): void {
  set(nextDevice(device, 'touch'));
}

/** Listens for keys, the mouse and fingers (once; the pad side reports through notePad). */
export function startDeviceTracking(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const opts = { capture: true, passive: true } as const;
  window.addEventListener('keydown', (e) => e.isTrusted && noteKeys(), opts);
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return;
      if (e.pointerType === 'touch' || e.pointerType === 'pen') noteTouch();
      else noteKeys();
    },
    opts,
  );
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!e.isTrusted || device.kind !== 'pad') return;
      // the browser's mouse events after a touch aren't a mouse
      if ((e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
      mouseTravel += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (mouseTravel >= MOUSE_SWITCH_PX) noteKeys();
    },
    opts,
  );
  publish();
}
