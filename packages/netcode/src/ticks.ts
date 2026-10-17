/** Ticks travel as 16-bit wrapping values (docs/05 §6); everything else uses full tick numbers. */

/** The full tick nearest to `reference` whose low 16 bits are `wrapped`. Valid while |Δ| < 32 768. */
export function unwrapTick(wrapped: number, reference: number): number {
  const delta = (((wrapped - reference) & 0xffff) << 16) >> 16; // sign-extend the 16-bit difference
  return reference + delta;
}

export const TICK_MS = 1000 / 60;
