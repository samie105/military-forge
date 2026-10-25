/**
 * Explaining the touch controls (docs/design/touch-controls-v3.md §3), pure and unit-tested:
 *  - first-time hints: a chip beside a control the first time it can do something new, once each,
 *    remembered on the phone;
 *  - the "Learn the controls" drill: one goal at a time, ticked off when the player does it.
 * The controller reports what the player did as actions (TouchAction); both listen.
 */
import type { FireMode, TouchSettings } from './settings';
import type { ControlId } from './layout';
import type { KeyValueStore } from './settings';

export const HINTS_KEY = 'mf.touch.hints.v1';
export const DRILL_KEY = 'mf.touch.drill.v1';

/** What the player did, as the controller sees it. */
export type TouchAction =
  | 'move'
  | 'jet'
  | 'fire'
  | 'dash'
  | 'chain'
  | 'cycle'
  | 'throw'
  | 'aimed-throw'
  | 'swap'
  | 'radial'
  | 'reload'
  | 'melee'
  | 'shield'
  | 'take'
  | 'pinch'
  | 'recentre'
  | 'zoom'
  | 'scores';

// ---------------------------------------------------------------- hints

export interface Hint {
  id: string;
  control: ControlId;
  text: string;
  /** which way the chip sits from the control */
  side: 'left' | 'right' | 'above' | 'below';
}

export const HINTS: readonly Hint[] = [
  { id: 'dash-swipe', control: 'dash', text: 'Swipe to dash any way', side: 'left' },
  { id: 'grenade-types', control: 'grenade', text: 'Swipe ↑↓ to change grenade', side: 'left' },
  { id: 'swap-radial', control: 'swap', text: 'Hold for guns and melee', side: 'below' },
  { id: 'take', control: 'take', text: 'Tap to take it', side: 'above' },
  { id: 'shield-hold', control: 'shield', text: 'Hold to raise', side: 'left' },
];

/** What makes each hint possible, read from the frame. */
export interface HintState {
  alive: boolean;
  grenadeTypes: number;
  guns: number;
  nearCrate: boolean;
  shield: boolean;
}

/** Every hint possible now, in order (the onboarding's hint engine picks, tour/hints.ts). */
export function possibleHints(s: HintState): Hint[] {
  if (!s.alive) return [];
  const possible: Record<string, boolean> = {
    'dash-swipe': true,
    'grenade-types': s.grenadeTypes >= 2,
    'swap-radial': s.guns >= 2,
    take: s.nearCrate,
    'shield-hold': s.shield,
  };
  return HINTS.filter((h) => possible[h.id]);
}

/** The first hint that's possible now and not yet seen (null: none). */
export function nextHint(s: HintState, seen: ReadonlySet<string>): Hint | null {
  return possibleHints(s).find((h) => !seen.has(h.id)) ?? null;
}

/** The hint a player's action answers (it stops showing once they've done it). */
export const HINT_DONE_BY: Readonly<Record<string, TouchAction[]>> = {
  'dash-swipe': ['dash'],
  'grenade-types': ['cycle'],
  'swap-radial': ['radial'],
  take: ['take'],
  'shield-hold': ['shield'],
};

