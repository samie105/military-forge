/**
 * The touch HUD's controls, their default places, and what the player changed (pure, unit-tested).
 * Placements are fractions of the safe-area box (x from the left, y from the top; size of its
 * shorter side), stored for the right-handed layout; the left-handed one mirrors them.
 */
import { Btn } from '@military-forge/sim';
import { LAYOUT_KEY, LIMITS, clamp, type Handed, type KeyValueStore } from './settings';

export type ControlId = 'move' | 'aim' | 'grenade' | 'cycleGrenade' | 'dash' | 'melee' | 'reload' | 'swap' | 'zoom' | 'shield' | 'take' | 'pause' | 'scores' | 'fire' | 'fireLeft';

export interface ControlDef {
  id: ControlId;
  /** stick: a floating thumb-stick zone; drag: a button that is also a small stick; tap: a button */
  kind: 'stick' | 'drag' | 'tap';
  /** its name in the editor */
  label: string;
  /** what it means to the sim (0: handled by the controller: zoom, pause, scoreboard) */
  bit: number;
  /** a key it stands in for, for the parts of the app that listen to keys (menu, scoreboard) */
  key?: string;
  /** a short description for the editor */
  title: string;
}

export interface Placement {
  x: number;
  y: number;
  size: number;
  opacity: number;
}

/** The shield button exists once the sim has `Btn.Shield` (bit 14, protocol registry). */
export const SHIELD_BIT: number = (Btn as Record<string, number>).Shield ?? 0;

export const CONTROLS: readonly ControlDef[] = [
  { id: 'move', kind: 'stick', label: 'Move', bit: 0, title: 'Move: push up to jet, down to crouch; swipe and lift to dash' },
  { id: 'aim', kind: 'stick', label: 'Aim and fire', bit: 0, title: 'Aim (and fire)' },
  { id: 'grenade', kind: 'drag', label: 'Grenade', bit: Btn.Grenade, title: 'Grenade: tap to throw; swipe up or down to change the type; hold and drag to aim the arc, release to throw' },
  { id: 'cycleGrenade', kind: 'tap', label: 'Next grenade', bit: Btn.CycleGrenade, title: 'Next grenade type' },
  { id: 'dash', kind: 'tap', label: 'Dash', bit: Btn.Dash, title: 'Dash: swipe it any way to dash that way; a tap dashes the way the move stick points (or the way you face)' },
  { id: 'melee', kind: 'tap', label: 'Melee', bit: Btn.Melee, title: 'Melee' },
  { id: 'reload', kind: 'tap', label: 'Reload', bit: Btn.Reload, title: 'Reload (tap, or swipe down)' },
  { id: 'swap', kind: 'tap', label: 'Swap guns', bit: Btn.Swap, title: 'Swap guns: tap or swipe; hold for a radial with both guns and melee' },
  { id: 'zoom', kind: 'tap', label: 'Zoom', bit: 0, title: 'Zoom (scoped weapons)' },
  { id: 'shield', kind: 'tap', label: 'Shield', bit: SHIELD_BIT, title: 'Shield: tap to raise or sling; hold to keep it up while held' },
  { id: 'take', kind: 'tap', label: 'Take a gun', bit: Btn.Interact, title: 'Take the weapon you stand on (it swaps the gun in hand)' },
  { id: 'pause', kind: 'tap', label: 'Menu', bit: 0, key: 'Escape', title: 'Menu' },
  { id: 'scores', kind: 'tap', label: 'Scores', bit: 0, key: 'Tab', title: 'Scoreboard (hold)' },
  // Fire button mode only (settings.fire 'button', §4.4): FIRE fires while held; drag it to aim while firing
  { id: 'fire', kind: 'tap', label: 'Fire', bit: Btn.Fire, title: 'Fire: hold to shoot; drag it to aim while you shoot' },
  { id: 'fireLeft', kind: 'tap', label: 'Fire (left)', bit: Btn.Fire, title: 'Fire, for the left index finger: hold to shoot' },
];

export const CONTROL_IDS: readonly ControlId[] = CONTROLS.map((c) => c.id);

/** Controls the current sim supports (the shield waits for its button bit). */
export function availableControls(): readonly ControlDef[] {
  return CONTROLS.filter((c) => c.id !== 'shield' || SHIELD_BIT !== 0);
}

/** CSS px per mm on a phone (controls spec §0: an iPhone is 6.0, a Pixel 7 6.2): the layout's anchors are in mm. */
export const PX_PER_MM = 6;

/** A safe-box corner, and how far in from its side (dx) and up or down from its edge (dy) a control's centre is, in mm; its hit size (mm). */
export interface Anchor {
  corner: 'BL' | 'BR' | 'TL' | 'TR';
  dx: number;
  dy: number;
  hit: number;
}

