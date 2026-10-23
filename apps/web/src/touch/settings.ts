/**
 * Touch settings and their storage: the small part the app loads up front (index.ts). The controls
 * table and the HUD layout live in layout.ts, which only the touch HUD chunk loads.
 */

import { isAssistLevel, type AssistLevel } from '../input/assist';

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * v3: Classic's essentials (the owner, 23 Oct: JET, grenade, swap, reload; dash off the HUD); a v2
 * layout's moves were made around a dash button that's gone, so they aren't carried over (nor v1's).
 */
export const LAYOUT_KEY = 'mf.touch.layout.v3';
export const SETTINGS_KEY = 'mf.touch.settings.v1';
/**
 * Saved with the settings: 2 = the round-two kit's controls (opacity 1 is its look); 3 = the four fire
 * modes; 4 = Button fade and Auto-fade (the owner, 23 Oct: an opacity of 1 saved before is the old
 * default, and loads as the new one).
 */
export const SETTINGS_REV = 5;

export const LIMITS = { min: 0.03, max: 0.97, sizeMin: 0.08, sizeMax: 0.7, opacityMin: 0.15, opacityMax: 1 };

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export type Handed = 'right' | 'left';
/**
 * How the gun fires on a phone (controls spec §4.4; the owner's "shooting styles", 23 Oct):
 * - auto: the aim stick aims; the gun fires by itself while the aim lies on an enemy in sight and in
 *   range (pushing the stick to the rim fires anyway). The default for new players.
 * - pull: the aim stick fires while pushed past its fire line (today's "hold").
 * - button: the aim stick only aims; a FIRE button fires while held (drag it to aim while firing).
 * - release: drag to aim, lift to fire once.
 */
export type FireMode = 'auto' | 'pull' | 'button' | 'release';
export const FIRE_MODES: readonly FireMode[] = ['auto', 'pull', 'button', 'release'];

/**
 * The touch layouts (controls spec §4.2; their places are layout.ts's PRESETS): Classic (two thumbs,
 * the default), Claw (index fingers on the top corners), One-thumb assist (one hand; aim and fire
 * automatic).
 */
export type PresetId = 'classic' | 'claw' | 'oneThumb';
export const PRESET_IDS: readonly PresetId[] = ['classic', 'claw', 'oneThumb'];
export const PRESET_NAMES: Readonly<Record<PresetId, string>> = { classic: 'Classic', claw: 'Claw', oneThumb: 'One-thumb assist' };
export const PRESET_HELP: Readonly<Record<PresetId, string>> = {
  classic: 'Two thumbs: move on the left, aim on the right, the buttons in an arc by your right thumb.',
  claw: 'Index fingers on the top corners: jet and dash on the left, fire and grenade on the right. Thumbs only move and aim.',
  oneThumb: 'One hand: aim and fire are automatic, with big dash, grenade and swap buttons. Drag on the right to aim yourself.',
};
const isPresetId = (v: unknown): v is PresetId => typeof v === 'string' && (PRESET_IDS as readonly string[]).includes(v);

/** What picking a preset sets besides its places (§4.2 "Preset rules"): the fire mode, stick-up jet, extra fingers firing. */
export const PRESET_SETTINGS: Readonly<Record<PresetId, Readonly<Partial<TouchSettings>>>> = {
  classic: { stickJet: true, tapFire: false },
  // the left FIRE would sit on JET
  claw: { fire: 'button', fireChosen: true, stickJet: false, tapFire: true, leftFire: false },
  oneThumb: { fire: 'auto', fireChosen: true, stickJet: true, tapFire: false },
};

/** The touch aim assist levels, as Settings, the pause menu's editor and the drill name them. */
export const ASSIST_NAMES: Readonly<Record<AssistLevel, string>> = { off: 'Off', light: 'Light', standard: 'Standard', strong: 'Strong' };
/** What each level does, in the player's words (controls spec §4.5). */
export const ASSIST_HELP: Readonly<Record<AssistLevel, string>> = {
  off: 'No help: the aim goes exactly where your thumb points.',
  light: 'The aim slows a little on an enemy, so a sweep lingers on him. It never pulls.',
  standard: 'Light, plus a gentle pull toward an enemy near your aim line while you aim, or while Auto fires. Your thumb always wins.',
  strong: 'Standard, plus the aim stays on your target when you lift your thumb.',
};