export function loadSeen(store: KeyValueStore | null): Set<string> {
  try {
    const v = JSON.parse(store?.getItem(HINTS_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveSeen(store: KeyValueStore | null, seen: ReadonlySet<string>): void {
  try {
    store?.setItem(HINTS_KEY, JSON.stringify([...seen]));
  } catch {
    /* private mode: they'll show again next time */
  }
}

// ---------------------------------------------------------------- the drill

export interface DrillStep {
  id: string;
  /** the goal, short */
  goal: string;
  /** how, one line */
  how: string;
  /** the control to point at */
  control: ControlId | null;
  /** the actions that tick it off */
  done: readonly TouchAction[];
  /** skipped by itself when this isn't possible (no shield carried, no gun that zooms) */
  needs?: 'shield' | 'zoom';
}

/** The drill's fire step says how the player's own fire mode fires (the owner: "the drill teaches whichever style is chosen"). */
export const FIRE_HOW: Readonly<Record<FireMode, string>> = {
  auto: 'Point the right dial at a target: you fire by yourself. Push it to the rim to fire anyway.',
  pull: 'Push the right dial past its ring.',
  button: 'Hold Fire. Drag it to aim while you shoot.',
  release: 'Drag the right dial to aim, then lift to fire.',
};

/** What the drill's words and pointer depend on: the fire mode, whether the stick jets, the layout. */
export type DrillContext = Pick<TouchSettings, 'fire' | 'stickJet' | 'preset'>;

/** The JET button is on the HUD: Classic and Claw, or any layout whose stick doesn't jet (controller.modeClass). */
const jetShown = (c: DrillContext): boolean => c.preset !== 'oneThumb' || !c.stickJet;

/** A step's words for this layout: the fire step per fire mode (One-thumb: automatic), the jet step on JET when the stick doesn't jet. */
export function drillHow(s: Pick<DrillStep, 'id' | 'how'>, c: DrillContext): string {
  if (s.id === 'fire') return c.preset === 'oneThumb' ? 'Aim and fire are automatic: face a target and you shoot. Drag on the right half to aim yourself.' : FIRE_HOW[c.fire];
  if (s.id === 'jet' && jetShown(c)) return c.stickJet ? 'Hold Jet (or push the left stick up) to fly. The number is the fuel left: it refills on the ground.' : 'Hold Jet to fly. The number is the fuel left: it refills on the ground.';
  return s.how;
}

/** The control a step points at for this layout. */
export function drillControl(s: Pick<DrillStep, 'id' | 'control'>, c: DrillContext): ControlId | null {
  if (s.id === 'fire' && c.fire === 'button' && c.preset !== 'oneThumb') return 'fire';
  if (s.id === 'jet' && jetShown(c)) return 'jet';
  return s.control;
}

export const DRILL: readonly DrillStep[] = [
  { id: 'move', goal: 'Run', how: 'Push the left dial left or right.', control: 'move', done: ['move'] },
  { id: 'jet', goal: 'Fly', how: 'Push the left dial up to fly. The green arc is its fuel: it refills on the ground.', control: 'move', done: ['jet'] },
  { id: 'fire', goal: 'Aim and fire', how: FIRE_HOW.pull, control: 'aim', done: ['fire'] },
  { id: 'dash', goal: 'Dash', how: 'Swipe the dash button any way, or flick the left dial. Each dash costs fuel.', control: 'dash', done: ['dash'] },
  { id: 'chain', goal: 'Chain dashes', how: 'Dash again straight after a dash: the second goes faster.', control: 'dash', done: ['chain'] },
  { id: 'cycle', goal: 'Change grenade', how: 'Swipe ↑ on the grenade button.', control: 'grenade', done: ['cycle'] },
  { id: 'throw', goal: 'Aim a throw', how: 'Hold the grenade, drag to aim the arc, let go.', control: 'grenade', done: ['aimed-throw'] },
  { id: 'swap', goal: 'Swap guns', how: 'Tap or swipe the gun button.', control: 'swap', done: ['swap', 'radial'] },
  { id: 'radial', goal: 'Pick from quick-select', how: 'Hold the gun button, slide to melee, let go.', control: 'swap', done: ['radial'] },
  { id: 'reload', goal: 'Reload', how: 'When the magazine runs low, reload comes into the corner slot: tap it. (It reloads by itself when empty.)', control: 'reload', done: ['reload'] },
  { id: 'melee', goal: 'Strike', how: 'Close to an enemy, the blade comes into the corner slot: tap it. Or hold the gun button and slide to melee.', control: 'melee', done: ['melee', 'radial'] },
  { id: 'shield', goal: 'Guard', how: 'Carrying a shield, its button is in the corner slot: hold it to guard, let go to sling it.', control: 'shield', done: ['shield'], needs: 'shield' },
  { id: 'zoom', goal: 'Zoom', how: 'With a scoped gun, the magnifier is in the corner slot: tap it to see further.', control: 'zoom', done: ['zoom', 'pinch'], needs: 'zoom' },
  { id: 'take', goal: 'Take a gun', how: 'Guns lie on the map: stand on one and tap Take to swap it in.', control: 'take', done: ['take'] },
  { id: 'scores', goal: 'Scores', how: 'Hold the trophy to see the scoreboard.', control: 'scores', done: ['scores'] },
  { id: 'camera', goal: 'Zoom the view', how: 'Pinch with two fingers on one side. Two-finger double tap: recentre.', control: null, done: ['pinch', 'recentre'] },
];

/** What the player can do right now, for the steps that need it. */
export interface Can {
  shield: boolean;
  zoom: boolean;
}
const ALL: Can = { shield: true, zoom: true };

/** A run through the drill: where it is, what's ticked, what's skipped. */
export class Drill {
  private i = 0;
  readonly ticked = new Set<string>();
  readonly skipped = new Set<string>();
  /** the step just ticked off (the plate stamps it), cleared by the next change */
  justTicked: string | null = null;

  constructor(readonly steps: readonly DrillStep[] = DRILL) {}

  get step(): DrillStep | null {
    return this.steps[this.i] ?? null;
  }

  get index(): number {
    return this.i;
  }

  get finished(): boolean {
    return this.i >= this.steps.length;
  }

  /** An action: ticks the current step if it's the one; true when it did. */
  act(a: TouchAction, can: Can = ALL): boolean {
    this.autoSkip(can);
    const s = this.step;
    if (!s || !s.done.includes(a)) return false;
    this.ticked.add(s.id);
    this.justTicked = s.id;
    this.i++;
    this.autoSkip(can);
    return true;
  }

  skip(can: Can = ALL): void {
    const s = this.step;
    if (!s) return;
    this.skipped.add(s.id);
    this.justTicked = null;
    this.i++;
    this.autoSkip(can);
  }

  /** Steps that can't be done right now (no shield carried, no gun that zooms) pass by themselves. */
  autoSkip(can: Can): void {
    while (this.step?.needs && !can[this.step.needs]) {
      this.skipped.add(this.step.id);
      this.i++;
    }
  }
}

/** The drill was finished or closed on this phone (it no longer starts by itself in Training). */
export function drillSeen(store: KeyValueStore | null): boolean {
  try {
    return store?.getItem(DRILL_KEY) === 'done';
  } catch {
    return false;
  }
}

export function markDrillSeen(store: KeyValueStore | null, seen = true): void {
  try {
    if (seen) store?.setItem(DRILL_KEY, 'done');
    else store?.removeItem(DRILL_KEY);
  } catch {
    /* as for the hints */
  }
}

/** Two dashes within this long are a chain (the fluid dash's window is 0.35 s; a little slack for a thumb). */
export const CHAIN_MS = 600;
