/**
 * The W3C Gamepad API's "standard" layout (https://w3c.github.io/gamepad/#remapping): which index
 * is which button and stick, whatever the pad. Chrome, Edge, Safari (macOS and iOS) and Firefox give
 * DualSense, DualShock 4, Xbox and most recent pads this mapping; a pad without it (mapping '') is
 * read with the same indices, and Settings → Controls → Controller lets its owner rebind buttons.
 *
 * Also: which family a pad belongs to, from `Gamepad.id`, so prompts show its own buttons.
 */

/** Standard-mapping button indices (positions, not names: 0 is the bottom face button on every pad). */
export const B = {
  /** bottom face: Cross ✕ / A */
  South: 0,
  /** right face: Circle ○ / B */
  East: 1,
  /** left face: Square □ / X */
  West: 2,
  /** top face: Triangle △ / Y */
  North: 3,
  L1: 4,
  R1: 5,
  /** analog on most pads (`value` 0..1) */
  L2: 6,
  R2: 7,
  /** Create / Share / View / − */
  Select: 8,
  /** Options / Menu / + */
  Start: 9,
  L3: 10,
  R3: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
  /** the logo button (often taken by the browser or the OS) */
  Home: 16,
  /** DualSense / DualShock touchpad click, Xbox Share (where the browser reports a 17th button) */
  Extra: 17,
} as const;

/** How many buttons a binding can name (the standard 17 plus the extra one). */
export const BUTTON_COUNT = 18;

/** Standard-mapping axes: left stick x/y, right stick x/y (y is down-positive, as the API gives it). */
export const AXIS = { LX: 0, LY: 1, RX: 2, RY: 3 } as const;

export type PadFamily = 'playstation' | 'xbox' | 'nintendo' | 'generic';

/**
 * The family of a pad from its id string. Browsers differ ("DualSense Wireless Controller (STANDARD
 * GAMEPAD Vendor: 054c Product: 0ce6)" in Chrome, "054c-0ce6-DualSense Wireless Controller" in
 * Firefox, "Xbox Wireless Controller Extended Gamepad" in Safari), so both names and USB vendor ids count.
 */
export function padFamily(id: string): PadFamily {
  const s = id.toLowerCase();
  if (/dualsense|dualshock|playstation|054c/.test(s)) return 'playstation';
  if (/xbox|xinput|x-box|045e|microsoft/.test(s)) return 'xbox';
  if (/nintendo|switch|pro controller|joy-con|057e/.test(s)) return 'nintendo';
  return 'generic';
}

/** A DualSense (Create button) rather than a DualShock 4 (Share), where the id tells. */
export function isDualSense(id: string): boolean {
  return /dualsense|0ce6|0df2/i.test(id);
}
