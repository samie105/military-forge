/**
 * Names in the kit's icon sprite (sprite.ts) for game things, shared by the React screens (Icon.tsx)
 * and the DOM HUD (hud/): weapons by content id, keycap text for key codes and mouse buttons.
 */
import { keyLabel } from '../shell/controls';

/** A weapon's glyph in the sprite, by its content id (hammer44 → wpn-hammer). */
const WEAPON_ICONS: Readonly<Record<string, string>> = {
  hammer44: 'wpn-hammer',
  buzz: 'wpn-buzz',
  k47: 'wpn-k47',
  breacher: 'wpn-breacher',
  widow: 'wpn-widow',
  machete: 'wpn-machete',
};

/** The sprite id of a weapon's glyph, null when the kit has none for it. */
export function weaponIcon(id: string | undefined): string | null {
  return id ? (WEAPON_ICONS[id] ?? null) : null;
}

/** `<use href>` for a sprite id: 'shield' → '#icon-shield', 'wpn-hammer' → '#wpn-hammer'. */
export function iconHref(name: string): string {
  return name.startsWith('wpn-') || name.startsWith('icon-') ? `#${name}` : `#icon-${name}`;
}

/** Mouse buttons: the kit's glyph (if any) and the words on the keycap. */
export const MOUSE_CAPS: Readonly<Record<string, readonly [icon: string | null, text: string]>> = {
  Mouse0: ['mouse-l', 'Left'],
  Mouse2: ['mouse-r', 'Right'],
  Mouse1: ['wheel', 'Middle'],
  Mouse3: [null, 'Mouse 4'],
  Mouse4: [null, 'Mouse 5'],
};

/** The text a keycap shows for a binding (the player's keyboard layout where the browser tells it). */
export function capText(code: string, layout?: ReadonlyMap<string, string> | null): string {
  return MOUSE_CAPS[code]?.[1] ?? keyLabel(code, layout);
}