/** Back to the default layout on this device. */
export function clearLayout(store: KeyValueStore | null): void {
  try {
    store?.removeItem(LAYOUT_KEY);
  } catch {
    /* nothing saved, nothing to clear */
  }
}

/** Another preset picked before the HUD loaded: the moves saved on the old one go, the pins stay (layout.ts withoutMoves, on storage). */
export function clearMoves(store: KeyValueStore | null): void {
  try {
    const raw = JSON.parse(store?.getItem(LAYOUT_KEY) ?? 'null') as { pinned?: unknown } | null;
    if (!raw || typeof raw !== 'object') return;
    store?.setItem(LAYOUT_KEY, JSON.stringify(Array.isArray(raw.pinned) && raw.pinned.length ? { placements: {}, pinned: raw.pinned } : { placements: {} }));
  } catch {
    /* nothing saved, nothing to clear */
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type TouchMode = 'auto' | 'on' | 'off';

export interface TouchSettings {
  /** auto: on phones and tablets (a coarse pointer), or as soon as the screen is touched */
  mode: TouchMode;
  /** how the gun fires (FireMode) */
  fire: FireMode;
  /** the fire mode was picked (the first-run chooser, or Settings): until then the chooser shows once */
  fireChosen: boolean;
  /** snipers, DMRs, charged guns and launchers fire on release in Auto and Pull (§4.4's per-weapon rule) */
  precisionRelease: boolean;
  /** Fire button mode: a second FIRE at the top left, for the left index finger */
  leftFire: boolean;
  /**
   * Touch aim assist (controls spec §4.5; the shared core in input/assist.ts): Off; Light (the old
   * switch: the aim slows on an enemy); Standard (plus a gentle pull while you aim, or while Auto
   * fires); Strong (plus the aim stays on the target when you let go). Touch and pads only.
   */
  assist: AssistLevel;
  handed: Handed;
  /** buzz when you're hit (where the browser allows vibration) */
  vibrate: boolean;
  /** flick and lift the move stick to dash */
  swipeDash: boolean;
  /** the layout the controls start from (PresetId); the player's moves are the layout's placements */
  preset: PresetId;
  /** push the move stick up to jet (Claw turns it off: the left index finger has JET) */
  stickJet: boolean;
  /** an extra finger on empty aim-side space fires while it's down (Claw's "tap anywhere to fire") */
  tapFire: boolean;
  /** back on the aim stick within 0.7 s of a button: the same aim and push carry on (and Pull keeps firing) */
  keepAim: boolean;
  /**
   * Button fade (the owner, 23 Oct): how far the controls' plates fade, 0.15–1 (each control's own
   * opacity multiplies it). With Auto-fade they sit at this level only while idle, and light up to full
   * under a thumb; without, always. The vitals they carry (HP, fuel, the ammo ring, counts) never fade.
   */
  opacity: number;
  /** Auto-fade: controls left alone for AUTO_FADE_MS ease down to the Button fade level; a thumb on or near one lights it up */
  autoFade: boolean;
  /** swipes and holds on the buttons (touch-controls-v3.md); off: every button is a plain tap, as before */
  gestures: boolean;
  /** short buzzes on a throw, a swap, a dash swipe, a radial pick (where the phone can vibrate) */
  haptics: boolean;
  /** the view leans toward where you aim; off: it stays on your soldier */
  lookAhead: boolean;
  /** two fingers on one side pinch the view's zoom; a two-finger double tap recentres */
  pinchZoom: boolean;
  /** how hard blasts and recoil shake the 3D view, 0–1 */
  shake: number;
  /** how much of the game's view a phone shows, 0.5–1 (Camera.viewScale), once the player chose it (a pinch, the slider) */
  view: number;
  /**
   * The view sized to the screen (autoView): as wide as the game's view where soldiers stay readable
   * (the owner, 23 Oct: "the zoom for mobile is too close"). A pinch or the slider turns it off; a
   * two-finger double tap turns it back on.
   */
  viewAuto: boolean;
}

export const DEFAULT_TOUCH_SETTINGS: Readonly<TouchSettings> = {
  mode: 'auto',
  fire: 'auto',
  fireChosen: false,
  precisionRelease: true,
  leftFire: false,
  assist: 'standard',
  handed: 'right',
  vibrate: true,
  swipeDash: true,
  preset: 'classic',
  stickJet: true,
  tapFire: false,
  keepAim: true,
  opacity: 0.5,
  autoFade: true,
  gestures: true,
  haptics: true,
  lookAhead: true,
  pinchZoom: true,
  shake: 1,
  view: 0.8,
  viewAuto: true,
};

/** A phone's view: 0.70–1 of the game's (pinch and slider; the mobile audit: never closer than 0.70). */
export const VIEW_LIMITS = { min: 0.7, max: 1 } as const;

/**
 * The auto view: pixels per metre a phone keeps (a 1.5 m soldier about 41 px, about 7.5 mm on the glass:
 * the mobile audit's number), and the closest it goes (0.70: a 780 px Galaxy S23 gets 0.80, a 915 px
 * one 0.94). At the game's full view (1) a 36 m slice is as
 * wide as a laptop shows; a phone is shorter, so it sees less height (about 4/5 of a laptop's).
 */
export const AUTO_VIEW = { pxPerMetre: 27, min: 0.7, baseWidth: 36 } as const;

/** The view a phone's play area `width` px wide gets automatically: as wide as readable soldiers allow. */
export function autoView(width: number): number {
  return Math.round(clamp(width / (AUTO_VIEW.pxPerMetre * AUTO_VIEW.baseWidth), AUTO_VIEW.min, VIEW_LIMITS.max) * 100) / 100;
}

/**
 * Round one's default opacity (its flat controls were opaque): a save carrying it, from before the
 * kit's translucent thumb dials, means "the default", so it loads as the new one.
 */
const ROUND_ONE_OPACITY = 0.55;

export function sanitizeSettings(raw: unknown): TouchSettings {
  const s = { ...DEFAULT_TOUCH_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return s;
  const r = raw as Record<string, unknown>;
  if (r.mode === 'auto' || r.mode === 'on' || r.mode === 'off') s.mode = r.mode;
  // 'hold' was Pull's old name; the old auto-fire switch on top of it is Auto now
  if (r.fire === 'hold') s.fire = r.autoFire === true ? 'auto' : 'pull';
  else if (typeof r.fire === 'string' && (FIRE_MODES as readonly string[]).includes(r.fire)) s.fire = r.fire as FireMode;
  if (r.handed === 'right' || r.handed === 'left') s.handed = r.handed;
  if (isPresetId(r.preset)) s.preset = r.preset;
  for (const k of ['viewAuto', 'vibrate', 'swipeDash', 'stickJet', 'tapFire', 'keepAim', 'gestures', 'haptics', 'lookAhead', 'pinchZoom', 'fireChosen', 'precisionRelease', 'leftFire', 'autoFade'] as const) if (typeof r[k] === 'boolean') s[k] = r[k];
  // the old switch: off stays off; on (the default everyone had) is the new default, Standard
  if (isAssistLevel(r.assist)) s.assist = r.assist;
  else if (r.aimAssist === false) s.assist = 'off';
  if (isFiniteNumber(r.opacity)) s.opacity = clamp(r.opacity, LIMITS.opacityMin, LIMITS.opacityMax);
  if (isFiniteNumber(r.shake)) s.shake = clamp(r.shake, 0, 1);
  if (isFiniteNumber(r.view)) s.view = clamp(r.view, VIEW_LIMITS.min, VIEW_LIMITS.max);
  return s;
}

export function loadSettings(store: KeyValueStore | null): TouchSettings {
  try {
    const raw = JSON.parse(store?.getItem(SETTINGS_KEY) ?? 'null') as Record<string, unknown> | null;
    const s = sanitizeSettings(raw);
    if (raw && raw.rev === undefined && raw.opacity === ROUND_ONE_OPACITY) s.opacity = DEFAULT_TOUCH_SETTINGS.opacity;
    // before Button fade, 1 was the default everyone had: the new default fades the idle controls
    if (raw && (typeof raw.rev !== 'number' || raw.rev < 4) && raw.opacity === 1) s.opacity = DEFAULT_TOUCH_SETTINGS.opacity;
    // before the auto view, 0.62 was the default everyone had (not a choice): auto it is
    if (raw && (typeof raw.rev !== 'number' || raw.rev < 5) && (raw.view === undefined || raw.view === 0.62)) s.viewAuto = true;
    else if (raw && (typeof raw.rev !== 'number' || raw.rev < 5)) s.viewAuto = false;
    return s;
  } catch {
    return { ...DEFAULT_TOUCH_SETTINGS };
  }
}

export function saveSettings(store: KeyValueStore | null, settings: TouchSettings): void {
  try {
    store?.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, rev: SETTINGS_REV }));
  } catch {
    /* as for the layout */
  }
}
