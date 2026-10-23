/**
 * Controller settings (Settings → Controls → Controller): which button does what, the sticks'
 * dead zones and feel, the triggers' thresholds and the rumble. Saved with the other settings
 * (shell/store.ts `Settings.pad`, localStorage settings.v1); pure, so the shell and tests import it.
 *
 * Sticks aren't rebindable: the left one moves (push up to jet, down to crouch), the right one aims
 * (or the other way round with "Swap sticks"). Options / Menu always opens the menu.
 */
import { Btn } from '@military-forge/sim';
import { isAssistLevel, type AssistLevel } from '../input/assist';
import { B, BUTTON_COUNT } from './standard';

export type PadActionId =
  | 'jet'
  | 'down'
  | 'dash'
  | 'fire'
  | 'fire2'
  | 'grenade'
  | 'reload'
  | 'swap'
  | 'interact'
  | 'melee'
  | 'shield'
  | 'cycleGrenade'
  | 'dual'
  | 'zoom'
  | 'talk'
  | 'scoreboard';

export interface PadActionDef {
  id: PadActionId;
  label: string;
  /** the sim's button bit (zoom and the scoreboard are the page's) */
  bit?: number;
  defaults: readonly number[];
  hint?: string;
}

/**
 * The actions and their labels. Which buttons do them comes from a layout preset (PAD_PRESETS, below)
 * or the player's own remap. Positions are the standard mapping's, the same on every pad, so a
 * DualSense, a DualShock 4 and an Xbox pad play alike; only the prompts' glyphs differ.
 */
export const PAD_ACTIONS: readonly PadActionDef[] = [
  { id: 'fire', label: 'Fire', bit: Btn.Fire, defaults: [B.R2] },
  { id: 'jet', label: 'Jet (hold)', bit: Btn.Jet, defaults: [B.L2, B.South], hint: 'Pushing the move stick steeply up jets too (unless you turn that off below)' },
  { id: 'dash', label: 'Dash', bit: Btn.Dash, defaults: [B.L1], hint: 'The move stick picks the way (8 ways); a quick flick dashes harder' },
  { id: 'grenade', label: 'Throw grenade', bit: Btn.Grenade, defaults: [B.R1], hint: 'Tap: quick throw · hold: aim the arc with the aim stick, let go to throw' },
  { id: 'fire2', label: 'Spin-up / alt fire', bit: Btn.Fire2, defaults: [B.R3], hint: 'Held on a gun that zooms, it also pulls the view out' },
  { id: 'melee', label: 'Melee', bit: Btn.Melee, defaults: [B.East] },
  { id: 'reload', label: 'Reload', bit: Btn.Reload, defaults: [B.West] },
  { id: 'swap', label: 'Swap weapon', bit: Btn.Swap, defaults: [B.North] },
  { id: 'interact', label: 'Take a gun / use', bit: Btn.Interact, defaults: [], hint: 'With "Hold reload to take" on, holding reload takes the gun underfoot' },
  { id: 'down', label: 'Crouch / drop', bit: Btn.Down, defaults: [B.L3], hint: 'Or pull the move stick straight down' },
  { id: 'shield', label: 'Shield up / sling', bit: Btn.Shield, defaults: [B.Down] },
  { id: 'dual', label: 'Dual wield', bit: Btn.Dual, defaults: [B.Up] },
  { id: 'cycleGrenade', label: 'Next grenade', bit: Btn.CycleGrenade, defaults: [B.Right] },
  { id: 'zoom', label: 'Zoom', defaults: [B.Left], hint: 'Steps the view out on a gun that zooms, then back' },
  // voice chat: before the scoreboard, so an older save's touchpad (the scoreboard's second) goes to it
  { id: 'talk', label: 'Push to talk (hold)', defaults: [B.Extra], hint: 'The touchpad on PlayStation pads; on others, pick a button' },
  { id: 'scoreboard', label: 'Scoreboard (hold)', defaults: [B.Select] },
];

