/** What a sound is: how it's made (render) and how the engine plays it (the rest). */
import type { Rng } from '../dsp';

/**
 * Where a sound plays. `sfx` is the world (ducked under big blasts and muffled by a flashbang),
 * `big` is the world's blasts themselves (not ducked; softened by "Soften loud bursts"); both
 * follow the Effects volume. `ui`, `voice` and `music` have their own volumes.
 */
export type Bus = 'sfx' | 'big' | 'ui' | 'voice' | 'music';

/** What a recipe gets: the sample rate, a seeded random source, and which variant it's making. */
export interface RenderCtx {
  sr: number;
  rng: Rng;
  v: number;
}

/** Mono, or [left, right]. */
export type Rendered = Float32Array | [Float32Array, Float32Array];

export interface SoundDef {
  /** shown on the sound board */
  label: string;
  /** the board's section */
  group: string;
  bus: Bus;
  render(ctx: RenderCtx): Rendered;
  /** different takes rendered from different seeds (one is picked at random each play); default 1 */
  variants?: number;
  /** mix level 0…1 after the render is normalised to its peak; default 1 */
  gain?: number;
  /** peak the render is normalised to; default 0.9 */
  peak?: number;
  /** at most this many playing at once (the oldest is cut); default 4 */
  maxVoices?: number;
  /** the same sound can't start again within this many seconds; default 0.02 */
  cooldown?: number;
  /** who wins when the engine runs out of voices: higher stays; default 50 */
  priority?: number;
  /** a loop: plays until stopped (jetpack, flames, hiss) */
  loop?: boolean;
  /** metres beyond which a world sound isn't played at all; default 50 */
  range?: number;
  /** "Soften loud bursts": its gain is multiplied by this (default 1) */
  soft?: number;
  /** how much it sends into the world's space (convolution reverb), before distance; default 0.22 (loops 0.1) */
  wet?: number;
  /** its far layer (a sound id): past `farFrom` m it's layered in, taking over by `farTo` (defaults 25, 70) */
  far?: string;
  farFrom?: number;
  farTo?: number;
  /** ± playback-rate jitter per play (default 0.03; 0 for musical sounds) */
  pitchJitter?: number;
  /**
   * The render is final: levelled and cut already (a skin's sound, matched to its base sound's loudness
   * and length: sounds/skins.ts), so the bank neither normalises its peak nor trims its tail.
   */
  asRendered?: boolean;
}
