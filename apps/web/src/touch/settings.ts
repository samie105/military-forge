/**
 * Touch settings and their storage: the small part the app loads up front (index.ts). The controls
 * table and the HUD layout live in layout.ts, which only the touch HUD chunk loads.
 */

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const LAYOUT_KEY = 'mf.touch.layout.v1';
export const SETTINGS_KEY = 'mf.touch.settings.v1';
/** Saved with the settings: 2 = the round-two kit's controls (opacity 1 is its look). */
export const SETTINGS_REV = 2;

export const LIMITS = { min: 0.03, max: 0.97, sizeMin: 0.08, sizeMax: 0.7, opacityMin: 0.15, opacityMax: 1 };

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export type Handed = 'right' | 'left';
export type FireMode = 'hold' | 'release';

/** Back to the default layout on this device. */
export function clearLayout(store: KeyValueStore | null): void {
  try {
    store?.removeItem(LAYOUT_KEY);
  } catch {
    /* nothing saved, nothing to clear */
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type TouchMode = 'auto' | 'on' | 'off';

export interface TouchSettings {
  /** auto: on phones and tablets (a coarse pointer), or as soon as the screen is touched */
  mode: TouchMode;
  /** hold: fire while the aim stick is pushed past half-way; release: aim, then lift to fire once */
  fire: FireMode;
  /** a light slowdown while the aim lies on an enemy (docs/01 §4); touch only */
  aimAssist: boolean;
  handed: Handed;
  /** buzz when you're hit (where the browser allows vibration) */
  vibrate: boolean;
  /** swipe and lift the move stick to dash */
  swipeDash: boolean;
  /**
   * overall opacity of the controls' plates (each control's own opacity multiplies it); the vitals they
   * carry (HP, fuel, the ammo ring) stay readable whatever it is. 1 = the kit's look, already translucent
   */
  opacity: number;
  /** swipes and holds on the buttons (touch-controls-v3.md); off: every button is a plain tap, as before */
  gestures: boolean;
  /** fire by itself while the aim lies on an enemy in range (an accessibility option) */
  autoFire: boolean;
  /** short buzzes on a throw, a swap, a dash swipe, a radial pick (where the phone can vibrate) */
  haptics: boolean;
  /** the view leans toward where you aim; off: it stays on your soldier */
  lookAhead: boolean;
  /** two fingers on one side pinch the view's zoom; a two-finger double tap recentres */
  pinchZoom: boolean;
  /** how hard blasts and recoil shake the 3D view, 0–1 */
  shake: number;
  /** how much of the game's view a phone shows, 0.5–1 (Camera.viewScale): closer by default, so soldiers read; a pinch sets it */
  view: number;
}

export const DEFAULT_TOUCH_SETTINGS: Readonly<TouchSettings> = {
  mode: 'auto',
  fire: 'hold',
  aimAssist: true,
  handed: 'right',
  vibrate: true,
  swipeDash: true,
  opacity: 1,
  gestures: true,
  autoFire: false,
  haptics: true,
  lookAhead: true,
  pinchZoom: true,
  shake: 1,
  view: 0.62,
};

export const VIEW_LIMITS = { min: 0.5, max: 1 } as const;

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
  if (r.fire === 'hold' || r.fire === 'release') s.fire = r.fire;
  if (r.handed === 'right' || r.handed === 'left') s.handed = r.handed;
  for (const k of ['aimAssist', 'vibrate', 'swipeDash', 'gestures', 'autoFire', 'haptics', 'lookAhead', 'pinchZoom'] as const) if (typeof r[k] === 'boolean') s[k] = r[k];
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