/** Two buttons per action at most (as for keys). */
export const MAX_PAD_BINDINGS = 2;
/** Options / Menu: always the menu (pause), never rebindable. */
export const RESERVED_BUTTONS: ReadonlySet<number> = new Set([B.Start]);

export type PadBindings = Readonly<Record<PadActionId, readonly number[]>>;

export type GlyphSetting = 'auto' | 'playstation' | 'xbox' | 'nintendo';

/** Saved pad settings carry this; older saves are migrated once (sanitizePadSettings). */
export const PAD_REV = 2;

export interface PadSettings {
  /** the save's revision (PAD_REV) */
  rev: number;
  /** read controllers at all (off: a pad plugged in for something else is ignored) */
  enabled: boolean;
  /** Compact physical controller diagram over the map. */
  showLayout: boolean;
  /** which buttons the prompts draw: the connected pad's (auto), or always PlayStation's or Xbox's */
  glyphs: GlyphSetting;
  bindings: PadBindings;
  /**
   * Holding a reload button for HOLD_TAKE_MS takes the gun underfoot (Standard: X is reload, held
   * it's take, so Y can swap). A tap still reloads at once.
   */
  holdTake: boolean;
  /** how fast the aim turns to where the aim stick points, 0.3..2 (1 = the default; 2 = at once) */
  aimSpeed: number;
  /** the aim stick's response: 1 = linear, up to 3 (finer near the centre); sets the reticle's reach */
  aimCurve: number;
  /** push the aim stick up to aim down (flight-style) */
  invertY: boolean;
  /** move with the right stick and aim with the left */
  swapSticks: boolean;
  /**
   * Aim assist (input/assist.ts; spec §5.4): off, light (friction on a target), standard (+ a gentle
   * pull while the aim stick is pushed), strong (+ the aim holds the target with the stick let go)
   */
  assist: AssistLevel;
  /** pushing the move stick steeply up jets (off: only the jet buttons do) */
  stickJet: boolean;
  /**
   * The aim follows the nearest enemy in sight and in the gun's range, otherwise the way you move;
   * the aim stick still takes over while pushed (One-stick, spec §5.6).
   */
  autoAim: boolean;
  /** The gun fires by itself while the aim lies on an enemy in range (after 100 ms; One-stick). */
  autoFire: boolean;
  /** each stick's inner dead zone, a fraction of its throw: 0.05..0.35 (spec §5.1: 0.15) */
  moveDeadzone: number;
  aimDeadzone: number;
  /**
   * How far a trigger is pulled before it counts, 0.05..0.95: the right trigger (`fireThreshold`) and
   * the left (`aimThreshold`; it jets in Standard). Each lets go TRIGGER_RELEASE under it.
   */
  fireThreshold: number;
  aimThreshold: number;
  /** rumble (firing, hits, blasts nearby, dashes); "Reduce flashes" turns it off as well */
  vibration: boolean;
  /** 0..1 */
  vibrationStrength: number;
}

export const PAD_LIMITS = {
  aimSpeed: [0.3, 2],
  aimCurve: [1, 3],
  deadzone: [0.05, 0.35],
  threshold: [0.05, 0.95],
  vibrationStrength: [0, 1],
} as const;

export function defaultPadBindings(): PadBindings {
  return Object.fromEntries(PAD_ACTIONS.map((a) => [a.id, [...a.defaults]])) as Record<PadActionId, number[]>;
}

/** How long a reload button is held before it takes the gun underfoot (ms; spec §5.6). */
export const HOLD_TAKE_MS = 300;

export const DEFAULT_PAD_SETTINGS: Readonly<PadSettings> = {
  rev: PAD_REV,
  enabled: true,
  showLayout: true,
  glyphs: 'auto',
  bindings: defaultPadBindings(),
  holdTake: true,
  aimSpeed: 1,
  aimCurve: 1.5,
  invertY: false,
  swapSticks: false,
  assist: 'standard',
  stickJet: true,
  autoAim: false,
  autoFire: false,
  moveDeadzone: 0.15,
  aimDeadzone: 0.15,
  fireThreshold: 0.3,
  aimThreshold: 0.3,
  vibration: true,
  vibrationStrength: 0.7,
};

