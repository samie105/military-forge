/**
 * The touch HUD's controls, their default places, and what the player changed (pure, unit-tested).
 * Placements are fractions of the safe-area box (x from the left, y from the top; size of its
 * shorter side), stored for the right-handed layout; the left-handed one mirrors them.
 */
import { Btn } from '@military-forge/sim';
import { LAYOUT_KEY, LIMITS, clamp, type Handed, type KeyValueStore, type PresetId } from './settings';

export { PRESET_HELP, PRESET_IDS, PRESET_NAMES, PRESET_SETTINGS, type PresetId } from './settings';

export type ControlId = 'move' | 'aim' | 'grenade' | 'cycleGrenade' | 'dash' | 'melee' | 'reload' | 'swap' | 'zoom' | 'shield' | 'take' | 'pause' | 'scores' | 'fire' | 'fireLeft' | 'jet';

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
  { id: 'move', kind: 'stick', label: 'Move', bit: 0, title: 'Move: push up to fly, down to crouch; swipe and lift to dash' },
  { id: 'aim', kind: 'stick', label: 'Aim and fire', bit: 0, title: 'Aim (and fire)' },
  { id: 'grenade', kind: 'drag', label: 'Grenade', bit: Btn.Grenade, title: 'Grenade: tap to throw; swipe up or down to change the type; hold and drag to aim the arc, release to throw' },
  { id: 'cycleGrenade', kind: 'tap', label: 'Next grenade', bit: Btn.CycleGrenade, title: 'Next grenade type' },
  { id: 'dash', kind: 'tap', label: 'Dash', bit: Btn.Dash, title: 'Dash: swipe it any way to dash that way; a tap dashes the way the move stick points (or the way you face)' },
  { id: 'melee', kind: 'tap', label: 'Melee', bit: Btn.Melee, title: 'Melee' },
  { id: 'reload', kind: 'tap', label: 'Reload', bit: Btn.Reload, title: 'Reload (tap, or swipe down)' },
  { id: 'swap', kind: 'tap', label: 'Swap guns', bit: Btn.Swap, title: 'Swap guns: tap or swipe; hold for quick-select: both guns and melee' },
  { id: 'zoom', kind: 'tap', label: 'Zoom', bit: 0, title: 'Zoom (scoped weapons)' },
  { id: 'shield', kind: 'tap', label: 'Shield', bit: SHIELD_BIT, title: 'Shield: tap to raise or sling; hold to keep it up while held' },
  { id: 'take', kind: 'tap', label: 'Take a gun', bit: Btn.Interact, title: 'Take the weapon you stand on (it swaps the gun in hand)' },
  { id: 'pause', kind: 'tap', label: 'Menu', bit: 0, key: 'Escape', title: 'Menu' },
  { id: 'scores', kind: 'tap', label: 'Scores', bit: 0, key: 'Tab', title: 'Scoreboard (hold)' },
  // Fire button mode only (settings.fire 'button', §4.4): FIRE fires while held; drag it to aim while firing
  { id: 'fire', kind: 'tap', label: 'Fire', bit: Btn.Fire, title: 'Fire: hold to shoot; drag it to aim while you shoot' },
  { id: 'fireLeft', kind: 'tap', label: 'Fire (left)', bit: Btn.Fire, title: 'Fire, for the left index finger: hold to shoot' },
  // Claw's (§4.2): the left index finger jets, so the move stick needn't
  { id: 'jet', kind: 'tap', label: 'Jet', bit: Btn.Jet, title: 'Jet: hold to fly' },
];

export const CONTROL_IDS: readonly ControlId[] = CONTROLS.map((c) => c.id);

/** Controls the current sim supports (the shield waits for its button bit). */
export function availableControls(): readonly ControlDef[] {
  return CONTROLS.filter((c) => c.id !== 'shield' || SHIELD_BIT !== 0);
}

/** No touch target smaller than this (CSS px), whatever the layout says (the kit's --touch-min). */
export const MIN_TARGET_PX = 48;

/** CSS px per mm on a phone (controls spec §0: an iPhone is 6.0, a Pixel 7 6.2): the layout's anchors are in mm. */
export const PX_PER_MM = 6;

