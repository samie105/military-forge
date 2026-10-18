/**
 * Rotation (docs/14 §4.4): deterministic from the synced match clock, so every player in a match
 * sees the same frame at the same moment and the server can compute it too. One beat per map:
 * every Screen changes on the same 10 s beat, crossfading for 0.5 s, never a hard cut.
 */
import type { AdSlot } from './manifest';

export const DWELL_MS = 10_000;
export const CROSSFADE_MS = 500;
/** the sim's tick rate (packages/sim DT = 1/60) */
export const TICK_MS = 1000 / 60;

/** frameIndex(slot, t) = (⌊t / dwellMs⌋ + phaseIdx) mod frames */
export function frameIndex(slot: Pick<AdSlot, 'frames' | 'dwellMs' | 'phaseIdx'>, matchTimeMs: number): number {
  const n = Math.max(1, slot.frames);
  const beat = Math.floor(matchTimeMs / slot.dwellMs) + slot.phaseIdx;
  return ((beat % n) + n) % n;
}

/** 0 at a beat, 1 once the crossfade into the new frame is done (CROSSFADE_MS later). */
export function crossfade(matchTimeMs: number, dwellMs = DWELL_MS, fadeMs = CROSSFADE_MS): number {
  const into = ((matchTimeMs % dwellMs) + dwellMs) % dwellMs;
  return Math.min(1, into / fadeMs);
}

/** The frame shown before the current one (what the crossfade fades from). */
export function previousFrame(slot: Pick<AdSlot, 'frames' | 'dwellMs' | 'phaseIdx'>, matchTimeMs: number): number {
  return frameIndex(slot, matchTimeMs - slot.dwellMs);
}