/**
 * The Classic layout (controls spec §4.2): every control anchored to a corner of the safe box in mm,
 * so thumbs reach the same places on a 667 px phone and a 932 px one. The action arc sits 42 mm from
 * the bottom-right corner (grenade, dash, the swap pill, the context slot): outside the aim stick's
 * landing spread, 21° apart, 3.4 mm between 12 mm hit areas. Primaries (dash, grenade, FIRE) are 12 mm,
 * secondaries (swap, the context slot) 10, the top bar (menu, scores) 8; the sticks' bases 22 mm.
 * Melee, shield, reload, zoom and Take share the context slot, one at a time (CONTEXT_PRIORITY);
 * next grenade isn't on the HUD (a swipe on the grenade does it). The editor can pin any of them back
 * (TouchLayout.pinned): pinned, a control has its own place (PINNED_ANCHORS).
 */
export const CLASSIC: Readonly<Record<ControlId, Anchor>> = {
  move: { corner: 'BL', dx: 16, dy: 15, hit: 22 },
  aim: { corner: 'BR', dx: 16, dy: 15, hit: 22 },
  grenade: { corner: 'BR', dx: 41.1, dy: 8.7, hit: 12 },
  dash: { corner: 'BR', dx: 35.2, dy: 22.9, hit: 12 },
  swap: { corner: 'BR', dx: 24.7, dy: 34, hit: 10 },
  // the context slot: whichever of these is in play (one at a time)
  take: { corner: 'BR', dx: 10.9, dy: 40.6, hit: 10 },
  melee: { corner: 'BR', dx: 10.9, dy: 40.6, hit: 10 },
  shield: { corner: 'BR', dx: 10.9, dy: 40.6, hit: 10 },
  reload: { corner: 'BR', dx: 10.9, dy: 40.6, hit: 10 },
  zoom: { corner: 'BR', dx: 10.9, dy: 40.6, hit: 10 },
  cycleGrenade: { corner: 'BR', dx: 48, dy: 31, hit: 10 },
  scores: { corner: 'TL', dx: 4, dy: 4, hit: 8 },
  pause: { corner: 'TR', dx: 4, dy: 4, hit: 8 },
  // FIRE (Fire button mode) at the aim stick's rest, 14 mm; the left one for the left index finger
  fire: { corner: 'BR', dx: 16, dy: 15, hit: 14 },
  fireLeft: { corner: 'TL', dx: 20, dy: 14, hit: 12 },
};

/** Where a context control sits when the player pins it to the HUD (the editor): a column left of the arc. */
export const PINNED_ANCHORS: Readonly<Partial<Record<ControlId, Anchor>>> = {
  melee: { corner: 'BR', dx: 55, dy: 8.7, hit: 10 },
  reload: { corner: 'BR', dx: 57, dy: 21, hit: 10 },
  cycleGrenade: { corner: 'BR', dx: 48, dy: 31, hit: 10 },
  shield: { corner: 'BR', dx: 60, dy: 33, hit: 10 },
  zoom: { corner: 'BR', dx: 40, dy: 44, hit: 10 },
};
/** The context slot's controls, most urgent first: a gun underfoot, an enemy in reach, a shield carried, a low magazine, a scope. */
export const CONTEXT_PRIORITY: readonly ControlId[] = ['take', 'melee', 'shield', 'reload', 'zoom'];
/** Controls that are off the HUD unless pinned (next grenade) or the context slot shows them. */
export const OFF_HUD: ReadonlySet<ControlId> = new Set(['cycleGrenade', ...CONTEXT_PRIORITY]);
/** The controls the editor can pin to the HUD. */
export const PINNABLE: readonly ControlId[] = ['cycleGrenade', 'melee', 'reload', 'shield', 'zoom'];

/** The reference safe box (the kit's 812×375 frame less its insets), for a placement asked for without one. */
export const REF_BOX = { w: 724, h: 344 } as const;

/** An anchor as a placement (fractions of a w×h box) for the right-handed layout. */
export function anchorPlacement(a: Anchor, w: number, h: number): Placement {
  const px = a.dx * PX_PER_MM;
  const py = a.dy * PX_PER_MM;
  const x = a.corner === 'BL' || a.corner === 'TL' ? px : w - px;
  const y = a.corner === 'TL' || a.corner === 'TR' ? py : h - py;
  return { x: x / w, y: y / h, size: (a.hit * PX_PER_MM) / Math.min(w, h), opacity: 1 };
}

/** The default placements in the reference box (the editor's and the tests' fallback). */
export const DEFAULT_PLACEMENTS: Readonly<Record<ControlId, Placement>> = Object.fromEntries(
  (Object.keys(CLASSIC) as ControlId[]).map((id) => [id, anchorPlacement(CLASSIC[id], REF_BOX.w, REF_BOX.h)]),
) as Record<ControlId, Placement>;

/**
 * The kit's phone safe box (its --safe-* on .screen--phone): at least these insets, more where the
 * device reports a bigger notch or home indicator (env(safe-area-inset-*), touch.css).
 */
export const SAFE_INSETS = { left: 44, right: 44, top: 10, bottom: 21 } as const;

/** No touch target smaller than this (CSS px), whatever the layout says (the kit's --touch-min). */
export const MIN_TARGET_PX = 48;

/** Controls that are wide pills (their size is the height; the width follows the content). */
export const PILLS: ReadonlySet<ControlId> = new Set(['swap', 'take']);