/** A safe-box corner, and how far in from its side (dx) and up or down from its edge (dy) a control's centre is, in mm; its hit size (mm). */
export interface Anchor {
  /** TC: the top centre (dx from the middle, + to the right; dy down) */
  corner: 'BL' | 'BR' | 'TL' | 'TR' | 'TC';
  dx: number;
  dy: number;
  hit: number;
}

/**
 * The Classic layout (controls spec §4.2; the owner's essentials, 23 Oct): every control anchored to a
 * corner of the safe box in mm, so thumbs reach the same places on a 667 px phone and a 932 px one.
 * Two sticks (the left moves and jets, the right aims and fires: Auto, no FIRE button) and four
 * buttons in an arc 42 mm from the bottom-right corner: grenade, JET, the swap pill, reload. The
 * context slot, left of the arc, shows Take, melee, the shield or zoom when one is in play (one at a
 * time). DASH sits by the left thumb (25 Oct; a flick of the move stick dashes too); next grenade (a
 * swipe on the grenade) is off the HUD. The editor can pin it back (TouchLayout.pinned): pinned, a control has its own place
 * (PINNED_ANCHORS). Primaries are 12 mm, secondaries 10, the top bar 8; the sticks' bases 22 mm.
 */
export const CLASSIC: Readonly<Record<ControlId, Anchor>> = {
  move: { corner: 'BL', dx: 16, dy: 15, hit: 22 },
  aim: { corner: 'BR', dx: 16, dy: 15, hit: 22 },
  // the essentials (the owner, 23 Oct: "one obvious way", nothing extra): JET, grenade, swap and reload
  // in the arc; the right stick aims and fires (Auto), no FIRE button
  grenade: { corner: 'BR', dx: 41.1, dy: 8.7, hit: 12 },
  jet: { corner: 'BR', dx: 35.2, dy: 22.9, hit: 12 },
  swap: { corner: 'BR', dx: 24.7, dy: 34, hit: 10 },
  reload: { corner: 'BR', dx: 10.9, dy: 40.6, hit: 10 },
  // the context slot, above the arc: whichever of these is in play (one at a time). High enough that
  // Take's pill (a gun's name: ~200 px) clears JET and the swap button, low enough to clear the clock
  take: { corner: 'BR', dx: 40, dy: 44, hit: 10 },
  melee: { corner: 'BR', dx: 40, dy: 44, hit: 10 },
  shield: { corner: 'BR', dx: 40, dy: 44, hit: 10 },
  zoom: { corner: 'BR', dx: 40, dy: 44, hit: 10 },
  // DASH by the left thumb (the owner, 25 Oct: "I can't dash easily"): the right arc has no room left on
  // its 42 mm ring, and the right thumb is the one aiming. Low, right of the move stick, 5 mm clear of
  // its dial: the left thumb hops to it (a tap dashes the way the stick was going, a swipe picks the way)
  dash: { corner: 'BL', dx: 37, dy: 9, hit: 12 },
  // off the HUD unless pinned (a swipe on the grenade changes type)
  cycleGrenade: { corner: 'BR', dx: 58, dy: 22, hit: 10 },
  scores: { corner: 'TL', dx: 4, dy: 4, hit: 8 },
  pause: { corner: 'TR', dx: 4, dy: 4, hit: 8 },
  // FIRE (Fire button mode) at the aim stick's rest, 14 mm; the left one for the left index finger
  fire: { corner: 'BR', dx: 16, dy: 15, hit: 14 },
  fireLeft: { corner: 'TL', dx: 20, dy: 14, hit: 12 },
};

/**
 * The layouts a player picks from (controls spec §4.2; the editor's first row, Settings → Touch):
 * - classic: two thumbs (the default; CLASSIC above);
 * - claw: three or four fingers. The index fingers work the top corners: JET and DASH on the left,
 *   FIRE and GRENADE on the right; thumbs only move and aim. The arc keeps the swap pill and the
 *   context slot; menu and scores move to the top centre. Fire button mode, stick-up jet off, and
 *   any extra finger on the aim side fires (PRESET_SETTINGS);
 * - oneThumb (One-thumb assist, accessibility): the move stick, and three 15 mm buttons for the right
 *   thumb (dash, grenade, swap; the context slot beside them). The aim is automatic (the nearest
 *   enemy in sight and range, else the way you move) and so is fire (Auto); a drag on empty right-side
 *   space takes the aim over while it lasts.
 * The preset is a setting (TouchSettings.preset, with what it implies: PRESET_SETTINGS); the layout's
 * placements are the player's moves on top of it ("My layout"), dropped when another preset is picked.
 */
