/**
 * Controls: every action a player can rebind (Settings → Controls), their defaults, and the
 * conversion to the InputSampler's bindings (input.ts). A binding is a KeyboardEvent.code
 * ('KeyA', 'Space', 'ShiftLeft', …) or a mouse button ('Mouse0' left … 'Mouse4' forward).
 * One key or button does one action; up to three per action. Escape always opens the menu.
 */
import { Btn } from '@military-forge/sim';
import type { KeyBindings } from '../input';

export type ActionId =
  | 'left'
  | 'right'
  | 'jet'
  | 'down'
  | 'dash'
  | 'fire'
  | 'fire2'
  | 'reload'
  | 'melee'
  | 'grenade'
  | 'cycleGrenade'
  | 'swap'
  | 'slot1'
  | 'slot2'
  | 'dual'
  | 'interact'
  | 'shield'
  | 'scoreboard'
  | 'netGraph';

export interface ActionDef {
  id: ActionId;
  label: string;
  group: 'Move' | 'Combat' | 'Weapons' | 'Interface';
  /** the sim's button bit */
  bit?: number;
  /** a weapon slot key (Input.weaponSelect) */
  slot?: number;
  /** handled by the page, not the sim */
  ui?: true;
  defaults: readonly string[];
  /** a line under the label */
  hint?: string;
}


export const ACTIONS: readonly ActionDef[] = [
  { id: 'left', label: 'Move left', group: 'Move', bit: Btn.Left, defaults: ['KeyA', 'ArrowLeft'] },
  { id: 'right', label: 'Move right', group: 'Move', bit: Btn.Right, defaults: ['KeyD', 'ArrowRight'] },
  { id: 'jet', label: 'Jetpack / up', group: 'Move', bit: Btn.Jet, defaults: ['KeyW', 'Space', 'ArrowUp'] },
  { id: 'down', label: 'Crouch / drop down', group: 'Move', bit: Btn.Down, defaults: ['KeyS', 'ArrowDown'] },
  { id: 'dash', label: 'Dash', group: 'Move', bit: Btn.Dash, defaults: ['ShiftLeft', 'ShiftRight'], hint: 'With a direction held: 8 ways, up (jet) and down included' },
  { id: 'fire', label: 'Fire', group: 'Combat', bit: Btn.Fire, defaults: ['Mouse0'] },
  { id: 'fire2', label: 'Alt fire / scope', group: 'Combat', bit: Btn.Fire2, defaults: ['Mouse2'] },
  { id: 'reload', label: 'Reload', group: 'Combat', bit: Btn.Reload, defaults: ['KeyR'] },
  { id: 'melee', label: 'Melee', group: 'Combat', bit: Btn.Melee, defaults: ['KeyV', 'Mouse3'] },
  { id: 'grenade', label: 'Throw grenade', group: 'Combat', bit: Btn.Grenade, defaults: ['KeyG'] },
  { id: 'cycleGrenade', label: 'Next grenade type', group: 'Combat', bit: Btn.CycleGrenade, defaults: ['KeyT', 'Mouse4'] },
  { id: 'swap', label: 'Swap weapon', group: 'Weapons', bit: Btn.Swap, defaults: ['KeyQ'] },
  { id: 'slot1', label: 'Weapon 1', group: 'Weapons', slot: 1, defaults: ['Digit1'] },
  { id: 'slot2', label: 'Weapon 2', group: 'Weapons', slot: 2, defaults: ['Digit2'] },
  { id: 'dual', label: 'Dual wield', group: 'Weapons', bit: Btn.Dual, defaults: ['KeyF'] },
  { id: 'interact', label: 'Pick up / use', group: 'Weapons', bit: Btn.Interact, defaults: ['KeyE'] },
  { id: 'shield', label: 'Shield: raise / sling', group: 'Weapons', bit: Btn.Shield, defaults: ['KeyX'] },
  { id: 'scoreboard', label: 'Scoreboard (hold)', group: 'Interface', ui: true, defaults: ['Tab'] },
  { id: 'netGraph', label: 'Net graph', group: 'Interface', ui: true, defaults: ['KeyN'] },
];

export const MAX_BINDINGS = 3;
/** never rebindable: always the menu */
export const RESERVED_CODES = new Set(['Escape']);

export type Bindings = Readonly<Record<ActionId, readonly string[]>>;

