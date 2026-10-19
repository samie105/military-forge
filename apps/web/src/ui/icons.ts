/**
 * Names in the kit's icon sprite (sprite.ts) for game things, shared by the React screens (Icon.tsx)
 * and the DOM HUD (hud/): weapons by content id, keycap text for key codes and mouse buttons.
 */
import { currentDevice, currentPadFamily } from '../gamepad/device';
import { isPadCode, padLabel } from '../gamepad/glyphs';
import { keyLabel } from '../shell/controls';
import { SPRITE_IDS } from './sprite';

/**
 * A weapon's glyph in the sprite (icon-wpn-*), by its content id: the same name, but for the two
 * whose ids carry a calibre (hammer44 → wpn-hammer, hawk50 → wpn-hawk).
 */
const WEAPON_ICON_NAMES: Readonly<Record<string, string>> = { hammer44: 'hammer', hawk50: 'hawk' };

/** The sprite id of a weapon's glyph ('wpn-k47'), null when the kit has none for it. */
export function weaponIcon(id: string | undefined): string | null {
  if (!id) return null;
  const name = `wpn-${WEAPON_ICON_NAMES[id] ?? id}`;
  return SPRITE_IDS.includes(`icon-${name}`) ? name : null;
}

/** `<use href>` for a sprite id: 'shield' → '#icon-shield', 'wpn-hammer' → '#icon-wpn-hammer'. */
export function iconHref(name: string): string {
  return name.startsWith('icon-') ? `#${name}` : `#icon-${name}`;
}

/** Mouse buttons: the kit's glyph (round two draws none: words only) and the words on the keycap. */
export const MOUSE_CAPS: Readonly<Record<string, readonly [icon: string | null, text: string]>> = {
  Mouse0: [null, 'Left'],
  Mouse2: [null, 'Right'],
  Mouse1: [null, 'Middle'],
  Mouse3: [null, 'Mouse 4'],
  Mouse4: [null, 'Mouse 5'],
};

/** The text a keycap shows for a binding (the player's keyboard layout where the browser tells it). */
export function capText(code: string, layout?: ReadonlyMap<string, string> | null): string {
  // a controller's button ('Pad3' → "△" or "Y"), in the family the prompts use now (gamepad/)
  if (isPadCode(code)) return padLabel(code, currentPadFamily(), { short: true, dualSense: currentDevice().dualSense });
  return MOUSE_CAPS[code]?.[1] ?? keyLabel(code, layout);
}