const CONTEXT_AT = (a: Omit<Anchor, 'corner'> & { corner?: Anchor['corner'] }): Partial<Record<ControlId, Anchor>> => {
  const at: Anchor = { corner: 'BR', ...a };
  return { take: at, melee: at, shield: at, reload: at, zoom: at };
};

export const PRESETS: Readonly<Record<PresetId, Readonly<Record<ControlId, Anchor>>>> = {
  classic: CLASSIC,
  claw: {
    ...CLASSIC,
    jet: { corner: 'TL', dx: 20, dy: 14, hit: 12 },
    // the spec's 42, 12 leaves DASH and GRENADE 0.5 mm apart on a 667 px phone, and DASH under the
    // scores button there: 40 in and 18 down keeps every gap ≥ 2 mm on all five phones
    dash: { corner: 'TL', dx: 40, dy: 18, hit: 12 },
    fire: { corner: 'TR', dx: 20, dy: 14, hit: 12 },
    grenade: { corner: 'TR', dx: 40, dy: 18, hit: 12 },
    // the arc keeps the swap pill and the context slot, in the places dash and grenade leave: at the
    // spec's (swap 24.7, 34) the pill sits under FIRE on a 375 px tall phone
    swap: { corner: 'BR', dx: 35.2, dy: 22.9, hit: 10 },
    ...CONTEXT_AT({ dx: 41.1, dy: 8.7, hit: 10 }),
    // reload is the context slot's here (its Classic spot is under FIRE)
    reload: { corner: 'BR', dx: 41.1, dy: 8.7, hit: 10 },
    // one each side of the middle, 24 px (4 mm) apart
    scores: { corner: 'TC', dx: -6, dy: 4, hit: 8 },
    pause: { corner: 'TC', dx: 6, dy: 4, hit: 8 },
  },
  oneThumb: {
    ...CLASSIC,
    // JET only with "Push up to jet" off: top left, clear of the big buttons
    jet: { corner: 'TL', dx: 42, dy: 14, hit: 12 },
    dash: { corner: 'BR', dx: 16, dy: 14, hit: 15 },
    grenade: { corner: 'BR', dx: 34, dy: 14, hit: 15 },
    swap: { corner: 'BR', dx: 16, dy: 32, hit: 15 },
    // the spec leaves it out; Take, reload and the rest still need a place: beside swap, 12 mm
    ...CONTEXT_AT({ dx: 34, dy: 32, hit: 12 }),
  },
};


/** Where a control sits when the player pins it to the HUD (the editor): around the arc, clear of it. */
export const PINNED_ANCHORS: Readonly<Partial<Record<ControlId, Anchor>>> = {
  // a column left of the arc (clear of the move stick's rest on a 667 px phone), and zoom by swap
  dash: { corner: 'BR', dx: 58, dy: 9, hit: 12 },
  cycleGrenade: { corner: 'BR', dx: 58, dy: 22, hit: 10 },
  melee: { corner: 'BR', dx: 58, dy: 34, hit: 10 },
  shield: { corner: 'BR', dx: 58, dy: 46, hit: 10 },
  zoom: { corner: 'BR', dx: 26, dy: 48, hit: 10 },
  // Claw and One-thumb only (Classic's reload is always on its HUD)
  reload: { corner: 'BR', dx: 46, dy: 32, hit: 10 },
};
/**
 * Each preset's context slot, most urgent first: a gun underfoot, an enemy in reach, a shield carried,
 * (a low magazine,) a scope. Classic keeps reload on the HUD, so not in its slot.
 */
