/**
 * The touch HUD's controls, their default places, and what the player changed (pure, unit-tested).
 * Placements are fractions of the safe-area box (x from the left, y from the top; size of its
 * shorter side), stored for the right-handed layout; the left-handed one mirrors them.
 */
import { Btn } from '@military-forge/sim';
import { LAYOUT_KEY, LIMITS, clamp, type Handed, type KeyValueStore } from './settings';

export type ControlId = 'move' | 'aim' | 'grenade' | 'cycleGrenade' | 'dash' | 'melee' | 'reload' | 'swap' | 'zoom' | 'shield' | 'take' | 'pause' | 'scores';

export interface ControlDef {
  id: ControlId;
  /** stick: a floating thumb-stick zone; drag: a button that is also a small stick; tap: a button */
  kind: 'stick' | 'drag' | 'tap';
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
  { id: 'move', kind: 'stick', label: '', bit: 0, title: 'Move: push up to jet, down to crouch; swipe and lift to dash' },
  { id: 'aim', kind: 'stick', label: '', bit: 0, title: 'Aim (and fire)' },
  { id: 'grenade', kind: 'drag', label: 'G', bit: Btn.Grenade, title: 'Grenade: tap to throw; hold to aim the arc (with the right stick or a drag), release to throw' },
  { id: 'cycleGrenade', kind: 'tap', label: 'G↻', bit: Btn.CycleGrenade, title: 'Next grenade type' },
  { id: 'dash', kind: 'tap', label: 'DASH', bit: Btn.Dash, title: 'Dash the way the move stick points (left alone: the way you face)' },
  { id: 'melee', kind: 'tap', label: 'MELEE', bit: Btn.Melee, title: 'Melee' },
  { id: 'reload', kind: 'tap', label: 'R', bit: Btn.Reload, title: 'Reload' },
  { id: 'swap', kind: 'tap', label: '⇄', bit: Btn.Swap, title: 'Swap weapon' },
  { id: 'zoom', kind: 'tap', label: '⌕', bit: 0, title: 'Zoom (scoped weapons)' },
  { id: 'shield', kind: 'tap', label: '⛨', bit: SHIELD_BIT, title: 'Raise or sling the shield' },
  { id: 'take', kind: 'tap', label: 'E', bit: Btn.Interact, title: 'Take the weapon you stand on (it swaps the gun in hand)' },
  { id: 'pause', kind: 'tap', label: '❚❚', bit: 0, key: 'Escape', title: 'Menu' },
  { id: 'scores', kind: 'tap', label: '☰', bit: 0, key: 'Tab', title: 'Scoreboard (hold)' },
];

export const CONTROL_IDS: readonly ControlId[] = CONTROLS.map((c) => c.id);

/** Controls the current sim supports (the shield waits for its button bit). */
export function availableControls(): readonly ControlDef[] {
  return CONTROLS.filter((c) => c.id !== 'shield' || SHIELD_BIT !== 0);
}

/**
 * Right-handed defaults: the owner's design kit's phone HUD (docs/design/military-forge-ui.html,
 * "14 · Phone HUD", 812×375 with 44 px side margins): 132 px sticks in the bottom corners; the
 * action buttons in an arc around the aim stick (its centre 80 px in from the right edge, 84 px up
 * from the bottom): grenade, dash, reload and swap 106 px out at 180°, 145°, 110° and 75°, then
 * next grenade, melee and shield 172 px out at 165°, 132° and 100°; the menu top right. Zoom (68°)
 * and the scoreboard (top, between the match and ammo plates) aren't in the kit and sit where they
 * clear it. A player's saved places (TouchLayout) still win over these.
 */
export const DEFAULT_PLACEMENTS: Readonly<Record<ControlId, Placement>> = {
  move: { x: 0.153, y: 0.72, size: 0.352, opacity: 1 },
  aim: { x: 0.847, y: 0.72, size: 0.352, opacity: 1 },
  grenade: { x: 0.717, y: 0.72, size: 0.155, opacity: 1 },
  dash: { x: 0.74, y: 0.558, size: 0.155, opacity: 1 },
  reload: { x: 0.803, y: 0.454, size: 0.155, opacity: 1 },
  swap: { x: 0.881, y: 0.447, size: 0.155, opacity: 1 },
  cycleGrenade: { x: 0.643, y: 0.601, size: 0.128, opacity: 1 },
  melee: { x: 0.706, y: 0.379, size: 0.128, opacity: 1 },
  shield: { x: 0.811, y: 0.268, size: 0.128, opacity: 1 },
  zoom: { x: 0.925, y: 0.305, size: 0.128, opacity: 1 },
  pause: { x: 0.916, y: 0.091, size: 0.128, opacity: 1 },
  scores: { x: 0.639, y: 0.091, size: 0.128, opacity: 1 },
  take: { x: 0.62, y: 0.4, size: 0.128, opacity: 1 },
};


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