export function defaultBindings(): Bindings {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.defaults]])) as Record<ActionId, string[]>;
}

const CODE = /^(Mouse[0-4]|[A-Za-z0-9]{1,24})$/;

/** Saved bindings → valid ones: known actions only, valid codes, each code used once, defaults for missing actions. */
export function sanitizeBindings(raw: unknown): Bindings {
  const out = defaultBindings() as Record<ActionId, string[]>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const used = new Set<string>();
  const saved = raw as Record<string, unknown>;
  for (const a of ACTIONS) {
    const list = saved[a.id];
    if (!Array.isArray(list)) continue;
    out[a.id] = list.filter((c): c is string => typeof c === 'string' && CODE.test(c) && !RESERVED_CODES.has(c)).slice(0, MAX_BINDINGS);
  }
  // a code bound twice keeps its first action (in ACTIONS order)
  for (const a of ACTIONS) {
    out[a.id] = out[a.id].filter((c) => {
      if (used.has(c)) return false;
      used.add(c);
      return true;
    });
  }
  return out;
}

/**
 * Binds `code` to `action` (replacing its `index`-th binding, or adding one). A code does one
 * thing: it is taken off whatever action had it, which is returned so the UI can say so.
 */
export function rebind(bindings: Bindings, action: ActionId, code: string, index: number): { bindings: Bindings; took: ActionId | null } {
  if (RESERVED_CODES.has(code)) return { bindings, took: null };
  const next = { ...bindings } as Record<ActionId, string[]>;
  let took: ActionId | null = null;
  for (const a of ACTIONS) {
    if (a.id !== action && next[a.id].includes(code)) {
      next[a.id] = next[a.id].filter((c) => c !== code);
      took = a.id;
    }
  }
  const list = next[action].filter((c, i) => c !== code || i === index);
  if (index < list.length) list[index] = code;
  else if (!list.includes(code)) list.push(code);
  next[action] = list.slice(0, MAX_BINDINGS);
  return { bindings: next, took };
}

export function unbind(bindings: Bindings, action: ActionId, index: number): Bindings {
  return { ...bindings, [action]: bindings[action].filter((_, i) => i !== index) };
}

/** The InputSampler's view: key → bits, mouse button → bits, key → weapon slot. */
export function toKeyBindings(bindings: Bindings): KeyBindings {
  const keys: Record<string, number> = {};
  const mouse: Record<number, number> = {};
  const slots: Record<string, number> = {};
  for (const a of ACTIONS) {
    for (const code of bindings[a.id]) {
      const m = /^Mouse([0-4])$/.exec(code);
      if (a.slot) {
        if (!m) slots[code] = a.slot;
      } else if (a.bit) {
        if (m) mouse[Number(m[1])] = (mouse[Number(m[1])] ?? 0) | a.bit;
        else keys[code] = (keys[code] ?? 0) | a.bit;
      }
    }
  }
  return { keys, mouse, slots };
}

/** The keyboard codes of a page-level action (scoreboard, net graph). */
export function uiCodes(bindings: Bindings, action: 'scoreboard' | 'netGraph'): readonly string[] {
  return bindings[action].filter((c) => !c.startsWith('Mouse'));
}

const NAMED: Record<string, string> = {
  Mouse0: 'Left click',
  Mouse1: 'Wheel click',
  Mouse2: 'Right click',
  Mouse3: 'Mouse 4',
  Mouse4: 'Mouse 5',
  Space: 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ShiftLeft: 'Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Right Alt',
  MetaLeft: '⌘',
  MetaRight: 'Right ⌘',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/**
 * A short label for a code. `layout` (navigator.keyboard.getLayoutMap(), where the browser has it)
 * turns physical positions into what the player's keyboard prints: KeyQ is "A" on AZERTY.
 */
export function keyLabel(code: string, layout?: ReadonlyMap<string, string> | null): string {
  const fromLayout = layout?.get(code);
  if (fromLayout && fromLayout.trim()) return fromLayout.length === 1 ? fromLayout.toUpperCase() : fromLayout;
  if (NAMED[code]) return NAMED[code];
  const m = /^(?:Key|Digit|Numpad)(.+)$/.exec(code);
  return m ? (code.startsWith('Numpad') ? `Num ${m[1]}` : m[1]!) : code;
}
