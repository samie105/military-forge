/**
 * Touch settings and their storage: the small part the app loads up front (index.ts). The controls
 * table and the HUD layout live in layout.ts, which only the touch HUD chunk loads.
 */

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const LAYOUT_KEY = 'mf.touch.layout.v1';
export const SETTINGS_KEY = 'mf.touch.settings.v1';

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
  /** overall opacity of the controls (each control's own opacity multiplies it) */
  opacity: number;
}

export const DEFAULT_TOUCH_SETTINGS: Readonly<TouchSettings> = {
  mode: 'auto',
  fire: 'hold',
  aimAssist: true,
  handed: 'right',
  vibrate: true,
  swipeDash: true,
  opacity: 0.55,
};

export function sanitizeSettings(raw: unknown): TouchSettings {
  const s = { ...DEFAULT_TOUCH_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return s;
  const r = raw as Record<string, unknown>;
  if (r.mode === 'auto' || r.mode === 'on' || r.mode === 'off') s.mode = r.mode;
  if (r.fire === 'hold' || r.fire === 'release') s.fire = r.fire;
  if (r.handed === 'right' || r.handed === 'left') s.handed = r.handed;
  for (const k of ['aimAssist', 'vibrate', 'swipeDash'] as const) if (typeof r[k] === 'boolean') s[k] = r[k];
  if (isFiniteNumber(r.opacity)) s.opacity = clamp(r.opacity, LIMITS.opacityMin, LIMITS.opacityMax);
  return s;
}

export function loadSettings(store: KeyValueStore | null): TouchSettings {
  try {
    return sanitizeSettings(JSON.parse(store?.getItem(SETTINGS_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_TOUCH_SETTINGS };
  }
}

export function saveSettings(store: KeyValueStore | null, settings: TouchSettings): void {
  try {
    store?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* as for the layout */
  }
}