export const CONTEXT_BY_PRESET: Readonly<Record<PresetId, readonly ControlId[]>> = {
  classic: ['take', 'melee', 'shield', 'zoom'],
  claw: ['take', 'melee', 'shield', 'reload', 'zoom'],
  oneThumb: ['take', 'melee', 'shield', 'reload', 'zoom'],
};
/** Controls off a preset's HUD unless pinned. */
const PINNED_ONLY: Readonly<Record<PresetId, readonly ControlId[]>> = {
  classic: ['cycleGrenade'],
  claw: ['cycleGrenade'],
  oneThumb: ['cycleGrenade'],
};
/** A preset's controls that come and go: the context slot's and the pinned-only ones. */
export function offHud(preset: PresetId): ReadonlySet<ControlId> {
  return new Set([...PINNED_ONLY[preset], ...CONTEXT_BY_PRESET[preset]]);
}
/** Classic's (the default): kept for callers that don't know the preset. */
export const CONTEXT_PRIORITY: readonly ControlId[] = CONTEXT_BY_PRESET.classic;
export const OFF_HUD: ReadonlySet<ControlId> = offHud('classic');
/** The controls the editor can pin to the HUD. */
export const PINNABLE: readonly ControlId[] = ['dash', 'cycleGrenade', 'melee', 'reload', 'shield', 'zoom'];
/** Every control that can come and go in some preset (they start off the HUD). */
export const SOMETIMES: ReadonlySet<ControlId> = new Set([...offHud('classic'), ...offHud('claw'), ...offHud('oneThumb')]);

/** The reference safe box (the kit's 812×375 frame less its insets), for a placement asked for without one. */
export const REF_BOX = { w: 724, h: 344 } as const;

/** An anchor as a placement (fractions of a w×h box) for the right-handed layout. */
/**
 * The safe box's height (mm) the layout is drawn for: a shorter box (a phone with its browser's bars
 * showing, 780×304; a small Android) draws the whole layout smaller, places and sizes alike, so nothing
 * runs into the top bar and every gap keeps its share (the mobile audit, P1-10). 375 px tall and up: 1.
 */
export const LAYOUT_HEIGHT_MM = 57;

/** How much smaller the mm layout is drawn in a box `h` px tall (1: as designed). */
export function layoutScale(h: number): number {
  return Math.min(1, h / PX_PER_MM / LAYOUT_HEIGHT_MM);
}

export function anchorPlacement(a: Anchor, w: number, h: number): Placement {
  const mm = PX_PER_MM * layoutScale(h);
  const px = a.dx * mm;
  const py = a.dy * mm;
  // a control drawn smaller than MIN_TARGET_PX is shown at that size (sizePx): it stays whole inside
  // the box (the menu and scores buttons ran off its top on an iPhone with Safari's bars showing)
  const r = Math.max(MIN_TARGET_PX, a.hit * mm) / 2;
  const x = Math.min(w - r, Math.max(r, a.corner === 'TC' ? w / 2 + px : a.corner === 'BL' || a.corner === 'TL' ? px : w - px));
  const y = Math.min(h - r, Math.max(r, a.corner === 'TL' || a.corner === 'TR' || a.corner === 'TC' ? py : h - py));
  return { x: x / w, y: y / h, size: (a.hit * mm) / Math.min(w, h), opacity: 1 };
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


/** Controls that are wide pills (their size is the height; the width follows the content). */
export const PILLS: ReadonlySet<ControlId> = new Set([]);

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

/** "My layout": the preset with controls the player moved or resized (the editor forks it). */
export const isCustomLayout = (layout: TouchLayout): boolean => Object.keys(layout.placements).length > 0;

/** Another preset picked: its places from scratch (the player's moves dropped); the pins stay. */
export function withoutMoves(layout: TouchLayout): TouchLayout {
  return layout.pinned?.length ? { placements: {}, pinned: [...layout.pinned] } : { placements: {} };
}

/**
 * Where a control goes in a w×h safe box (px): the player's own place if it was moved, else its mm
 * anchor (its pinned one, if pinned); mirrored for the left-handed layout.
 */
export function placementFor(layout: TouchLayout, id: ControlId, handed: Handed, box: { w: number; h: number } = REF_BOX, preset: PresetId = 'classic'): Placement {
  // pinned: its own place, where it's otherwise off this preset's HUD (Classic's reload is always there)
  const pinned = layout.pinned?.includes(id) && offHud(preset).has(id) ? PINNED_ANCHORS[id] : undefined;
  const p = layout.placements[id] ?? anchorPlacement(pinned ?? PRESETS[preset][id], Math.max(1, box.w), Math.max(1, box.h));
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
