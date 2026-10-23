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

/**
 * Right-handed defaults: the owner's round-two kit's phone HUD (docs/design/military-forge-ui-v2.html,
 * "M1 Phone HUD · thumb dials", 812×375). Its safe box is the frame less 44 px at each side (the
 * notch), 10 px at the top and 21 px at the bottom (724×344: SAFE_INSETS); the thumb dials' 136 px
 * bases sit at (128, 266) and (684, 266); shield, reload, dash, grenade and melee fan round the aim
 * dial as drawn; the swap pill and the menu top right; the take button (only near a crate) at the
 * bottom centre (22 px left of the kit's, so a long gun name stays clear of the melee button). Shield,
 * reload and dash sit a few px further apart than drawn: their rings (the dash's fuel, a reload's
 * progress) reach 5 px past the button, and the kit's places let them touch. The scoreboard sits under
 * the ping (and the "Tuned by admin" tag) on the left. Cycle-grenade, zoom and the scoreboard aren't drawn in the kit and sit where they
 * clear it. A player's saved places (TouchLayout) still win over these.
 */
export const DEFAULT_PLACEMENTS: Readonly<Record<ControlId, Placement>> = {
  move: { x: 0.116, y: 0.744, size: 0.395, opacity: 1 },
  aim: { x: 0.884, y: 0.744, size: 0.395, opacity: 1 },
  shield: { x: 0.888, y: 0.331, size: 0.151, opacity: 1 },
  reload: { x: 0.8025, y: 0.387, size: 0.151, opacity: 1 },
  dash: { x: 0.7265, y: 0.517, size: 0.151, opacity: 1 },
  grenade: { x: 0.7, y: 0.698, size: 0.169, opacity: 1 },
  melee: { x: 0.71, y: 0.878, size: 0.151, opacity: 1 },
  cycleGrenade: { x: 0.619, y: 0.68, size: 0.14, opacity: 1 },
  zoom: { x: 0.967, y: 0.32, size: 0.14, opacity: 1 },
  pause: { x: 0.967, y: 0.07, size: 0.14, opacity: 1 },
  swap: { x: 0.791, y: 0.084, size: 0.151, opacity: 1 },
  take: { x: 0.47, y: 0.907, size: 0.151, opacity: 1 },
  scores: { x: 0.033, y: 0.36, size: 0.14, opacity: 1 },
  // FIRE at the aim dial's rest, 14 mm (84 px; §4.4: BR 16, 15); the left one at TL 20, 14 (the left index finger)
  fire: { x: 0.884, y: 0.744, size: 0.244, opacity: 1 },
  fireLeft: { x: 0.166, y: 0.244, size: 0.209, opacity: 1 },
};

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
}

export function placementFor(layout: TouchLayout, id: ControlId, handed: Handed): Placement {
  const p = layout.placements[id] ?? DEFAULT_PLACEMENTS[id];
  return handed === 'left' ? { ...p, x: 1 - p.x } : { ...p };
}

/** Records an edit made on screen (in the current handedness). */
export function withPlacement(layout: TouchLayout, id: ControlId, screen: Placement, handed: Handed): TouchLayout {
  const p = clampPlacement(handed === 'left' ? { ...screen, x: 1 - screen.x } : screen);
  return { placements: { ...layout.placements, [id]: p } };
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
    const raw = JSON.parse(store?.getItem(LAYOUT_KEY) ?? 'null') as { placements?: Record<string, unknown> } | null;
    for (const [id, v] of Object.entries(raw?.placements ?? {})) {
      if (!CONTROL_IDS.includes(id as ControlId) || typeof v !== 'object' || v === null) continue;
      const p = v as Record<string, unknown>;
      if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.size)) continue;
      placements[id as ControlId] = clampPlacement({ x: p.x, y: p.y, size: p.size, opacity: isFiniteNumber(p.opacity) ? p.opacity : 1 });
    }
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