// ------------------------------------------------------------------ layout presets (spec §5.6)

export type PadPresetId = 'standard' | 'classic' | 'bumperJet' | 'southpaw' | 'oneStick';
/** A preset, or "custom": the player's own remap (or a preset with its flags changed). */
export type PadLayoutId = PadPresetId | 'custom';

/** What a preset sets: the buttons, and the settings that go with them. */
export interface PadPreset {
  id: PadPresetId;
  name: string;
  blurb: string;
  bindings: PadBindings;
  holdTake: boolean;
  stickJet: boolean;
  swapSticks: boolean;
  autoAim: boolean;
  autoFire: boolean;
  /** the aim assist it brings (One-stick: Strong); the others leave the player's level alone */
  assist?: AssistLevel;
}

const B_ = (map: Partial<Record<PadActionId, readonly number[]>>): PadBindings => ({ ...defaultPadBindings(), ...map });
const flags = { holdTake: true, stickJet: true, swapSticks: false, autoAim: false, autoFire: false };

/**
 * The layouts (spec §5.6; Xbox names, PlayStation's positions are the same):
 * - **Standard** (the default): everything used mid-fight is on the shoulders, so the right thumb
 *   never leaves the aim stick: LT jet (A too), RT fire, LB dash, RB grenade; B melee, X reload
 *   (hold: take), Y swap, L3 crouch, R3 spin-up.
 * - **Classic:** the first controller layout (A jet, LT alt fire, B swap, Y take, R3 melee).
 * - **Bumper Jet:** LB jets and LT dashes; the stick never jets (no accidental take-offs at all).
 * - **Southpaw:** Standard with the sticks swapped and the triggers and bumpers swapped.
 * - **One-stick** (accessibility): move with the left stick; the aim finds the nearest enemy in sight
 *   (else the way you move) and the gun fires by itself; Strong assist; the right stick can still aim.
 */
export const PAD_PRESETS: Readonly<Record<PadPresetId, PadPreset>> = {
  standard: {
    id: 'standard',
    name: 'Standard',
    blurb: 'Jet, fire, dash and grenade on the shoulders: your thumbs stay on the sticks.',
    bindings: defaultPadBindings(),
    ...flags,
  },
  classic: {
    id: 'classic',
    name: 'Classic',
    blurb: 'The first layout: A jets, LT is alt fire, B swaps, Y takes, R3 melees.',
    bindings: B_({ jet: [B.South], fire2: [B.L2], melee: [B.R3], swap: [B.East], interact: [B.North] }),
    ...flags,
    holdTake: false,
  },
  bumperJet: {
    id: 'bumperJet',
    name: 'Bumper Jet',
    blurb: 'LB jets, LT dashes, and the move stick never jets: no take-offs you didn’t mean.',
    bindings: B_({ jet: [B.L1, B.South], dash: [B.L2] }),
    ...flags,
    stickJet: false,
  },
  southpaw: {
    id: 'southpaw',
    name: 'Southpaw',
    blurb: 'Standard for the other hand: move on the right stick, aim on the left, triggers and bumpers swapped.',
    bindings: B_({ fire: [B.L2], jet: [B.R2, B.South], dash: [B.R1], grenade: [B.L1] }),
    ...flags,
    swapSticks: true,
  },
  oneStick: {
    id: 'oneStick',
    name: 'One-stick',
    blurb: 'Move with one stick: the aim finds the nearest enemy and fires for you. The right stick can still aim.',
    bindings: B_({ swap: [B.East], melee: [B.North] }),
    ...flags,
    autoAim: true,
    autoFire: true,
    assist: 'strong',
  },
};

export const PAD_PRESET_ORDER: readonly PadPresetId[] = ['standard', 'classic', 'bumperJet', 'southpaw', 'oneStick'];

