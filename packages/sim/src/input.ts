/** Button bits (docs/05 §6.1). */
export const Btn = {
  Left: 1 << 0,
  Right: 1 << 1,
  Jet: 1 << 2,
  Down: 1 << 3,
  Fire: 1 << 4,
  Fire2: 1 << 5,
  Reload: 1 << 6,
  Swap: 1 << 7,
  Grenade: 1 << 8,
  Melee: 1 << 9,
  Interact: 1 << 10,
  Dual: 1 << 11,
  CycleGrenade: 1 << 12,
  Repeat: 1 << 15,
} as const;

/**
 * One tick of player intent. This is the ONLY thing a client sends; the server simulates
 * everything else (docs/10 §2).
 */
export interface Input {
  buttons: number;
  /** aim angle as u16 (0..65535 ↔ 0..2π) */
  aim: number;
  /** 0 = no change, 1..7 = slot */
  weaponSelect: number;
  /** grenade throw strength 0..7 */
  throwStrength: number;
}

export function createInput(): Input {
  return { buttons: 0, aim: 0, weaponSelect: 0, throwStrength: 7 };
}

export function copyInput(dst: Input, src: Readonly<Input>): Input {
  dst.buttons = src.buttons;
  dst.aim = src.aim;
  dst.weaponSelect = src.weaponSelect;
  dst.throwStrength = src.throwStrength;
  return dst;
}

export function isDown(buttons: number, btn: number): boolean {
  return (buttons & btn) !== 0;
}

/** Edge-triggered press, derived from consecutive ticks so it replays correctly. */
export function wasPressed(buttons: number, prevButtons: number, btn: number): boolean {
  return (buttons & btn) !== 0 && (prevButtons & btn) === 0;
}
