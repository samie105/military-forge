/**
 * Renders a sound's variant to samples: seeded by its id and variant (the same every time),
 * cleaned of anything non-finite and normalised to the sound's peak (sounds/render.ts).
 */
import { SOUNDS, type SoundId } from './sounds';
import { BANK_RATE, renderDef, trimTail } from './sounds/render';

export { BANK_RATE, trimTail };

export const variantsOf = (id: SoundId): number => Math.max(1, SOUNDS[id].variants ?? 1);

/** One variant of a sound as channels of samples (mono: one channel). */
export function renderSound(id: SoundId, variant = 0, sr = BANK_RATE): Float32Array[] {
  return renderDef(id, SOUNDS[id], variant, sr);
}