const sameBindings = (a: PadBindings, b: PadBindings) => PAD_ACTIONS.every((x) => a[x.id].length === b[x.id].length && a[x.id].every((v, i) => v === b[x.id][i]));

/** The settings a preset decides (assist aside: the player's level stays theirs within a layout). */
type PresetFields = Pick<PadSettings, 'bindings' | 'holdTake' | 'stickJet' | 'swapSticks' | 'autoAim' | 'autoFire'>;

/** Which preset these settings are (its buttons and its flags), or "custom". */
export function padLayoutOf(s: PresetFields): PadLayoutId {
  for (const id of PAD_PRESET_ORDER) {
    const p = PAD_PRESETS[id];
    if (p.holdTake === s.holdTake && p.stickJet === s.stickJet && p.swapSticks === s.swapSticks && p.autoAim === s.autoAim && p.autoFire === s.autoFire && sameBindings(p.bindings, s.bindings)) return id;
  }
  return 'custom';
}

/**
 * These settings with a preset's buttons and flags (the feel settings stay the player's). One-stick
 * brings Strong assist; leaving it for another layout puts Standard back.
 */
export function applyPadPreset(s: PadSettings, id: PadPresetId): PadSettings {
  const p = PAD_PRESETS[id];
  const assist = p.assist ?? (padLayoutOf(s) === 'oneStick' && s.assist === 'strong' ? 'standard' : s.assist);
  return { ...s, bindings: p.bindings, holdTake: p.holdTake, stickJet: p.stickJet, swapSticks: p.swapSticks, autoAim: p.autoAim, autoFire: p.autoFire, assist };
}

const validButton = (b: unknown): b is number => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b < BUTTON_COUNT && !RESERVED_BUTTONS.has(b);

/** Saved bindings → valid ones: known actions, valid buttons, each button used once (first action wins). */
export function sanitizePadBindings(raw: unknown): PadBindings {
  const out = defaultPadBindings() as Record<PadActionId, number[]>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const saved = raw as Record<string, unknown>;
  for (const a of PAD_ACTIONS) {
    const list = saved[a.id];
    if (Array.isArray(list)) out[a.id] = list.filter(validButton).slice(0, MAX_PAD_BINDINGS);
  }
  const used = new Set<number>();
  for (const a of PAD_ACTIONS) {
    out[a.id] = out[a.id].filter((b) => {
      if (used.has(b)) return false;
      used.add(b);
      return true;
    });
  }
  return out;
}

const num = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

export function sanitizePadSettings(raw: unknown): PadSettings {
  const d = DEFAULT_PAD_SETTINGS;
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof PadSettings, unknown>>;
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const out: PadSettings = {
    rev: PAD_REV,
    enabled: flag(r.enabled, d.enabled),
    showLayout: flag(r.showLayout, d.showLayout),
    glyphs: r.glyphs === 'playstation' || r.glyphs === 'xbox' || r.glyphs === 'nintendo' || r.glyphs === 'auto' ? r.glyphs : d.glyphs,
    bindings: sanitizePadBindings(r.bindings),
    holdTake: flag(r.holdTake, d.holdTake),
    aimSpeed: num(r.aimSpeed, PAD_LIMITS.aimSpeed, d.aimSpeed),
    aimCurve: num(r.aimCurve, PAD_LIMITS.aimCurve, d.aimCurve),
    invertY: flag(r.invertY, d.invertY),
    swapSticks: flag(r.swapSticks, d.swapSticks),
    // before the levels it was a switch (`aimAssist`): on became Standard, off stays off
    assist: isAssistLevel(r.assist) ? r.assist : (r as { aimAssist?: unknown }).aimAssist === false ? 'off' : d.assist,
    stickJet: flag(r.stickJet, d.stickJet),
    autoAim: flag(r.autoAim, d.autoAim),
    autoFire: flag(r.autoFire, d.autoFire),
    moveDeadzone: num(r.moveDeadzone, PAD_LIMITS.deadzone, d.moveDeadzone),
    aimDeadzone: num(r.aimDeadzone, PAD_LIMITS.deadzone, d.aimDeadzone),
    fireThreshold: num(r.fireThreshold, PAD_LIMITS.threshold, d.fireThreshold),
    aimThreshold: num(r.aimThreshold, PAD_LIMITS.threshold, d.aimThreshold),
    vibration: flag(r.vibration, d.vibration),
    vibrationStrength: num(r.vibrationStrength, PAD_LIMITS.vibrationStrength, d.vibrationStrength),
  };
  if (typeof raw === 'object' && raw !== null && !(typeof r.rev === 'number' && r.rev >= PAD_REV)) migrateRev1(out, r);
  return out;
}

