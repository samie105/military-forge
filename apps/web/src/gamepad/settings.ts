/**
 * Controller settings (Settings → Controls → Controller): which button does what, the sticks'
 * dead zones and feel, the triggers' thresholds and the rumble. Saved with the other settings
 * (shell/store.ts `Settings.pad`, localStorage settings.v1); pure, so the shell and tests import it.
 *
 * Sticks aren't rebindable: the left one moves (push up to jet, down to crouch), the right one aims
 * (or the other way round with "Swap sticks"). Options / Menu always opens the menu.
 */
import { Btn } from '@military-forge/sim';
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
 * The default layout, the same positions on every pad (the standard mapping is positional), so a
 * DualSense, a DualShock 4 and an Xbox pad play alike; only the prompts' glyphs differ:
 *
 *   R2 / RT fire · L2 / LT aim (alt fire; zooms out while held on a gun that zooms)
 *   R1 / RB grenade (tap: quick throw · hold: aim the arc with the right stick, let go to throw)
 *   L1 / LB dash (the left stick picks the way; a quick flick dashes harder)
 *   ✕ / A jet (or push the left stick up) · L3 crouch (or pull the left stick down)
 *   □ / X reload · ○ / B swap weapon · △ / Y take a gun · R3 melee
 *   D-pad ↑ dual wield · ↓ shield · ← zoom · → next grenade
 *   Create / Share / View or the touchpad: scoreboard (hold) · Options / Menu: the menu
 */
export const PAD_ACTIONS: readonly PadActionDef[] = [
  { id: 'fire', label: 'Fire', bit: Btn.Fire, defaults: [B.R2] },
  { id: 'fire2', label: 'Aim / alt fire', bit: Btn.Fire2, defaults: [B.L2], hint: 'Held on a gun that zooms, it also pulls the view out' },
  { id: 'jet', label: 'Jet (hold)', bit: Btn.Jet, defaults: [B.South], hint: 'Pushing the move stick up jets too (unless you turn that off below)' },
  { id: 'dash', label: 'Dash', bit: Btn.Dash, defaults: [B.L1], hint: 'The move stick picks the way (8 ways); a quick flick dashes harder' },
  { id: 'grenade', label: 'Throw grenade', bit: Btn.Grenade, defaults: [B.R1], hint: 'Tap: quick throw · hold: aim the arc with the aim stick, let go to throw' },
  { id: 'reload', label: 'Reload', bit: Btn.Reload, defaults: [B.West] },
  { id: 'swap', label: 'Swap weapon', bit: Btn.Swap, defaults: [B.East] },
  { id: 'interact', label: 'Take a gun / use', bit: Btn.Interact, defaults: [B.North] },
  { id: 'melee', label: 'Melee', bit: Btn.Melee, defaults: [B.R3] },
  { id: 'down', label: 'Crouch / drop', bit: Btn.Down, defaults: [B.L3], hint: 'Or pull the move stick down' },
  { id: 'shield', label: 'Shield up / sling', bit: Btn.Shield, defaults: [B.Down] },
  { id: 'dual', label: 'Dual wield', bit: Btn.Dual, defaults: [B.Up] },
  { id: 'cycleGrenade', label: 'Next grenade', bit: Btn.CycleGrenade, defaults: [B.Right] },
  { id: 'zoom', label: 'Zoom', defaults: [B.Left], hint: 'Steps the view out on a gun that zooms, then back' },
  { id: 'scoreboard', label: 'Scoreboard (hold)', defaults: [B.Select, B.Extra] },
];

/** Two buttons per action at most (as for keys). */
export const MAX_PAD_BINDINGS = 2;
/** Options / Menu: always the menu (pause), never rebindable. */
export const RESERVED_BUTTONS: ReadonlySet<number> = new Set([B.Start]);

export type PadBindings = Readonly<Record<PadActionId, readonly number[]>>;

export type GlyphSetting = 'auto' | 'playstation' | 'xbox';

export interface PadSettings {
  /** read controllers at all (off: a pad plugged in for something else is ignored) */
  enabled: boolean;
  /** which buttons the prompts draw: the connected pad's (auto), or always PlayStation's or Xbox's */
  glyphs: GlyphSetting;
  bindings: PadBindings;
  /** how fast the aim turns to where the aim stick points, 0.3..2 (1 = the default; 2 = at once) */
  aimSpeed: number;
  /** the aim stick's response: 1 = linear, up to 3 (finer near the centre); sets the reticle's reach */
  aimCurve: number;
  /** push the aim stick up to aim down (flight-style) */
  invertY: boolean;
  /** move with the right stick and aim with the left */
  swapSticks: boolean;
  /** the touch controls' light aim assist (friction on a target, never a pull) */
  aimAssist: boolean;
  /** pushing the move stick up jets (off: only the jet button does) */
  stickJet: boolean;
  /** each stick's dead zone, a fraction of its throw: 0.05..0.5 */
  moveDeadzone: number;
  aimDeadzone: number;
  /** how far a trigger is pulled before it counts: 0.05..0.95 (R2 fire, L2 aim) */
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
  deadzone: [0.05, 0.5],
  threshold: [0.05, 0.95],
  vibrationStrength: [0, 1],
} as const;

export function defaultPadBindings(): PadBindings {
  return Object.fromEntries(PAD_ACTIONS.map((a) => [a.id, [...a.defaults]])) as Record<PadActionId, number[]>;
}

export const DEFAULT_PAD_SETTINGS: Readonly<PadSettings> = {
  enabled: true,
  glyphs: 'auto',
  bindings: defaultPadBindings(),
  aimSpeed: 1,
  aimCurve: 1.5,
  invertY: false,
  swapSticks: false,
  aimAssist: true,
  stickJet: true,
  moveDeadzone: 0.2,
  aimDeadzone: 0.15,
  fireThreshold: 0.3,
  aimThreshold: 0.3,
  vibration: true,
  vibrationStrength: 0.7,
};

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
  return {
    enabled: flag(r.enabled, d.enabled),
    glyphs: r.glyphs === 'playstation' || r.glyphs === 'xbox' || r.glyphs === 'auto' ? r.glyphs : d.glyphs,
    bindings: sanitizePadBindings(r.bindings),
    aimSpeed: num(r.aimSpeed, PAD_LIMITS.aimSpeed, d.aimSpeed),
    aimCurve: num(r.aimCurve, PAD_LIMITS.aimCurve, d.aimCurve),
    invertY: flag(r.invertY, d.invertY),
    swapSticks: flag(r.swapSticks, d.swapSticks),
    aimAssist: flag(r.aimAssist, d.aimAssist),
    stickJet: flag(r.stickJet, d.stickJet),
    moveDeadzone: num(r.moveDeadzone, PAD_LIMITS.deadzone, d.moveDeadzone),
    aimDeadzone: num(r.aimDeadzone, PAD_LIMITS.deadzone, d.aimDeadzone),
    fireThreshold: num(r.fireThreshold, PAD_LIMITS.threshold, d.fireThreshold),
    aimThreshold: num(r.aimThreshold, PAD_LIMITS.threshold, d.aimThreshold),
    vibration: flag(r.vibration, d.vibration),
    vibrationStrength: num(r.vibrationStrength, PAD_LIMITS.vibrationStrength, d.vibrationStrength),
  };
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
}

export function buttonMap(bindings: PadBindings): ButtonMap {
  const m: ButtonMap = { bits: new Array<number>(BUTTON_COUNT).fill(0), zoom: new Set(), scoreboard: new Set(), grenade: new Set(), dash: new Set(), fire2: new Set() };
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