/** A control's size on screen (px): its fraction of the safe box's shorter side, never under MIN_TARGET_PX. */
export function sizePx(p: Pick<Placement, 'size'>, unit: number): number {
  return Math.max(MIN_TARGET_PX, Math.round(p.size * unit));
}

export interface TouchLayout {
  /** the player's changes (right-handed coordinates); the rest are defaults */
  placements: Partial<Record<ControlId, Placement>>;
  /** controls pinned to the HUD that it doesn't carry by default (next grenade, melee, reload, shield, zoom) */
  pinned?: ControlId[];
}

/**
 * Where a control goes in a w×h safe box (px): the player's own place if it was moved, else its mm
 * anchor (its pinned one, if pinned); mirrored for the left-handed layout.
 */
export function placementFor(layout: TouchLayout, id: ControlId, handed: Handed, box: { w: number; h: number } = REF_BOX): Placement {
  const pinned = layout.pinned?.includes(id) ? PINNED_ANCHORS[id] : undefined;
  const p = layout.placements[id] ?? anchorPlacement(pinned ?? CLASSIC[id], Math.max(1, box.w), Math.max(1, box.h));
  return handed === 'left' ? { ...p, x: 1 - p.x } : { ...p };
}

/** Records an edit made on screen (in the current handedness). */
export function withPlacement(layout: TouchLayout, id: ControlId, screen: Placement, handed: Handed): TouchLayout {
  const p = clampPlacement(handed === 'left' ? { ...screen, x: 1 - screen.x } : screen);
  return { ...layout, placements: { ...layout.placements, [id]: p } };
}

/** Pins a control to the HUD, or unpins it (the editor). */
export function withPinned(layout: TouchLayout, id: ControlId, on: boolean): TouchLayout {
  const pinned = new Set(layout.pinned ?? []);
  if (on) pinned.add(id);
  else pinned.delete(id);
  return { ...layout, pinned: PINNABLE.filter((x) => pinned.has(x)) };
}

/** A guide line the editor shows while a dragged control snaps to it (a fraction of the safe box). */
export interface SnapGuide {
  axis: 'x' | 'y';
  at: number;
}

/** How close (px) a dragged control's centre comes to a guide before it snaps there. */
export const SNAP_PX = 8;

/**
 * The editor's snapping: a dragged control's centre (fractions of a w×h box) lines up with the box's
 * centre lines and with the other controls' centres when it comes within SNAP_PX of one. Returns the
 * snapped centre and the guides it sits on (pure, unit-tested).
 */
export function snapPlacement(at: { x: number; y: number }, others: readonly { x: number; y: number }[], w: number, h: number, tol = SNAP_PX): { x: number; y: number; guides: SnapGuide[] } {
  const best = (v: number, lines: readonly number[], size: number): number | null => {
    let pick: number | null = null;
    let d = tol / Math.max(1, size);
    for (const line of lines) {
      const dd = Math.abs(line - v);
      if (dd <= d) {
        d = dd;
        pick = line;
      }
    }
    return pick;
  };
  const x = best(at.x, [0.5, ...others.map((o) => o.x)], w);
  const y = best(at.y, [0.5, ...others.map((o) => o.y)], h);
  const guides: SnapGuide[] = [];
  if (x !== null) guides.push({ axis: 'x', at: x });
  if (y !== null) guides.push({ axis: 'y', at: y });
  return { x: x ?? at.x, y: y ?? at.y, guides };
}

export function clampPlacement(p: Placement): Placement {
  return {
    x: clamp(p.x, LIMITS.min, LIMITS.max),
    y: clamp(p.y, LIMITS.min, LIMITS.max),
    size: clamp(p.size, LIMITS.sizeMin, LIMITS.sizeMax),
    opacity: clamp(p.opacity, LIMITS.opacityMin, LIMITS.opacityMax),
  };
}

// ---------- persistence (this device only: localStorage) ----------

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The saved layout, with anything malformed, unknown or out of range dropped or clamped. */
export function loadLayout(store: KeyValueStore | null): TouchLayout {
  const placements: Partial<Record<ControlId, Placement>> = {};
  try {
    const raw = JSON.parse(store?.getItem(LAYOUT_KEY) ?? 'null') as { placements?: Record<string, unknown>; pinned?: unknown[] } | null;
    for (const [id, v] of Object.entries(raw?.placements ?? {})) {
      if (!CONTROL_IDS.includes(id as ControlId) || typeof v !== 'object' || v === null) continue;
      const p = v as Record<string, unknown>;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.size)) continue;
      placements[id as ControlId] = clampPlacement({ x: p.x, y: p.y, size: p.size, opacity: isFiniteNumber(p.opacity) ? p.opacity : 1 });
    }
    const pins = Array.isArray(raw?.pinned) ? raw.pinned : [];
    const pinned = PINNABLE.filter((id) => pins.includes(id));
    return pinned.length ? { placements, pinned } : { placements };
  } catch {
    /* unreadable: defaults */
  }
  return { placements };
}

export function saveLayout(store: KeyValueStore | null, layout: TouchLayout): void {
  try {
    store?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* private mode, quota: the layout lasts this session only */
  }
}