/**
 * A save from before the layout presets (rev 1). Settings are saved whole whenever anything changes,
 * so its pad values were mostly the old defaults, never chosen: those become Standard (and the old
 * 0.20 move dead zone the new 0.15). Buttons the player really remapped stay theirs ("Custom").
 */
function migrateRev1(out: PadSettings, raw: Partial<Record<keyof PadSettings, unknown>>): void {
  const savedButtons = raw.bindings === undefined ? PAD_PRESETS.classic.bindings : out.bindings;
  if (sameBindings(savedButtons, PAD_PRESETS.classic.bindings)) {
    out.bindings = PAD_PRESETS.standard.bindings;
    out.holdTake = PAD_PRESETS.standard.holdTake;
  } else out.holdTake = false;
  if (raw.moveDeadzone === undefined || raw.moveDeadzone === 0.2) out.moveDeadzone = DEFAULT_PAD_SETTINGS.moveDeadzone;
}

/**
 * Binds `button` to `action` (its `index`-th binding, or added). A button does one thing: it leaves
 * whatever action had it, which is returned so the UI can say so. Options / Menu can't be bound.
 */
export function rebindPad(bindings: PadBindings, action: PadActionId, button: number, index: number): { bindings: PadBindings; took: PadActionId | null } {
  if (!validButton(button)) return { bindings, took: null };
  const next = { ...bindings } as Record<PadActionId, number[]>;
  let took: PadActionId | null = null;
  for (const a of PAD_ACTIONS) {
    if (a.id !== action && next[a.id].includes(button)) {
      next[a.id] = next[a.id].filter((b) => b !== button);
      took = a.id;
    }
  }
  const list = next[action].filter((b, i) => b !== button || i === index);
  if (index < list.length) list[index] = button;
  else if (!list.includes(button)) list.push(button);
  next[action] = list.slice(0, MAX_PAD_BINDINGS);
  return { bindings: next, took };
}

export function unbindPad(bindings: PadBindings, action: PadActionId, index: number): PadBindings {
  return { ...bindings, [action]: bindings[action].filter((_, i) => i !== index) };
}

/** button index → the sim bits it holds (and the page actions: zoom, scoreboard) */
export interface ButtonMap {
  bits: number[];
  zoom: Set<number>;
  scoreboard: Set<number>;
  grenade: Set<number>;
  dash: Set<number>;
  fire2: Set<number>;
  /** reload buttons that take the gun underfoot when held (PadSettings.holdTake) */
  holdTake: Set<number>;
}

export function buttonMap(bindings: PadBindings, holdTake = false): ButtonMap {
  const m: ButtonMap = { bits: new Array<number>(BUTTON_COUNT).fill(0), zoom: new Set(), scoreboard: new Set(), grenade: new Set(), dash: new Set(), fire2: new Set(), holdTake: new Set(holdTake ? bindings.reload : []) };
  for (const a of PAD_ACTIONS) {
    for (const b of bindings[a.id]) {
      if (a.bit) m.bits[b] = (m.bits[b] ?? 0) | a.bit;
      if (a.id === 'zoom') m.zoom.add(b);
      if (a.id === 'scoreboard') m.scoreboard.add(b);
      if (a.id === 'grenade') m.grenade.add(b);
      if (a.id === 'dash') m.dash.add(b);
      if (a.id === 'fire2') m.fire2.add(b);
    }
  }
  return m;
}
